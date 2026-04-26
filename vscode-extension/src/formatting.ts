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

    const repeatMatch = text.match(/^(\d+)\*$/);
    const columnCount = repeatMatch ? parseInt(repeatMatch[1]) : 1;
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

// ---------------------------------------------------------------------------
// Record line parser
// ---------------------------------------------------------------------------

export const NUMERIC_TOKEN_RE = /^(\*|\d+\*|[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)$/;

export const KEYWORD_TOKEN_RE = /^[A-Z][A-Z0-9_+-]*$/;

/** Matches a line that is just a keyword declaration (with optional trailing
 *  comment or `/`), as opposed to a record line. */
export const KEYWORD_LINE_RE = /^\s*([A-Z][A-Z0-9_+-]{1,})\s*(?:--|\/\s*(?:--|$)|$)/;

/** The eight section-marker keywords, in canonical OPM Flow order. */
export const SECTION_KEYWORDS = [
  'RUNSPEC', 'GRID', 'EDIT', 'PROPS', 'REGIONS',
  'SOLUTION', 'SUMMARY', 'SCHEDULE',
] as const;

export const SECTION_KEYWORD_SET: ReadonlySet<string> = new Set(SECTION_KEYWORDS);

/** Number of parameter columns a record token represents (N for "N*", 1 otherwise). */
export function tokenColumnCount(token: string): number {
  const m = token.match(/^(\d+)\*$/);
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
  if (rest && !rest.startsWith('--')) return null;
  return { indent, tokens, trailComment: rest, hasTerminator };
}

export function isCommentLine(line: string): boolean {
  return /^\s*--/.test(line);
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

export function formatRecordGroup(records: RecordLine[]): string[] {
  const meta = computeColMeta(records);
  const groupIndent = records[0].indent;
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
  names: string[]
): { heading: string; formattedRecords: string[] } {
  const nCols = records[0].tokens.length;
  const meta = computeColMeta(records);

  // Effective column width = max of data effective width and heading name width
  const colWidths = meta.map((m, c) => Math.max(m.effectiveWidth, names[c]?.length ?? 0));

  // Column start positions
  const baseIndent = records[0].indent.length;
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
