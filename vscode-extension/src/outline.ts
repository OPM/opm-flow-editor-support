// ---------------------------------------------------------------------------
// Pure document-outline model for the keyword navigation tree.
// Kept free of vscode imports so it can be unit-tested under jest, mirroring
// the section -> keyword structure used by the folding range provider.
// ---------------------------------------------------------------------------

import { KEYWORD_LINE_COL1_RE, SECTION_KEYWORD_SET } from './formatting';

export interface OutlineNode {
  /** Keyword token as written in the deck (always column-1, uppercase). */
  name: string;
  /** Zero-based document line where the keyword starts — used for reveal. */
  line: number;
  kind: 'section' | 'keyword';
  /** Populated for section nodes; always empty for keyword leaves. */
  children: OutlineNode[];
}

/**
 * Build a two-level outline from deck lines:
 *
 *   section (RUNSPEC, GRID, …) -> keyword leaves between section headers
 *
 * The walk mirrors `OpmFlowFoldingRangeProvider`: only column-1 declarations
 * (`KEYWORD_LINE_COL1_RE`) count, comment lines are skipped, and `END` closes
 * the current section so any trailing keywords fall back to the synthetic
 * root. Keywords appearing before the first section header (e.g. in an
 * include file with no section marker) are attached directly to the root so
 * nothing is dropped.
 */
export function buildOutline(lines: string[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  let current: OutlineNode | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (text.trim().startsWith('--')) continue;

    const m = text.match(KEYWORD_LINE_COL1_RE);
    if (!m) continue;
    const kw = m[1];

    if (SECTION_KEYWORD_SET.has(kw)) {
      current = { name: kw, line: i, kind: 'section', children: [] };
      roots.push(current);
    } else if (kw === 'END') {
      current = null;
    } else {
      const node: OutlineNode = { name: kw, line: i, kind: 'keyword', children: [] };
      if (current) current.children.push(node);
      else roots.push(node);
    }
  }

  return roots;
}
