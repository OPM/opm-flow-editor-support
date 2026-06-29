// ---------------------------------------------------------------------------
// Pure analysis helpers shared by the diagnostics provider.
// Kept free of vscode imports so they can be unit-tested under jest.
// ---------------------------------------------------------------------------

import {
  tokenizeLine,
  isCommentLine,
  KEYWORD_LINE_RE,
  KEYWORD_LINE_LOOSE_RE,
  SECTION_KEYWORD_SET,
  matchSectionLine,
} from './formatting';
import { DIAGNOSTICS_EXCLUDED_KEYWORDS } from './diagnostics-exclusions';

/** Record-arity classification carried over from opm-common's "size" field. */
export type SizeKind = 'none' | 'fixed' | 'list' | 'array';

/**
 * Per-record metadata for multi-record keywords (WELSEGS, VFPPROD,
 * COMPSEGS, ACTIONX, …). Each entry corresponds to one record in
 * deck order: records 1..N-1 are single-row, record N is variadic
 * and absorbs all remaining record lines until the block-terminating
 * standalone '/'.
 */
export interface RecordMeta {
  expected_columns?: number;
}

/**
 * Per-parameter shape consumed by the positional type-check. Mirrors the
 * subset of the compact-index parameter object the diagnostics engine needs;
 * the full object (description, units, default, …) is ignored here.
 */
export interface AnalysisParam {
  /** 1-based record position, or a grouped string ("3-52") for variadic
   *  ranges. Only integer positions are type-checked. */
  index: number | string;
  name?: string;
  /** opm-common value type: INT | DOUBLE | STRING | RAW_STRING | UDA. */
  value_type?: string;
  /** Enum values for STRING parameters extracted from the manual. */
  options?: string[];
  /** 1-based record number for multi-record keywords. */
  record?: number;
}

export interface AnalysisEntry {
  name: string;
  expected_columns?: number;
  records_meta?: RecordMeta[];
  /** Per-parameter metadata used by the positional type-check. */
  parameters?: AnalysisParam[];
  /** Authoritative section list (from opm-common when available). */
  sections?: string[];
  /**
   * Record-arity kind:
   *   - 'none': the keyword takes no records and no terminating '/'.
   *   - 'fixed': a fixed number of records, each terminated by '/'.
   *   - 'list': an unbounded record list. Each record ends with '/' and
   *     the keyword block itself ends with a standalone '/' line.
   *   - 'array': a cell-property array (opm-common "data" shape). One
   *     stream of values across many lines, terminated by a single '/'.
   *     No per-record '/' and no separate list terminator — terminator
   *     and arity checks must be skipped for these.
   */
  size_kind?: SizeKind;
  /** For `size_kind: 'fixed'`, the number of records the keyword expects. */
  size_count?: number;
  /**
   * True when the entry is a SUMMARY-section *template*: users append a
   * tracer/component name to form the actual deck keyword (e.g. ``FTPR``
   * is templated; the deck writes ``FTPRSEA`` for the SEA tracer). The
   * diagnostics engine treats any ``<template><suffix>`` token whose
   * suffix is ``[A-Z0-9]+`` as recognised, with this entry's shape.
   */
  templated?: boolean;
  /**
   * True when at least one item has ``size_type: "ALL"`` (RSVD, RVVD,
   * PVDO, PVTO, …). Records can span multiple lines and only the line
   * carrying '/' completes a record; intermediate lines without '/'
   * must not trigger a missing-terminator diagnostic.
   */
  variadic_record?: boolean;
  /**
   * True when the keyword's record body is optional — i.e. the bare
   * keyword on a line by itself (no values, no '/') is a valid usage.
   * Used by non-F SUMMARY mnemonics that may either list names or be
   * written bare to mean "all", and that can be stacked back-to-back
   * with no intervening '/':
   *
   *     GMWPR
   *     GMWIN
   *     /
   *
   * When ``recordCount === 0`` the close-block terminator check is
   * skipped; once any value tokens appear, the usual array/list rules
   * apply so a forgotten closing '/' still gets flagged.
   */
  optional_body?: boolean;
  /**
   * Keywords that must also appear in the deck when this one is used
   * (opm-common ``requires``). Drives the "X requires Y" diagnostic. The
   * check is document-wide and is suppressed when the deck pulls in other
   * files via INCLUDE/IMPORT/GDFILE, since the required keyword may live there.
   */
  requires?: string[];
  /**
   * Keywords that may not co-exist with this one (opm-common ``prohibits``).
   * Drives the "X conflicts with Y" diagnostic when both are present.
   */
  prohibits?: string[];
}

export type AnalysisIndex = Record<string, AnalysisEntry>;

/** Stable identifier for diagnostics that have an unambiguous quick fix.
 *  Diagnostics without a fix leave this undefined. */
export type DiagnosticCode =
  | 'lowercase-keyword'
  | 'indented-keyword'
  | 'missing-record-terminator'
  | 'missing-list-terminator'
  | 'missing-array-terminator'
  | 'unknown-keyword';

export interface LineDiagnostic {
  /** Zero-based document line. */
  line: number;
  /** Zero-based char range to underline. */
  startChar: number;
  endChar: number;
  /** Human-readable message ready for VS Code. */
  message: string;
  /** Set when a one-click quick fix is available for this diagnostic. */
  code?: DiagnosticCode;
  /** For `unknown-keyword`: the nearest known keyword to offer as a
   *  replacement, when one is close enough. */
  suggestion?: string;
}

/** Levenshtein edit distance, capped early once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  let curr = new Array<number>(lb + 1);
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

/** The recognised keyword closest to `kw` (typo candidate), or undefined when
 *  nothing is within a small edit distance. Searches the index plus the
 *  section keywords. */
function nearestKeyword(
  kw: string,
  index: AnalysisIndex,
  sectionKeywords: ReadonlySet<string>,
): string | undefined {
  // Allow more slack for longer names; never more than 2 edits.
  const max = kw.length >= 6 ? 2 : 1;
  let best: string | undefined;
  let bestDist = max + 1;
  const consider = (cand: string) => {
    if (cand === kw) return;
    const d = editDistance(kw, cand, max);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  };
  for (const cand of sectionKeywords) consider(cand);
  for (const cand of Object.keys(index)) consider(cand);
  return bestDist <= max ? best : undefined;
}

/** True when the line, after leading whitespace, is just '/' (optionally
 *  followed by trailing text — either a '--' comment or any free-form text,
 *  which OPM Flow likewise treats as a comment). Such a line acts as the
 *  list terminator for a record-list keyword. */
function isStandaloneTerminator(line: string): boolean {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i >= line.length || line[i] !== '/') return false;
  return true;
}

/** True when the active keyword's record block has not yet been closed and
 *  is still expecting more record content. Used to decide whether a line
 *  matching `KEYWORD_LINE_RE` (a single uppercase identifier) should be
 *  treated as a continuation record (likely an unquoted string value)
 *  rather than the start of a new keyword. */
function expectsMoreRecords(
  entry: AnalysisEntry,
  recordCount: number,
  listTerminatorSeen: boolean,
  arrayTerminatorSeen: boolean,
): boolean {
  if (entry.size_kind === 'list') return !listTerminatorSeen;
  if (entry.size_kind === 'array') return !arrayTerminatorSeen;
  if (entry.size_kind === 'fixed') {
    // opm-common sometimes classifies a keyword as `fixed` without resolving a
    // concrete record count (e.g. EOS, whose count derives from another
    // keyword). When the count is unknown but the keyword does take a record
    // (it has a per-record column count), assume it expects at least one — so a
    // single value record on the next line (`EOS` <nl> `PR /`) is absorbed
    // rather than mistaken for a new keyword.
    const expected =
      entry.records_meta?.length
      ?? entry.size_count
      ?? (entry.expected_columns ? 1 : 0);
    return recordCount < expected;
  }
  return false;
}

/** Tracer/component name suffix following a templated mnemonic prefix.
 *  Restricted to uppercase letters and digits so we don't accidentally
 *  match unrelated tokens. */
const TEMPLATE_SUFFIX_RE = /^[A-Z0-9]+$/;

/**
 * User-defined quantity (UDQ) name. OPM Flow requires a UDQ name to begin with
 * the data-type letter (one of A B C F G R S W) followed by the letter ``U``
 * (e.g. ``WUOPRL``, ``FU_VAR1``, ``WU_WBHP``). Such names are user-defined, so
 * they can never appear in the keyword index, yet they show up legitimately as
 * bare SUMMARY mnemonics and inside ACTIONX/UDQ bodies. We recognise them by
 * shape so the unknown-keyword diagnostic doesn't flag them as typos.
 */
const UDQ_NAME_RE = /^[ABCFGRSW]U[A-Z0-9_]+$/;

/**
 * Control words that introduce a statement inside a `UDQ` block. Every record
 * in a UDQ block must begin with one of these (see the OPM Flow manual `UDQ`
 * keyword): `ASSIGN` a constant, `DEFINE` a formula, set the display `UNITS`,
 * or `UPDATE` the evaluation state.
 */
const UDQ_CONTROL_WORDS = new Set(['ASSIGN', 'DEFINE', 'UNITS', 'UPDATE']);

/**
 * Keywords whose "record" is a single line of free-form text on the line after
 * the keyword name, with no '/' terminator (mirrors the build script's
 * ``RAW_TEXT_KEYWORDS``). The body text is arbitrary and frequently happens to
 * be an upper-case token that collides with a real keyword name — e.g.
 * ``TITLE`` followed by ``CO2STORE`` or ``ACTIONX_GCONPROD``. Without special
 * handling that body line is mis-parsed as a keyword (flagged "indented" or
 * "not recognised"), so the line immediately following one of these keywords is
 * consumed verbatim and never analysed.
 */
const RAW_TEXT_BODY_KEYWORDS = new Set(['TITLE']);

/**
 * Report keywords whose record body is a free-form list of output mnemonics
 * terminated by a standalone '/'. Many of those mnemonics are spelled exactly
 * like real keywords (PRESSURE, SGAS, SOIL, XMF, …) and sit in column 1, so the
 * generic keyword scanner would otherwise close the report block early and flag
 * each mnemonic as a wrong-section / unterminated keyword. While one of these is
 * the active block, every column-1 token is treated as body content; a section
 * header (checked earlier) still ends the block.
 */
const FREEFORM_MNEMONIC_KEYWORDS = new Set([
  'RPTRST', 'RPTSCHED', 'RPTSOL', 'RPTGRID', 'RPTPROPS', 'RPTREGS',
  'RPTEDIT', 'RPTRUN',
]);

/**
 * Region summary vector qualified by a named FIP region set, e.g. ``ROIP_ABC``
 * (= base vector ``ROIP`` over region set ``ABC``) or ``RPR__ABC``. The base is
 * a region vector (``R``-prefixed) that exists in the index; the ``_<NAME>``
 * qualifier is user-defined so the full token never appears in the index.
 */
function isRegionSetVector(index: AnalysisIndex, kw: string): boolean {
  const us = kw.indexOf('_');
  if (us <= 0) return false;
  const base = kw.slice(0, us);
  if (base[0] !== 'R') return false;
  return index[base] !== undefined;
}

/** True when `base` is an indexed keyword valid in the SUMMARY section. */
function isSummaryBase(index: AnalysisIndex, base: string): boolean {
  const e = index[base];
  return !!e && Array.isArray(e.sections) && e.sections.includes('SUMMARY');
}

/**
 * Summary vector formed by a standard modifier on a base vector that is itself
 * an indexed SUMMARY vector:
 *   - trailing 'L' — completion/connection-level variant (WOPRL = WOPR + L,
 *     COPRL = COPR + L);
 *   - leading 'L' — LGR-local variant (LWWIR = L + WWIR, LBOSAT = L + BOSAT).
 * Requiring the stripped base to be a real SUMMARY vector keeps this from
 * masking genuine typos, while covering the open-ended L-modifier families that
 * opm-common does not enumerate.
 */
function isSummaryModifierVector(index: AnalysisIndex, kw: string): boolean {
  if (kw.length < 4) return false;
  if (kw.endsWith('L') && isSummaryBase(index, kw.slice(0, -1))) return true;
  if (kw.startsWith('L') && isSummaryBase(index, kw.slice(1))) return true;
  return false;
}

/**
 * True when `kw` is a recognised SUMMARY vector by *shape* rather than by an
 * explicit index entry: a user-defined quantity name (WUOPRL, FU_VAR1), a
 * region-set-qualified vector (ROIP_ABC), a standard L-modifier vector, or a
 * member of one of opm-common's open-ended summary-vector families. Such a
 * token at column 1 starts its own vector and must never be absorbed as a
 * name-list argument of a preceding SUMMARY vector.
 */
function isShapeRecognisedSummaryToken(
  kw: string,
  index: AnalysisIndex,
  summaryNamePatterns: readonly RegExp[],
): boolean {
  return (
    UDQ_NAME_RE.test(kw)
    || isRegionSetVector(index, kw)
    || isSummaryModifierVector(index, kw)
    || summaryNamePatterns.some(re => re.test(kw))
  );
}

/** Resolve `kw` to an index entry, falling back to a templated-prefix
 *  match when no exact entry exists. Returns the *template's* entry —
 *  callers use it for shape (size_kind, etc.); the displayed keyword
 *  name remains the full token from the deck.
 *
 *  Picks the *shortest* matching template. We can't disambiguate
 *  e.g. ``FTPRSEA`` between template ``FTPR`` + tracer ``SEA`` and
 *  ``FTPRS`` + tracer ``EA`` without knowing the user's TRACERS list,
 *  and the base template (``FTPR``) is far more common in real decks
 *  than the qualified Free/Solution variants. All variants share the
 *  same size_kind anyway, so this only affects hover descriptions. */
function lookupEntry(
  index: AnalysisIndex,
  kw: string,
): AnalysisEntry | undefined {
  const direct = index[kw];
  if (direct) return direct;
  let best: AnalysisEntry | undefined;
  let bestLen = Infinity;
  for (const name in index) {
    if (name.length >= bestLen) continue;
    if (name.length >= kw.length) continue;
    if (!kw.startsWith(name)) continue;
    const entry = index[name];
    if (!entry?.templated) continue;
    if (!TEMPLATE_SUFFIX_RE.test(kw.slice(name.length))) continue;
    best = entry;
    bestLen = name.length;
  }
  return best;
}

/** True when, after the last value token, the line carries a '/' terminator
 *  (possibly followed by a '--' comment). */
function lineHasRecordTerminator(text: string, lastTokenEnd: number): boolean {
  for (let j = lastTokenEnd; j < text.length; j++) {
    const c = text[j];
    if (c === ' ' || c === '\t') continue;
    if (c === '-' && text[j + 1] === '-') return false;
    return c === '/';
  }
  return false;
}

// --- Positional value-type checking ---------------------------------------
// Token shapes used to decide whether a record value is well-formed for the
// parameter's declared opm-common type. Kept deliberately conservative: we
// only flag values whose form is *unambiguously* wrong, never a bare
// identifier against a numeric slot (it may be a UDA/UDQ reference or a macro
// substitution the line-oriented engine cannot resolve).
const INT_TOKEN_RE = /^[-+]?\d+$/;
const NUMERIC_TOKEN_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

// Phase keywords that opm-common lists as `requires` targets (SWOF requires
// OIL + WATER, SGFN requires GAS, …).
const PHASE_KEYWORDS: ReadonlySet<string> = new Set([
  'OIL', 'GAS', 'WATER', 'DISGAS', 'VAPOIL', 'VAPWAT', 'DISGASW',
]);

// Modes that activate a fixed phase set *without* the explicit phase keywords
// above (CO2STORE = water + gas, H2STORE = water + gas, …). When one of these
// is present the phase-keyword requirements are satisfied implicitly, so a
// missing-phase diagnostic would be a false positive.
const IMPLICIT_PHASE_MODE_KEYWORDS: ReadonlySet<string> = new Set([
  'CO2STORE', 'CO2STOR', 'H2STORE',
]);

function isQuotedToken(t: string): boolean {
  return t.startsWith("'");
}

function stripQuotes(t: string): string {
  return isQuotedToken(t) ? t.replace(/^'/, '').replace(/'$/, '') : t;
}

/**
 * Locate the parameter occupying 1-based record position `col` within the
 * active record. Grouped/variadic indices (string form like "3-52") are not
 * type-checked, so only integer positions match.
 */
function paramAtPosition(
  entry: AnalysisEntry,
  record: number,
  col: number,
): AnalysisParam | undefined {
  const params = entry.parameters;
  if (!params) return undefined;
  const multi = !!entry.records_meta;
  for (const p of params) {
    if (multi && (p.record ?? 1) !== record) continue;
    if (typeof p.index === 'number' && p.index === col) return p;
  }
  return undefined;
}

/**
 * Return a diagnostic message for a record value that does not match its
 * parameter's declared type/options, or null when the value is acceptable.
 * `raw` is the verbatim token (a repeat-value's count prefix already stripped
 * by the caller; pure defaults are never passed in).
 */
function valueTypeError(
  param: AnalysisParam,
  raw: string,
  kwName: string,
): string | null {
  const quoted = isQuotedToken(raw);
  const val = stripQuotes(raw);

  // A blank or whitespace-only token (e.g. `''` or `'   '`) is a placeholder
  // for a defaulted value — never a type error.
  if (val.trim() === '') return null;

  // NB: an enum (`options[]`) mismatch is deliberately NOT flagged. The option
  // sets are extracted heuristically from the manual prose and are frequently
  // incomplete or abbreviated (e.g. WCONINJE's phase lists "WAT" rather than
  // the valid "WATER"), so flagging values outside the set produced thousands
  // of false positives on the known-good opm-tests corpus. Options remain in
  // the index for *completions*, where being incomplete is harmless.

  switch (param.value_type) {
    case 'INT':
      if (quoted) {
        return `${kwName}: ${param.name ?? 'value'} expects an integer; got a quoted string.`;
      }
      if (INT_TOKEN_RE.test(val)) return null;
      if (NUMERIC_TOKEN_RE.test(val)) {
        return `${kwName}: ${param.name ?? 'value'} expects an integer; got '${val}'.`;
      }
      return null; // bare names left alone (UDA/UDQ/macro)
    case 'DOUBLE':
      if (quoted) {
        return `${kwName}: ${param.name ?? 'value'} expects a number; got a quoted string.`;
      }
      return null; // numeric ok; bare names left alone
    default:
      return null; // STRING / RAW_STRING / UDA / unknown: accept any token
  }
}

/**
 * Walk a document and emit line-level diagnostics:
 *
 * - **Arity**: a record with more values than the keyword's per-record
 *   item count (from opm-common). Too-few values are not flagged because
 *   OPM Flow auto-defaults trailing positions before the `/`.
 * - **Value type**: a record value whose form is unambiguously wrong for the
 *   matching item's declared `value_type` (a quoted string in a numeric slot,
 *   a decimal in an `INT` slot) or, for `STRING` items with an `options[]`
 *   set, a value outside that set. Defaults (`*`, `N*`) are always accepted.
 * - **Section validity**: a keyword whose authoritative `sections` list
 *   does not include the section currently in scope.
 * - **Record terminator**: a record line that has values but is missing
 *   the trailing `/`. Flagged for keywords known to take records
 *   (`size_kind` of `fixed` or `list`).
 * - **List terminator**: a `list`-kind keyword block that is not closed
 *   by a standalone `/` line before the next keyword (or end of file).
 * - **Array terminator**: an `array`-kind keyword block (cell-property
 *   stream) that is not closed by a `/` — accepted either standalone or
 *   trailing on the last value line — before the next keyword.
 * - **Column-1**: a recognised keyword (section, indexed, or excluded) that
 *   is indented. OPM Flow only recognises keywords that start in column one.
 * - **Uppercase**: a line shaped like a keyword declaration but written with
 *   lowercase letters, where the upper-cased form is a recognised keyword.
 *   Lowercase keywords are not recognised by OPM Flow.
 */
export function computeDiagnostics(
  lines: string[],
  index: AnalysisIndex,
  excludedKeywords: ReadonlySet<string> = DIAGNOSTICS_EXCLUDED_KEYWORDS,
  /**
   * Anchored regexes for open-ended summary-vector families (UDQ, tracer,
   * water-cut-bucket mnemonics) from opm-common's `deck_name_regex`. A token
   * matching one of these is a recognised SUMMARY vector and is not flagged as
   * an unknown keyword. Each regex should already be anchored (`^…$`).
   */
  summaryNamePatterns: readonly RegExp[] = [],
): LineDiagnostic[] {
  const out: LineDiagnostic[] = [];
  let activeKw: AnalysisEntry | null = null;
  let activeKwLine = -1;
  let activeKwIndent = 0;
  let recordCount = 0;
  // 1-based index of the record the next record line belongs to. Bumped
  // after each record-terminating '/' and capped at records_meta.length so
  // the trailing variadic record absorbs all further rows (WELSEGS rec 2,
  // VFPPROD rec 7, etc.).
  let currentRecord = 1;
  let lastRecordLine = -1;
  let lastRecordEndChar = 0;
  // An "open" record is one whose value tokens have been seen but whose
  // terminating '/' has not yet appeared. OPM Flow lets a record's '/' sit on
  // a later line (`MINPV` <nl> ` 10` <nl> `/`), so we defer the
  // missing-terminator diagnostic until the record is closed (by a '/') or the
  // block ends with it still open. -1 means no record is currently open.
  let openRecordLine = -1;
  let openRecordStart = 0;
  let openRecordEnd = 0;
  let listTerminatorSeen = false;
  let arrayTerminatorSeen = false;
  // Set once a RAW_TEXT_BODY_KEYWORD (TITLE, …) is recognised: the next
  // non-blank, non-comment line is its free-form text body and must be skipped
  // wholesale rather than parsed as a keyword.
  let expectRawTextLine = false;
  let currentSection: string | null = null;
  // True once an INCLUDE/IMPORT/GDFILE has appeared since the last section
  // header. An included file may itself contain section headers (decks
  // routinely split SECTIONS across includes — e.g. RUNSPEC in the master
  // deck, the rest pulled in via INCLUDE), so once we've seen one we can no
  // longer trust `currentSection` and must suppress the wrong-section check.
  let includeSinceSection = false;
  // Tracks an open `ACTIONX` block. ACTIONX opens a block of nested SCHEDULE
  // keywords (the action) that must be closed by an `ENDACTIO`; the active
  // keyword moves on to those nested keywords, so this is tracked separately
  // and evaluated at end-of-deck to flag a block that is never closed.
  let actionxOpenLine = -1;
  let actionxStart = 0;
  let actionxEnd = 0;
  // First occurrence of each recognised keyword (by canonical entry name),
  // collected during the walk and evaluated once at the end for the
  // document-wide requires/prohibits constraints.
  const seenKeywords = new Map<
    string,
    { entry: AnalysisEntry; line: number; startChar: number; endChar: number }
  >();
  // True once any file-loading keyword (INCLUDE/IMPORT/GDFILE) has appeared
  // anywhere in the deck. A `requires` partner may live in an included file,
  // so the missing-requirement check is suppressed when this is set.
  let hasIncludeKeyword = false;
  // True once any section header has appeared. The `requires` check only
  // makes sense on a complete deck; an INCLUDE *fragment* (a bare .inc/.grdecl
  // with no section header) legitimately omits the RUNSPEC phase keywords its
  // tables "require", so the check is suppressed when no section is present.
  let sawSectionHeader = false;

  const closeKw = (): void => {
    if (!activeKw) return;
    // A record left open at the block boundary (no '/' before the next keyword,
    // section header, or end of file) is a genuine missing terminator. Flag it
    // for record-taking keywords; variadic-record keywords are exempt (their
    // records legitimately span many lines and are not '/'-per-line).
    if (
      openRecordLine >= 0 &&
      !activeKw.variadic_record &&
      (activeKw.size_kind === 'fixed' || activeKw.size_kind === 'list')
    ) {
      out.push({
        line: openRecordLine,
        startChar: openRecordStart,
        endChar: openRecordEnd,
        message: `${activeKw.name}: record is missing the terminating '/'.`,
        code: 'missing-record-terminator',
      });
    }
    // Optional-body keywords (non-F SUMMARY mnemonics) may appear bare
    // and stacked, so a block that consumed no records doesn't need a
    // closing '/'. Once values are present the normal array/list rule
    // applies again.
    //
    // Any `array`-kind SUMMARY vector is treated the same when it consumed no
    // records: WSIR/WSPR/WMCTL and the C/W component-rate vectors are routinely
    // written bare and stacked with a single shared '/'. opm-common's
    // probe-expanded entries don't carry the `optional_body` flag, so key off
    // the SUMMARY section list instead (which reliably separates them from real
    // cell arrays like PRESSURE/PORO that legitimately require a terminator).
    const isBareSummaryArray =
      activeKw.size_kind === 'array' &&
      recordCount === 0 &&
      Array.isArray(activeKw.sections) &&
      activeKw.sections.includes('SUMMARY');
    const bareOptionalBody =
      (activeKw.optional_body && recordCount === 0) || isBareSummaryArray;
    const needsTerminator =
      !bareOptionalBody
      // Variadic-record keywords (VFPPROD, VFPINJ, RSVD, …) have a table-style
      // final record that is closed by its own per-record '/', not by a
      // separate standalone list terminator — so they need no closing '/'.
      && !activeKw.variadic_record
      && (
        (activeKw.size_kind === 'list' && !listTerminatorSeen) ||
        (activeKw.size_kind === 'array' && !arrayTerminatorSeen)
      );
    if (needsTerminator) {
      // Anchor the squiggle at the end of the last record when we have one,
      // otherwise at the keyword name itself.
      const at = lastRecordLine >= 0 ? lastRecordLine : activeKwLine;
      const sc = lastRecordLine >= 0 ? lastRecordEndChar : activeKwIndent;
      const ec = lastRecordLine >= 0
        ? lastRecordEndChar + 1
        : activeKwIndent + activeKw.name.length;
      const what = activeKw.size_kind === 'array'
        ? `close the value array`
        : `close the record list`;
      out.push({
        line: at,
        startChar: sc,
        endChar: ec,
        message: `${activeKw.name}: missing terminating '/' to ${what}.`,
        code: activeKw.size_kind === 'array'
          ? 'missing-array-terminator'
          : 'missing-list-terminator',
      });
    }
    activeKw = null;
    activeKwLine = -1;
    activeKwIndent = 0;
    recordCount = 0;
    currentRecord = 1;
    lastRecordLine = -1;
    lastRecordEndChar = 0;
    listTerminatorSeen = false;
    arrayTerminatorSeen = false;
    openRecordLine = -1;
    openRecordStart = 0;
    openRecordEnd = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isCommentLine(text)) continue;
    if (text.trim() === '') continue;

    // Free-form text body of a raw-text keyword (TITLE, …). Consumed verbatim
    // so a title like `CO2STORE` or `ACTIONX_GCONPROD` is not mis-parsed as a
    // keyword. Done before every other check (section, terminator, keyword) so
    // even title text shaped like a section header is left alone.
    if (expectRawTextLine) {
      expectRawTextLine = false;
      continue;
    }

    // A line that is just '/' (with optional comment). When a record is open
    // (its values were on previous lines) this '/' terminates that record. When
    // no record is open it is the block terminator that closes a record list or
    // value array.
    if (isStandaloneTerminator(text)) {
      if (openRecordLine >= 0) {
        openRecordLine = -1;
        if (activeKw?.records_meta) {
          currentRecord = Math.min(currentRecord + 1, activeKw.records_meta.length);
        }
      } else {
        if (activeKw?.size_kind === 'list') listTerminatorSeen = true;
        if (activeKw?.size_kind === 'array') arrayTerminatorSeen = true;
      }
      continue;
    }

    // Section header — handled before the generic keyword match so trailing
    // decoration (`GRID =========`, `SCHEDULE ====`) doesn't hide the section.
    // Without this the section never advances and every following keyword is
    // wrongly flagged "not valid in RUNSPEC".
    const section = matchSectionLine(text);
    if (section) {
      if (section.indent > 0) {
        out.push({
          line: i,
          startChar: section.indent,
          endChar: section.indent + section.name.length,
          message: `${section.name}: keywords must start in column 1; indented keywords are not recognised by OPM Flow.`,
          code: 'indented-keyword',
        });
      }
      closeKw();
      currentSection = section.name;
      sawSectionHeader = true;
      includeSinceSection = false;
      continue;
    }

    // Lowercase-keyword check: a line shaped like a keyword declaration whose
    // upper-cased form is a recognised keyword. OPM Flow silently ignores
    // such lines, so they need to be surfaced.
    const looseMatch = text.match(KEYWORD_LINE_LOOSE_RE);
    if (looseMatch) {
      const tok = looseMatch[1];
      const upper = tok.toUpperCase();
      const isRecognised =
        SECTION_KEYWORD_SET.has(upper)
        || lookupEntry(index, upper) !== undefined
        || excludedKeywords.has(upper);
      if (tok !== upper && isRecognised) {
        const indent = text.length - text.trimStart().length;
        out.push({
          line: i,
          startChar: indent,
          endChar: indent + tok.length,
          message: `${upper}: keywords must be in capital case; lowercase keywords are not recognised by OPM Flow.`,
          code: 'lowercase-keyword',
        });
        closeKw();
        continue;
      }
    }

    const m = text.match(KEYWORD_LINE_RE);
    if (m) {
      const kw = m[1];
      const indent = text.length - text.trimStart().length;

      // A single uppercase identifier mid-block is more plausibly an
      // unquoted string value (e.g. `INCLUDE` <newline> `PATH`, or
      // `EQLOPTS` <newline> ` THPRES /`) than a new keyword. Treat it
      // as a record when the active block still expects records and
      // either (a) the token is not a known keyword, or (b) it is
      // indented — OPM Flow only recognises keywords in column 1, so
      // an indented uppercase token cannot start a new keyword even
      // if its name happens to be in the index (THPRES, INCLUDE, …).
      const entry = lookupEntry(index, kw);
      // While a report keyword's free-form mnemonic body is open, any column-1
      // token (even one matching a real keyword name) is a mnemonic, not a new
      // keyword. Section headers are matched earlier and still end the block.
      const inFreeformMnemonicBlock =
        activeKw !== null && FREEFORM_MNEMONIC_KEYWORDS.has(activeKw.name);
      // A column-1 token that is itself a recognised SUMMARY vector (by shape)
      // sitting under an open SUMMARY vector starts its own vector — it is not a
      // name-list argument. Without this guard a bare enable-keyword (PERFORMA)
      // would greedily swallow the UDQ/tracer mnemonics that follow it and then
      // be flagged for a missing terminator.
      const activeIsSummaryVector =
        activeKw !== null
        && Array.isArray(activeKw.sections)
        && activeKw.sections.includes('SUMMARY');
      const tokenStartsOwnSummaryVector =
        indent === 0
        && !entry
        && activeIsSummaryVector
        && isShapeRecognisedSummaryToken(kw, index, summaryNamePatterns);
      const treatAsRecord =
        activeKw !== null
        && !excludedKeywords.has(kw)
        && !tokenStartsOwnSummaryVector
        && (
          inFreeformMnemonicBlock ||
          // An indented token that is not a known keyword cannot be a keyword
          // at all (OPM only recognises keywords in column 1), so it is record
          // body of the active block — e.g. a single well name '  PROD2 /'
          // under a SUMMARY vector that does not "expect more records". Without
          // this it would be mis-flagged as an unknown keyword.
          (indent > 0 && !entry)
          // Otherwise a single uppercase token continues the block as an
          // unquoted string value only while it still expects records: a
          // column-1 unknown token, or an indented token whose name happens to
          // match a keyword (THPRES under EQLOPTS).
          || ((!entry || indent > 0)
              && expectsMoreRecords(activeKw, recordCount, listTerminatorSeen, arrayTerminatorSeen))
        );

      if (!treatAsRecord) {
        closeKw();

        // Column-1 check fires for any recognised keyword (indexed or
        // excluded). Unknown keywords get the dedicated "not recognised"
        // diagnostic below instead, so they aren't doubled up.
        if (indent > 0 && (entry !== undefined || excludedKeywords.has(kw))) {
          out.push({
            line: i,
            startChar: indent,
            endChar: indent + kw.length,
            message: `${kw}: keywords must start in column 1; indented keywords are not recognised by OPM Flow.`,
            code: 'indented-keyword',
          });
        }

        // Keywords on the exclusion list opt out of all diagnostics: skip the
        // section-validity check here and leave activeKw null so subsequent
        // record lines are not arity- or terminator-checked.
        if (excludedKeywords.has(kw)) {
          continue;
        }

        activeKw = entry ?? null;
        activeKwLine = i;
        activeKwIndent = indent;

        // Unknown-keyword check: the token looks like a keyword but is not in
        // the OPM Flow vocabulary (and not on the exclusion list). Most often a
        // typo. Flag and stop tracking — there's no parser data to validate the
        // record body against anyway.
        if (!activeKw) {
          // Recognised SUMMARY vectors by shape rather than index entry:
          // user-defined quantity names (WUOPRL, FU_VAR1), region-set-qualified
          // vectors (ROIP_ABC), standard L-modifier vectors (WOPRL, LWWIR), and
          // members of opm-common's open-ended deck_name_regex families.
          if (isShapeRecognisedSummaryToken(kw, index, summaryNamePatterns)) continue;
          out.push({
            line: i,
            startChar: activeKwIndent,
            endChar: activeKwIndent + kw.length,
            message: `${kw} is not a recognised OPM Flow keyword.`,
            code: 'unknown-keyword',
            suggestion: nearestKeyword(kw, index, SECTION_KEYWORD_SET),
          });
          continue;
        }

        // ACTIONX ... ENDACTIO block tracking. ACTIONX opens an action block
        // that must be closed by ENDACTIO. The intervening (nested) keywords
        // become the active keyword in turn, so the open state is tracked on
        // the side and reported at end-of-deck if never closed.
        if (activeKw.name === 'ACTIONX') {
          actionxOpenLine = i;
          actionxStart = activeKwIndent;
          actionxEnd = activeKwIndent + kw.length;
        } else if (activeKw.name === 'ENDACTIO') {
          actionxOpenLine = -1;
        }

        // Raw-text keywords (TITLE, …) carry a single free-form text line that
        // must not be parsed as a keyword. Arm the skip for the next line.
        if (RAW_TEXT_BODY_KEYWORDS.has(activeKw.name)) {
          expectRawTextLine = true;
        }

        // Record the first occurrence of this keyword for the document-wide
        // requires/prohibits checks. Keyed by the canonical entry name so a
        // templated deck token (FTPRSEA) maps to its base (FTPR); the range
        // still points at the literal token in the deck.
        if (!seenKeywords.has(activeKw.name)) {
          seenKeywords.set(activeKw.name, {
            entry: activeKw,
            line: i,
            startChar: activeKwIndent,
            endChar: activeKwIndent + kw.length,
          });
        }

        // A file-loading keyword may pull in section headers from another
        // file, after which `currentSection` can no longer be trusted.
        if (kw === 'INCLUDE' || kw === 'IMPORT' || kw === 'GDFILE') {
          includeSinceSection = true;
          hasIncludeKeyword = true;
        }

        // Section-validity check. Suppressed once an INCLUDE/IMPORT/GDFILE has
        // appeared since the last section header, to avoid false positives on
        // decks whose sections are split across included files.
        if (
          activeKw?.sections?.length &&
          currentSection &&
          !includeSinceSection &&
          !activeKw.sections.includes(currentSection)
        ) {
          out.push({
            line: i,
            startChar: activeKwIndent,
            endChar: activeKwIndent + kw.length,
            message:
              `${kw} is not valid in ${currentSection}; valid in: ${activeKw.sections.join(', ')}.`,
          });
        }
        continue;
      }
      // else: fall through to record-line handling below — this is an
      // unquoted string value belonging to the still-open block.
    }

    // Record line.
    if (!activeKw) continue;
    const tokens = tokenizeLine(text);
    if (tokens.length === 0) continue;

    // UDQ body statements must begin with a control word
    // (ASSIGN/DEFINE/UNITS/UPDATE). Check only the first line of a statement —
    // `openRecordLine < 0` means no earlier statement is still awaiting its
    // '/', so this line starts a new statement rather than continuing one.
    if (activeKw.name === 'UDQ' && openRecordLine < 0) {
      const head = tokens[0].text.toUpperCase();
      if (!UDQ_CONTROL_WORDS.has(head)) {
        out.push({
          line: i,
          startChar: tokens[0].start,
          endChar: tokens[0].end,
          message:
            `UDQ: expected a control word (ASSIGN, DEFINE, UNITS or UPDATE) but found '${tokens[0].text}'.`,
        });
      }
    }

    const lastTok = tokens[tokens.length - 1];
    const hasTerm = lineHasRecordTerminator(text, lastTok.end);

    // Arity: too many values? For multi-record keywords the per-record
    // column count comes from records_meta[currentRecord-1]; otherwise it's
    // the keyword-wide expected_columns.
    const expected =
      activeKw.records_meta?.[currentRecord - 1]?.expected_columns
      ?? activeKw.expected_columns;
    if (expected) {
      let total = 0;
      let overflowStart = -1;
      for (const tok of tokens) {
        if (overflowStart === -1 && total + tok.columnCount > expected) {
          overflowStart = tok.start;
        }
        total += tok.columnCount;
      }
      if (total > expected) {
        const where = activeKw.records_meta
          ? ` in record ${currentRecord}`
          : '';
        out.push({
          line: i,
          startChar: overflowStart,
          endChar: lastTok.end,
          message:
            `${activeKw.name}${where}: record has ${total} values; expected at most ${expected}.`,
        });
      }
    }

    // Positional value-type check. Each token is validated against the
    // matching item's declared type (and options set). Skipped for
    // variadic-record keywords (table data with a single ALL-arity item, no
    // meaningful per-position types) and for keywords lacking parameter data.
    if (activeKw.parameters?.length && !activeKw.variadic_record) {
      let col = 1;
      for (const tok of tokens) {
        const repeat = tok.text.match(/^(\d+)\*(.*)$/);
        const pureDefault = tok.text === '*' || (repeat !== null && repeat[2] === '');
        if (!pureDefault) {
          // For a repeat-value token (N*VALUE) check the repeated VALUE
          // against the parameter at the run's first position.
          const valueText = repeat ? repeat[2] : tok.text;
          const param = paramAtPosition(activeKw, currentRecord, col);
          if (param) {
            const msg = valueTypeError(param, valueText, activeKw.name);
            if (msg) {
              out.push({ line: i, startChar: tok.start, endChar: tok.end, message: msg });
            }
          }
        }
        col += tok.columnCount;
      }
    }

    // Record terminator tracking. OPM Flow allows a record's '/' to appear on a
    // later line, so we don't flag a missing terminator here — we mark the
    // record "open" and let the standalone-'/' handler close it, or closeKw
    // flag it if the block ends with the record still open. A trailing '/' on
    // this line closes the record immediately.
    if (hasTerm) {
      openRecordLine = -1;
    } else if (
      !activeKw.variadic_record &&
      (activeKw.size_kind === 'fixed' || activeKw.size_kind === 'list')
    ) {
      openRecordLine = i;
      openRecordStart = lastTok.start;
      openRecordEnd = lastTok.end;
    }

    // For array-kind keywords, a '/' trailing the last value line closes
    // the block (no separate standalone-'/' line is required).
    if (hasTerm && activeKw.size_kind === 'array') {
      arrayTerminatorSeen = true;
    }

    recordCount++;
    lastRecordLine = i;
    lastRecordEndChar = lastTok.end;
    // Per-record terminator advances to the next record (capped). The
    // trailing variadic record stays "current" for all remaining rows.
    if (hasTerm && activeKw.records_meta) {
      currentRecord = Math.min(currentRecord + 1, activeKw.records_meta.length);
    }
  }

  closeKw();

  // An ACTIONX block left open at end of deck has no matching ENDACTIO.
  if (actionxOpenLine >= 0) {
    out.push({
      line: actionxOpenLine,
      startChar: actionxStart,
      endChar: actionxEnd,
      message: `ACTIONX: action block is not closed; a matching ENDACTIO is required.`,
    });
  }

  // --- Cross-keyword constraints (requires / prohibits) -------------------
  // Evaluated document-wide once all keyword occurrences are known.
  const reportedProhibitPairs = new Set<string>();
  let hasImplicitPhaseMode = false;
  for (const k of IMPLICIT_PHASE_MODE_KEYWORDS) {
    if (seenKeywords.has(k)) { hasImplicitPhaseMode = true; break; }
  }
  for (const [name, where] of seenKeywords) {
    const { entry } = where;

    // `requires`: every listed keyword must also be present. Suppressed when
    // the deck pulls in other files (the requirement may be satisfied there)
    // or when the input has no section header (an INCLUDE fragment, not a
    // complete deck).
    if (entry.requires && !hasIncludeKeyword && sawSectionHeader) {
      for (const req of entry.requires) {
        if (seenKeywords.has(req)) continue;
        // A phase requirement is satisfied implicitly under CO2STORE/H2STORE
        // and similar modes, which set the phases without the phase keyword.
        if (hasImplicitPhaseMode && PHASE_KEYWORDS.has(req)) continue;
        out.push({
          line: where.line,
          startChar: where.startChar,
          endChar: where.endChar,
          message: `${name} requires ${req}, which is not present in the deck.`,
        });
      }
    }

    // `prohibits`: warn once per unordered pair when both are present.
    if (entry.prohibits) {
      for (const pro of entry.prohibits) {
        if (!seenKeywords.has(pro)) continue;
        const pairKey = name < pro ? `${name} ${pro}` : `${pro} ${name}`;
        if (reportedProhibitPairs.has(pairKey)) continue;
        reportedProhibitPairs.add(pairKey);
        out.push({
          line: where.line,
          startChar: where.startChar,
          endChar: where.endChar,
          message: `${name} cannot be used together with ${pro}; they are mutually exclusive.`,
        });
      }
    }
  }

  return out;
}
