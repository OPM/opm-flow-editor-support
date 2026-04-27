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

/** Record-arity classification carried over from opm-common's "size" field. */
export type SizeKind = 'none' | 'fixed' | 'list';

export interface AnalysisEntry {
  name: string;
  expected_columns?: number;
  /** Authoritative section list (from opm-common when available). */
  sections?: string[];
  /**
   * Record-arity kind:
   *   - 'none': the keyword takes no records and no terminating '/'.
   *   - 'fixed': a fixed number of records, each terminated by '/'.
   *   - 'list': an unbounded record list. Each record ends with '/' and
   *     the keyword block itself ends with a standalone '/' line.
   */
  size_kind?: SizeKind;
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
 *  followed by '--' comment). Such a line acts as the list terminator for
 *  a record-list keyword. */
function isStandaloneTerminator(line: string): boolean {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i >= line.length || line[i] !== '/') return false;
  i++;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i >= line.length) return true;
  return line[i] === '-' && line[i + 1] === '-';
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
 */
export function computeDiagnostics(
  lines: string[],
  index: AnalysisIndex,
): LineDiagnostic[] {
  const out: LineDiagnostic[] = [];
  let activeKw: AnalysisEntry | null = null;
  let activeKwLine = -1;
  let activeKwIndent = 0;
  let recordCount = 0;
  let lastRecordLine = -1;
  let lastRecordEndChar = 0;
  let listTerminatorSeen = false;
  let currentSection: string | null = null;

  const closeKw = (): void => {
    if (!activeKw) return;
    if (activeKw.size_kind === 'list' && !listTerminatorSeen) {
      // Anchor the squiggle at the end of the last record when we have one,
      // otherwise at the keyword name itself.
      const at = lastRecordLine >= 0 ? lastRecordLine : activeKwLine;
      const sc = lastRecordLine >= 0 ? lastRecordEndChar : activeKwIndent;
      const ec = lastRecordLine >= 0
        ? lastRecordEndChar + 1
        : activeKwIndent + activeKw.name.length;
      out.push({
        line: at,
        startChar: sc,
        endChar: ec,
        message: `${activeKw.name}: missing terminating '/' to close the record list.`,
      });
    }
    activeKw = null;
    activeKwLine = -1;
    activeKwIndent = 0;
    recordCount = 0;
    lastRecordLine = -1;
    lastRecordEndChar = 0;
    listTerminatorSeen = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isCommentLine(text)) continue;
    if (text.trim() === '') continue;

    // A line that is just '/' (with optional comment) is the list terminator.
    if (isStandaloneTerminator(text)) {
      if (activeKw?.size_kind === 'list') listTerminatorSeen = true;
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

      closeKw();
      activeKw = index[kw] ?? null;
      activeKwLine = i;
      activeKwIndent = text.length - text.trimStart().length;

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

    // Record line.
    if (!activeKw) continue;
    const tokens = tokenizeLine(text);
    if (tokens.length === 0) continue;

    const lastTok = tokens[tokens.length - 1];
    const hasTerm = lineHasRecordTerminator(text, lastTok.end);

    // Arity: too many values?
    if (activeKw.expected_columns) {
      let total = 0;
      let overflowStart = -1;
      for (const tok of tokens) {
        if (overflowStart === -1 && total + tok.columnCount > activeKw.expected_columns) {
          overflowStart = tok.start;
        }
        total += tok.columnCount;
      }
      if (total > activeKw.expected_columns) {
        out.push({
          line: i,
          startChar: overflowStart,
          endChar: lastTok.end,
          message:
            `${activeKw.name}: record has ${total} values; expected at most ${activeKw.expected_columns}.`,
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

    recordCount++;
    lastRecordLine = i;
    lastRecordEndChar = lastTok.end;
  }

  closeKw();
  return out;
}
