// ---------------------------------------------------------------------------
// Pure analysis helpers shared by the diagnostics provider.
// Kept free of vscode imports so they can be unit-tested under jest.
// ---------------------------------------------------------------------------

import {
  tokenColumnCount,
  parseRecordLine,
  isCommentLine,
  KEYWORD_LINE_RE,
  SECTION_KEYWORD_SET,
} from './formatting';

export interface AnalysisEntry {
  name: string;
  expected_columns?: number;
  /** Authoritative section list (from opm-common when available). */
  sections?: string[];
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

/**
 * Walk a document and emit line-level diagnostics:
 *
 * - **Arity**: a record with more values than the keyword's per-record
 *   item count (from opm-common). Too-few values are not flagged because
 *   OPM Flow auto-defaults trailing positions before the `/`.
 * - **Section validity**: a keyword whose authoritative `sections` list
 *   does not include the section currently in scope.
 */
export function computeDiagnostics(
  lines: string[],
  index: AnalysisIndex,
): LineDiagnostic[] {
  const out: LineDiagnostic[] = [];
  let activeKw: AnalysisEntry | null = null;
  let currentSection: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isCommentLine(text)) continue;
    if (text.trim() === '') continue;

    const m = text.match(KEYWORD_LINE_RE);
    if (m) {
      const kw = m[1];

      if (SECTION_KEYWORD_SET.has(kw)) {
        currentSection = kw;
        activeKw = index[kw] ?? null;
        continue;
      }

      activeKw = index[kw] ?? null;

      // Section-validity check
      if (
        activeKw?.sections?.length &&
        currentSection &&
        !activeKw.sections.includes(currentSection)
      ) {
        const indent = text.length - text.trimStart().length;
        out.push({
          line: i,
          startChar: indent,
          endChar: indent + kw.length,
          message:
            `${kw} is not valid in ${currentSection}; valid in: ${activeKw.sections.join(', ')}.`,
        });
      }
      continue;
    }

    // Arity check on record lines
    if (!activeKw || !activeKw.expected_columns) continue;
    const rec = parseRecordLine(text);
    if (!rec) continue;

    let total = 0;
    for (const t of rec.tokens) total += tokenColumnCount(t);
    if (total > activeKw.expected_columns) {
      out.push({
        line: i,
        startChar: 0,
        endChar: text.length,
        message:
          `${activeKw.name}: record has ${total} values; expected at most ${activeKw.expected_columns}.`,
      });
    }
  }
  return out;
}
