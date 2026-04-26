// ---------------------------------------------------------------------------
// Pure analysis helpers shared by the diagnostics provider.
// Kept free of vscode imports so they can be unit-tested under jest.
// ---------------------------------------------------------------------------

import {
  tokenColumnCount,
  parseRecordLine,
  isCommentLine,
} from './formatting';

export interface AnalysisEntry {
  name: string;
  expected_columns?: number;
}

export type AnalysisIndex = Record<string, AnalysisEntry>;

const KEYWORD_LINE_RE = /^\s*([A-Z][A-Z0-9_+-]{1,})\s*(?:--|\/\s*(?:--|$)|$)/;

export interface ArityDiagnostic {
  /** Zero-based document line. */
  line: number;
  /** Zero-based char range covering the whole record line. */
  startChar: number;
  endChar: number;
  /** Human-readable message ready for VS Code. */
  message: string;
}

/**
 * Walk a document line-by-line and flag record lines with more values than
 * the keyword's per-record arity (from opm-common). Too-few values are NOT
 * an error — OPM Flow auto-defaults trailing positions before the `/`.
 */
export function computeArityDiagnostics(
  lines: string[],
  index: AnalysisIndex,
): ArityDiagnostic[] {
  const out: ArityDiagnostic[] = [];
  let activeKw: AnalysisEntry | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isCommentLine(text)) continue;
    if (text.trim() === '') continue;

    const m = text.match(KEYWORD_LINE_RE);
    if (m) {
      activeKw = index[m[1]] ?? null;
      continue;
    }

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
