// ---------------------------------------------------------------------------
// Record tokenizer
// ---------------------------------------------------------------------------

export interface Token {
  text: string;
  start: number;
  end: number;
  /** Number of parameter columns this token represents (N for "N*", 1 otherwise). */
  columnCount: number;
}

export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    if (line[i] === '-' && line[i + 1] === '-') break;
    if (line[i] === '/') break;

    const start = i;
    let text: string;

    if (line[i] === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== "'") j++;
      text = line.substring(i, j + 1);
      i = j + 1;
    } else {
      let j = i;
      while (j < line.length && !/[\s/]/.test(line[j])) j++;
      text = line.substring(i, j);
      i = j;
    }

    // N* matches "5*" alone and "5*1.0" (repeated value form); both span N
    // record positions even though they're a single whitespace-delimited token.
    const repeatMatch = text.match(/^(\d+)\*/);
    const columnCount = repeatMatch ? parseInt(repeatMatch[1], 10) : 1;
    tokens.push({ text, start, end: i, columnCount });
  }
  return tokens;
}

export function columnAtCursor(line: string, cursorChar: number): number {
  const tokens = tokenizeLine(line);
  let col = 1;
  for (const tok of tokens) {
    if (cursorChar >= tok.start && cursorChar < tok.end) return col;
    col += tok.columnCount;
  }
  return -1;
}

/**
 * Like columnAtCursor, but used at completion time: when the cursor sits
 * past all completed tokens (e.g. at the end of `'W1' 'G1' `), this
 * returns the column the next token would occupy. The end of the *last*
 * token at end-of-buffer counts as "still in that token" so completions
 * keep firing while the user types its value.
 */
export function columnForCompletion(line: string, cursorChar: number): number {
  const tokens = tokenizeLine(line);
  let col = 1;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (cursorChar < tok.start) return col;
    if (cursorChar >= tok.start && cursorChar < tok.end) return col;
    const isPartialAtEnd =
      cursorChar === tok.end &&
      i === tokens.length - 1 &&
      cursorChar === line.length;
    if (isPartialAtEnd) return col;
    col += tok.columnCount;
  }
  return col;
}

// ---------------------------------------------------------------------------
// Record line parser
// ---------------------------------------------------------------------------

export const NUMERIC_TOKEN_RE = /^(\*|\d+\*|[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)$/;

export const KEYWORD_TOKEN_RE = /^[A-Z][A-Z0-9_+-]*$/;

/** Matches a line that is just a keyword declaration (with optional trailing
 *  comment or `/`), as opposed to a record line. Permissive: accepts leading
 *  whitespace so diagnostics can flag indented keywords. Cursor-driven
 *  features (active-keyword lookup, docs panel, folding) should prefer the
 *  stricter `KEYWORD_LINE_COL1_RE` instead — OPM Flow only recognises a
 *  keyword when it starts in column 1, and an indented uppercase token is
 *  more plausibly an unquoted string value than a misplaced keyword. */
export const KEYWORD_LINE_RE = /^\s*([A-Z][A-Z0-9_+-]{1,})\s*(?:--|\/\s*(?:--|$)|$)/;

/** Column-1-anchored form of `KEYWORD_LINE_RE`. Use this for editor
 *  features (docs panel, hover, folding, active-keyword scan) so they
 *  agree with OPM Flow's parser: only column-1 declarations are real
 *  keywords. An indented `THPRES /` under EQLOPTS, for example, is a
 *  record value — not a new THPRES block. */
export const KEYWORD_LINE_COL1_RE = /^([A-Z][A-Z0-9_+-]{1,})\s*(?:--|\/\s*(?:--|$)|$)/;

/** Same shape as KEYWORD_LINE_RE but accepts lowercase letters too — used by
 *  diagnostics to detect keywords typed in non-uppercase form, which OPM Flow
 *  itself silently fails to recognise. */
export const KEYWORD_LINE_LOOSE_RE = /^\s*([A-Za-z][A-Za-z0-9_+-]{1,})\s*(?:--|\/\s*(?:--|$)|$)/;

/** The eight section-marker keywords, in canonical OPM Flow order. */
export const SECTION_KEYWORDS = [
  'RUNSPEC', 'GRID', 'EDIT', 'PROPS', 'REGIONS',
  'SOLUTION', 'SUMMARY', 'SCHEDULE',
] as const;

export const SECTION_KEYWORD_SET: ReadonlySet<string> = new Set(SECTION_KEYWORDS);

/**
 * Detect a section-header line, tolerating trailing decoration after the
 * section name. Many decks dress the section line with a visual separator,
 * e.g. `GRID =================` or `GRID========`; OPM Flow keys only on the
 * leading token and ignores the rest, so we must too. Without this the GRID
 * line is mistaken for a record/value, the active section never advances,
 * and every following keyword is wrongly flagged "not valid in RUNSPEC".
 *
 * Returns `{ name, indent }` when the leading token (optionally indented) is
 * one of the eight section keywords, else `null`. The indent is surfaced so
 * callers can still flag indented section headers — OPM Flow only recognises
 * keywords that start in column 1.
 */
export function matchSectionLine(text: string): { name: string; indent: number } | null {
  const m = text.match(/^(\s*)([A-Z][A-Z0-9_+-]*)/);
  if (!m) return null;
  const name = m[2];
  if (!SECTION_KEYWORD_SET.has(name)) return null;
  return { name, indent: m[1].length };
}

/** Number of parameter columns a record token represents.
 *  Matches both "N*" (defaulted) and "N*VALUE" (repeated value); both span N positions. */
export function tokenColumnCount(token: string): number {
  const m = token.match(/^(\d+)\*/);
  return m ? parseInt(m[1], 10) : 1;
}

export interface RecordLine {
  indent: string;
  tokens: string[];
  trailComment: string;
  hasTerminator: boolean;
}

export function parseRecordLine(line: string): RecordLine | null {
  const indent = line.match(/^[ \t]*/)![0];
  let i = indent.length;
  const tokens: string[] = [];
  let hasTerminator = false;

  while (i < line.length) {
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= line.length) break;
    if (line[i] === '-' && line[i + 1] === '-') break;
    if (line[i] === '/') { hasTerminator = true; break; }

    const start = i;
    if (line[i] === "'") {
      i++;
      while (i < line.length && line[i] !== "'") i++;
      if (i < line.length) i++;
      tokens.push(line.substring(start, i));
    } else {
      while (i < line.length) {
        const c = line[i];
        if (c === ' ' || c === '\t' || c === '/') break;
        if (c === '-' && line[i + 1] === '-') break;
        i++;
      }
      tokens.push(line.substring(start, i));
    }
  }

  if (tokens.length === 0) return null;

  if (hasTerminator) {
    i++;
  } else if (tokens.length === 1 && KEYWORD_TOKEN_RE.test(tokens[0])) {
    // A lone uppercase identifier on a line is a keyword declaration, not a record.
    return null;
  }

  const rest = line.substring(i).replace(/^[ \t]+/, '').trimEnd();
  // Anything after the terminating '/' is treated as a free-form trailing
  // comment, with or without the '--' prefix. Without a terminator only
  // a '--' comment may follow the tokens.
  if (rest && !hasTerminator && !rest.startsWith('--')) return null;
  return { indent, tokens, trailComment: rest, hasTerminator };
}

export function isCommentLine(line: string): boolean {
  return /^\s*--/.test(line);
}

// ---------------------------------------------------------------------------
// Line-comment toggle
// ---------------------------------------------------------------------------

/** A line is treated as commented for toggle purposes only when the comment
 *  marker sits at the *absolute* start of the line (column 0). An indented
 *  `--` is left alone so the toggle round-trips cleanly. */
const LEADING_COMMENT_RE = /^--[ \t]?/;

/**
 * Toggle `--` line comments at the absolute beginning of each given line.
 *
 * Mirrors the editor's "toggle line comment" convention: if every non-blank
 * line already starts with `--`, all of them are uncommented; otherwise every
 * non-blank line is commented by prefixing `-- ` at column 0. Blank lines are
 * left untouched. Returns the rewritten lines, or `null` when there is nothing
 * to toggle (no non-blank lines).
 */
export function toggleLineComments(lines: string[]): string[] | null {
  const nonBlank = lines.filter(l => l.trim() !== '');
  if (nonBlank.length === 0) return null;
  const allCommented = nonBlank.every(l => l.startsWith('--'));
  return lines.map(l => {
    if (l.trim() === '') return l;
    if (allCommented) return l.replace(LEADING_COMMENT_RE, '');
    return `-- ${l}`;
  });
}

// ---------------------------------------------------------------------------
// Column alignment helpers
// ---------------------------------------------------------------------------

/**
 * For a float token, split at the decimal point.
 * Returns { intPart, decPart } where decPart includes the '.' character.
 * If there is no decimal point, returns { intPart: token, decPart: '' }.
 */
function splitAtDot(token: string): { intPart: string; decPart: string } {
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) return { intPart: token, decPart: '' };
  return { intPart: token.substring(0, dotIdx), decPart: token.substring(dotIdx) };
}

/**
 * Compute per-column alignment metadata for a group of records.
 *
 * For each column we track:
 *   - maxWidth    : maximum raw token length
 *   - isNumeric   : all tokens match NUMERIC_TOKEN_RE
 *   - hasDecimal  : at least one non-default numeric token contains '.'
 *   - maxIntLen   : max length of the part before '.' (used for decimal alignment)
 *   - maxDecLen   : max length of the part from '.' to end (used for decimal alignment)
 *
 * When hasDecimal is true, the effective column width is maxIntLen + maxDecLen so
 * that the decimal point is vertically aligned across all rows.
 */
interface ColMeta {
  maxWidth: number;
  isNumeric: boolean;
  hasDecimal: boolean;
  maxIntLen: number;
  maxDecLen: number;
  /** Effective column width (accounts for decimal alignment). */
  effectiveWidth: number;
}

function computeColMeta(records: RecordLine[]): ColMeta[] {
  const nCols = records[0].tokens.length;
  const meta: ColMeta[] = Array.from({ length: nCols }, () => ({
    maxWidth: 0,
    isNumeric: true,
    hasDecimal: false,
    maxIntLen: 0,
    maxDecLen: 0,
    effectiveWidth: 0,
  }));

  for (const r of records) {
    for (let c = 0; c < nCols; c++) {
      const t = r.tokens[c] ?? '';
      if (t.length > meta[c].maxWidth) meta[c].maxWidth = t.length;
      if (!NUMERIC_TOKEN_RE.test(t)) { meta[c].isNumeric = false; continue; }
      if (t.includes('*')) continue; // N* default tokens — skip for decimal analysis

      const dotIdx = t.indexOf('.');
      if (dotIdx !== -1) {
        meta[c].hasDecimal = true;
        if (dotIdx > meta[c].maxIntLen) meta[c].maxIntLen = dotIdx;
        const decLen = t.length - dotIdx;
        if (decLen > meta[c].maxDecLen) meta[c].maxDecLen = decLen;
      } else {
        // Integer-like token in a potentially mixed column
        if (t.length > meta[c].maxIntLen) meta[c].maxIntLen = t.length;
      }
    }
  }

  for (let c = 0; c < nCols; c++) {
    const m = meta[c];
    m.effectiveWidth = m.isNumeric && m.hasDecimal
      ? Math.max(m.maxWidth, m.maxIntLen + m.maxDecLen)
      : m.maxWidth;
  }

  return meta;
}

/**
 * Format a single numeric token for a column that uses decimal-point alignment.
 * The result is left-padded so the decimal point (or, for integers, the end of
 * the number) lands at position `intLen` within the returned string, and the
 * returned string is right-padded to `colWidth` total characters.
 */
function formatDecimalToken(t: string, intLen: number, colWidth: number): string {
  if (t.includes('*')) {
    // Default marker: right-align within column width
    return t.padStart(colWidth);
  }
  const dotIdx = t.indexOf('.');
  if (dotIdx !== -1) {
    const { intPart, decPart } = splitAtDot(t);
    return (intPart.padStart(intLen) + decPart).padEnd(colWidth);
  }
  // Integer token inside a float column: right-align at the decimal point position
  return t.padStart(intLen).padEnd(colWidth);
}

// ---------------------------------------------------------------------------
// Record group formatting
// ---------------------------------------------------------------------------

/**
 * Align a record group into columns. `indent`, when given, is the number of
 * leading spaces every row starts with (replacing whatever indent the records
 * had); when omitted the first record's existing indent is kept.
 */
export function formatRecordGroup(records: RecordLine[], indent?: number): string[] {
  const meta = computeColMeta(records);
  const groupIndent = indent !== undefined ? ' '.repeat(indent) : records[0].indent;
  return records.map(r => {
    const cells = r.tokens.map((t, c) => {
      const m = meta[c];
      if (!m.isNumeric) return t.padEnd(m.effectiveWidth);
      if (m.hasDecimal) return formatDecimalToken(t, m.maxIntLen, m.effectiveWidth);
      return t.padStart(m.effectiveWidth);
    });
    const body = groupIndent + cells.join(' ') + (r.hasTerminator ? ' /' : '');
    return r.trailComment ? `${body} ${r.trailComment}` : body;
  });
}

// ---------------------------------------------------------------------------
// UDQ expression group formatting
// ---------------------------------------------------------------------------

/** UDQ body control words that introduce a UDQ expression statement. */
const UDQ_CONTROL_WORDS = new Set(['DEFINE', 'ASSIGN', 'UNITS', 'UPDATE']);

/** A parsed UDQ statement of the form `control name expression /`. */
export interface UdqRecord {
  indent: string;
  control: string;
  name: string;
  /** Expression tokens, single-space joined; '' when there is none. */
  expr: string;
  hasTerminator: boolean;
  trailComment: string;
}

/** Split on whitespace while keeping quoted spans (and any glued punctuation,
 *  e.g. a trailing ')') intact, so the tokens re-join to the original text. */
function splitUdqTokens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= s.length) break;
    const start = i;
    let inQuote = false;
    while (i < s.length) {
      const c = s[i];
      if (c === "'") inQuote = !inQuote;
      else if (!inQuote && (c === ' ' || c === '\t')) break;
      i++;
    }
    out.push(s.substring(start, i));
  }
  return out;
}

/**
 * Parse a single UDQ statement line `control name expression /`. Returns null
 * when the line is not a UDQ statement (first token is not a control word, or
 * there is no name). Unlike `parseRecordLine`, a '/' inside the expression
 * (division, e.g. `1/(WWCT 'OP*')` or `(WGPR '*')/2000.0`) is NOT treated as
 * the terminator — only a space-delimited trailing '/' terminates the record.
 */
export function parseUdqExpressionLine(line: string): UdqRecord | null {
  const indent = line.match(/^[ \t]*/)![0];
  let rest = line.slice(indent.length);

  // Strip a trailing '--' comment (outside quotes).
  let trailComment = '';
  {
    let inQuote = false;
    for (let k = 0; k < rest.length - 1; k++) {
      const c = rest[k];
      if (c === "'") inQuote = !inQuote;
      else if (!inQuote && c === '-' && rest[k + 1] === '-') {
        trailComment = rest.slice(k).trimEnd();
        rest = rest.slice(0, k);
        break;
      }
    }
  }

  // The terminator is the last space-delimited (or line-start) '/' outside
  // quotes. Division operators are glued to a neighbour and so do not qualify.
  let termIdx = -1;
  {
    let inQuote = false;
    for (let k = 0; k < rest.length; k++) {
      const c = rest[k];
      if (c === "'") { inQuote = !inQuote; continue; }
      if (c === '/' && !inQuote) {
        const prev = k > 0 ? rest[k - 1] : ' ';
        if (prev === ' ' || prev === '\t') termIdx = k;
      }
    }
  }

  let hasTerminator = false;
  let body = rest;
  if (termIdx >= 0) {
    hasTerminator = true;
    const after = rest.slice(termIdx + 1).trim();
    if (after && !trailComment) trailComment = after;
    body = rest.slice(0, termIdx);
  }

  const tokens = splitUdqTokens(body);
  if (tokens.length < 2) return null;
  if (!UDQ_CONTROL_WORDS.has(tokens[0].toUpperCase())) return null;

  return {
    indent,
    control: tokens[0],
    name: tokens[1],
    expr: tokens.slice(2).join(' '),
    hasTerminator,
    trailComment,
  };
}

/**
 * Align a group of UDQ statements (`DEFINE`/`ASSIGN`/`UNITS`/`UPDATE` name
 * expression…). Three columns: the control word and the variable name both
 * left-aligned, and the expression right-aligned so every statement's
 * terminating '/' lines up. Expression tokens are single-space separated.
 */
export function formatUdqExpressionGroup(records: UdqRecord[], indent?: number): string[] {
  const ctrlWidth = Math.max(...records.map(r => r.control.length));
  const nameWidth = Math.max(...records.map(r => r.name.length));
  const maxExprLen = Math.max(0, ...records.map(r => r.expr.length));
  const groupIndent = indent !== undefined ? ' '.repeat(indent) : records[0].indent;
  // Width of the fixed left part: control word + separator + name column.
  const prefixLen = ctrlWidth + 1 + nameWidth;
  // Column at which the right-aligned expression ends (and the '/' follows).
  // The longest expression sits one space past the name column; shorter ones
  // are pushed right to share that terminator column.
  const exprEnd = maxExprLen > 0 ? prefixLen + 1 + maxExprLen : prefixLen;
  return records.map(r => {
    let body = groupIndent + r.control.padEnd(ctrlWidth) + ' ' + r.name.padEnd(nameWidth);
    if (r.expr) {
      const pad = Math.max(1, exprEnd - prefixLen - r.expr.length);
      body += ' '.repeat(pad) + r.expr;
    } else {
      body = body.trimEnd();
    }
    if (r.hasTerminator) body += ' /';
    return r.trailComment ? `${body} ${r.trailComment}` : body;
  });
}

/**
 * Align a contiguous UDQ block that may contain interspersed comment lines.
 * Comment lines are returned verbatim and do not participate in the column
 * computation; every UDQ statement in the block is aligned together (the
 * comment does not split the table), so all columns stay consistent across it.
 * Returns one output line per input line (same length). A single statement is
 * still aligned (it gets the configured indent and normalised spacing); an
 * empty block is returned unchanged.
 */
export function formatUdqBlock(lines: string[], indent?: number): string[] {
  const parsed = lines.map(parseUdqExpressionLine);
  const records = parsed.filter((r): r is UdqRecord => r !== null);
  if (records.length < 1) return lines.slice();
  const formatted = formatUdqExpressionGroup(records, indent);
  let idx = 0;
  return lines.map((line, i) => (parsed[i] !== null ? formatted[idx++] : line));
}

/**
 * Decide whether a comment line directly above a record group is that group's
 * column heading (one label per column) rather than a free-form descriptive
 * comment. A heading must be a `--` comment whose word count equals the group's
 * column count `nCols` (and there must be at least two columns).
 *
 * The exact-count rule is what keeps ordinary comment lines from being treated
 * as headings: a prose comment almost never has exactly one word per column,
 * and the caller only ever offers the line immediately above the table — a
 * comment elsewhere, or one separated by a blank line, is never considered.
 * Returns the heading words on a match, else null.
 */
export function matchHeadingForGroup(commentLine: string, nCols: number): string[] | null {
  if (nCols < 2) return null;
  const m = commentLine.match(/^\s*--\s*(\S.*)$/);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/).filter(Boolean);
  return words.length === nCols ? words : null;
}

// Parse absolute char positions of each word in a heading comment line (-- word1 word2 ...)
export function parseHeadingPositions(line: string): number[] | null {
  const m = line.match(/^(\s*--\s*)(.*)/);
  if (!m) return null;
  const offset = m[1].length;
  const rest = m[2];
  if (!rest.trim()) return null;
  const positions: number[] = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && rest[i] === ' ') i++;
    if (i >= rest.length) break;
    positions.push(offset + i);
    while (i < rest.length && rest[i] !== ' ') i++;
  }
  return positions.length >= 2 ? positions : null;
}

// Format a record group aligning columns to heading word positions
export function formatRecordGroupWithHeading(records: RecordLine[], headingPositions: number[]): string[] {
  const nCols = records[0].tokens.length;
  const meta = computeColMeta(records);

  // Compute actual column start positions; heading defines the minimum start
  const colStart: number[] = new Array(nCols).fill(0);
  colStart[0] = headingPositions[0] ?? 0;
  for (let c = 1; c < nCols; c++) {
    const prevEnd = colStart[c - 1] + meta[c - 1].effectiveWidth;
    const fromHeading = headingPositions[c] ?? (prevEnd + 1);
    colStart[c] = Math.max(fromHeading, prevEnd + 1);
  }

  return records.map(r => {
    let line = '';
    for (let c = 0; c < nCols; c++) {
      const t = r.tokens[c];
      const m = meta[c];
      let pos: number;
      if (!m.isNumeric) {
        pos = colStart[c];
      } else if (m.hasDecimal && !t.includes('*')) {
        const dotIdx = t.indexOf('.');
        if (dotIdx !== -1) {
          // Float token: decimal point at colStart[c] + maxIntLen
          pos = colStart[c] + m.maxIntLen - dotIdx;
        } else {
          // Integer in float column: right-align at decimal point position
          pos = colStart[c] + m.maxIntLen - t.length;
        }
      } else {
        // Integer or default token: right-align within effective column width
        pos = colStart[c] + m.effectiveWidth - t.length;
      }
      while (line.length < pos) line += ' ';
      line += t;
    }
    line = line.trimEnd() + (r.hasTerminator ? ' /' : '');
    return r.trailComment ? `${line} ${r.trailComment}` : line;
  });
}

// Build a heading comment and consistently aligned records in one pass
export function buildHeadingAndAlignedRecords(
  records: RecordLine[],
  names: string[],
  indent?: number,
): { heading: string; formattedRecords: string[] } {
  const nCols = records[0].tokens.length;
  const meta = computeColMeta(records);

  // Effective column width = max of data effective width and heading name width
  const colWidths = meta.map((m, c) => Math.max(m.effectiveWidth, names[c]?.length ?? 0));

  // Column start positions. `indent`, when given, is the number of leading
  // spaces every record row (and the heading's first column) starts with;
  // otherwise the first record's existing indent is kept.
  const baseIndent = indent !== undefined ? indent : records[0].indent.length;
  const colStarts: number[] = [baseIndent];
  for (let c = 1; c < nCols; c++) {
    colStarts[c] = colStarts[c - 1] + colWidths[c - 1] + 1;
  }

  // Build heading line — ensure at least one space before each name
  let heading = '--';
  for (let c = 0; c < nCols; c++) {
    const target = Math.max(colStarts[c], heading.length + 1);
    while (heading.length < target) heading += ' ';
    heading += names[c] ?? '';
  }

  // Build aligned record lines
  const formattedRecords = records.map(r => {
    let line = '';
    for (let c = 0; c < nCols; c++) {
      const t = r.tokens[c];
      const m = meta[c];
      let pos: number;
      if (!m.isNumeric) {
        pos = colStarts[c];
      } else if (m.hasDecimal && !t.includes('*')) {
        const dotIdx = t.indexOf('.');
        if (dotIdx !== -1) {
          pos = colStarts[c] + m.maxIntLen - dotIdx;
        } else {
          // Integer in float column: right-align at decimal point position
          pos = colStarts[c] + m.maxIntLen - t.length;
        }
      } else {
        pos = colStarts[c] + colWidths[c] - t.length;
      }
      while (line.length < pos) line += ' ';
      line += t;
    }
    line = line.trimEnd() + (r.hasTerminator ? ' /' : '');
    return r.trailComment ? `${line} ${r.trailComment}` : line;
  });

  return { heading, formattedRecords };
}
