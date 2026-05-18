// ---------------------------------------------------------------------------
// Pure helpers for resolving file-reference links in OPM Flow decks.
//
// Several OPM Flow keywords open another file via a first-record quoted
// filename: INCLUDE pulls in another deck fragment, IMPORT reads a grid
// import file, RESTART references a prior simulation's root name, and
// GDFILE references a GRID/EGRID file. All four follow the same shape —
// the keyword sits on its own line and the path is the first quoted token
// on the next non-blank, non-comment line.
//
// Kept free of vscode imports so they can be unit-tested under jest.
// ---------------------------------------------------------------------------

/** Keywords whose first record value is a path to another file. */
export const FILE_LINK_KEYWORDS = ['INCLUDE', 'IMPORT', 'RESTART', 'GDFILE'] as const;
export type FileLinkKeyword = (typeof FILE_LINK_KEYWORDS)[number];

// Matches the keyword on its own line. Anything that follows must be blank,
// a comment, or a degenerate '/' — the actual path lives on a later line.
const FILE_LINK_KW_RES: ReadonlyArray<readonly [FileLinkKeyword, RegExp]> =
  FILE_LINK_KEYWORDS.map(kw =>
    [kw, new RegExp(`^\\s*${kw}\\s*(?:--|\\/\\s*(?:--|$)|$)`)] as const,
  );
const FILE_PATH_RE = /^\s*'([^']+)'/;
// How far past the keyword line to scan for the quoted path. Real decks
// place the path on the very next line, possibly preceded by a blank or
// comment; four lines is generous slack.
const MAX_LOOKAHEAD = 4;

export interface FileReference {
  /** Which keyword introduced this reference. */
  keyword: FileLinkKeyword;
  /** Zero-based line of the quoted path. */
  line: number;
  /** Zero-based char range of the quoted path's *contents* (inside the quotes). */
  startChar: number;
  endChar: number;
  /** The raw text between the quotes. May contain a `$ALIAS` prefix that the
   *  caller still needs to resolve before turning into an absolute path. */
  rawPath: string;
}

/**
 * Scan a deck for INCLUDE / IMPORT / RESTART / GDFILE file references.
 * Returns one entry per keyword occurrence that has a quoted path on a
 * following line.
 */
export function findFileReferences(lines: string[]): FileReference[] {
  const out: FileReference[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let matched: FileLinkKeyword | null = null;
    for (const [kw, re] of FILE_LINK_KW_RES) {
      if (re.test(line)) {
        matched = kw;
        break;
      }
    }
    if (!matched) continue;

    for (let j = i + 1; j < Math.min(i + MAX_LOOKAHEAD, lines.length); j++) {
      const nextLine = lines[j];
      if (/^\s*(--|$)/.test(nextLine)) continue;
      const m = FILE_PATH_RE.exec(nextLine);
      if (!m) break;
      const rawPath = m[1];
      const startChar = nextLine.indexOf("'") + 1;
      out.push({
        keyword: matched,
        line: j,
        startChar,
        endChar: startChar + rawPath.length,
        rawPath,
      });
      break;
    }
  }
  return out;
}
