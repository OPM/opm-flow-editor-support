// ---------------------------------------------------------------------------
// Pure analysis helpers shared by the diagnostics provider.
// Kept free of vscode imports so they can be unit-tested under jest.
// ---------------------------------------------------------------------------

import {
  tokenizeLine,
  isCommentLine,
  KEYWORD_LINE_RE,
  SECTION_KEYWORD_SET,
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

export interface AnalysisEntry {
  name: string;
  expected_columns?: number;
  records_meta?: RecordMeta[];
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
}

export type AnalysisIndex = Record<string, AnalysisEntry>;

export interface LineDiagnostic {
  /** Zero-based document line. */
  line: number;
  /** Zero-based char range to underline. */
  startChar: number;
  endChar: number;
  /** Human-readable message ready for VS Code. */
  message: string;
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
    const expected = entry.records_meta?.length ?? entry.size_count ?? 0;
    return recordCount < expected;
  }
  return false;
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

/**
 * Walk a document and emit line-level diagnostics:
 *
 * - **Arity**: a record with more values than the keyword's per-record
 *   item count (from opm-common). Too-few values are not flagged because
 *   OPM Flow auto-defaults trailing positions before the `/`.
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
 */
export function computeDiagnostics(
  lines: string[],
  index: AnalysisIndex,
  excludedKeywords: ReadonlySet<string> = DIAGNOSTICS_EXCLUDED_KEYWORDS,
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
  let listTerminatorSeen = false;
  let arrayTerminatorSeen = false;
  let currentSection: string | null = null;

  const closeKw = (): void => {
    if (!activeKw) return;
    const needsTerminator =
      (activeKw.size_kind === 'list' && !listTerminatorSeen) ||
      (activeKw.size_kind === 'array' && !arrayTerminatorSeen);
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
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isCommentLine(text)) continue;
    if (text.trim() === '') continue;

    // A line that is just '/' (with optional comment) is the list terminator.
    if (isStandaloneTerminator(text)) {
      if (activeKw?.size_kind === 'list') listTerminatorSeen = true;
      if (activeKw?.size_kind === 'array') arrayTerminatorSeen = true;
      continue;
    }

    const m = text.match(KEYWORD_LINE_RE);
    if (m) {
      const kw = m[1];

      if (SECTION_KEYWORD_SET.has(kw)) {
        closeKw();
        currentSection = kw;
        continue;
      }

      // A single uppercase identifier mid-block is more plausibly an
      // unquoted string value (e.g. `INCLUDE` <newline> `PATH`) than a new
      // keyword. If the active keyword's block is still expecting records
      // and the token is not itself a known keyword (or excluded), fall
      // through to record parsing instead of starting a new keyword.
      const treatAsRecord =
        activeKw !== null
        && !index[kw]
        && !excludedKeywords.has(kw)
        && expectsMoreRecords(activeKw, recordCount, listTerminatorSeen, arrayTerminatorSeen);

      if (!treatAsRecord) {
        closeKw();

        // Keywords on the exclusion list opt out of all diagnostics: skip the
        // section-validity check here and leave activeKw null so subsequent
        // record lines are not arity- or terminator-checked.
        if (excludedKeywords.has(kw)) {
          continue;
        }

        activeKw = index[kw] ?? null;
        activeKwLine = i;
        activeKwIndent = text.length - text.trimStart().length;

        // Unknown-keyword check: the token looks like a keyword but is not in
        // the OPM Flow vocabulary (and not on the exclusion list). Most often a
        // typo. Flag and stop tracking — there's no parser data to validate the
        // record body against anyway.
        if (!activeKw) {
          out.push({
            line: i,
            startChar: activeKwIndent,
            endChar: activeKwIndent + kw.length,
            message: `${kw} is not a recognised OPM Flow keyword.`,
          });
          continue;
        }

        // Section-validity check
        if (
          activeKw?.sections?.length &&
          currentSection &&
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

    // Missing record terminator: only flag when we know the keyword takes
    // records (size_kind of 'fixed' or 'list'). If size_kind is unknown we
    // stay quiet rather than risk false positives.
    if (
      !hasTerm &&
      (activeKw.size_kind === 'fixed' || activeKw.size_kind === 'list')
    ) {
      out.push({
        line: i,
        startChar: lastTok.start,
        endChar: lastTok.end,
        message: `${activeKw.name}: record is missing the terminating '/'.`,
      });
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
  return out;
}
