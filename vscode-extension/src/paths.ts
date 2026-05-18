// ---------------------------------------------------------------------------
// Pure helpers for OPM Flow PATHS keyword alias resolution.
//
// PATHS lets a deck define short alias names that stand in for directory
// paths, then reference them with a `$`-prefix in INCLUDE / IMPORT / RESTART
// / GDFILE filenames. Example:
//
//   PATHS
//    'INCLUDEPATH' '../include' /
//   /
//
//   INCLUDE
//    '$INCLUDEPATH/grid/PERM.grdecl' /
//
// Kept free of vscode imports so they can be unit-tested under jest.
// ---------------------------------------------------------------------------

const PATHS_KW_RE = /^\s*PATHS\b/;
// A PATHS record: 'ALIAS' 'expansion' /  (trailing '/' optional, may be
// followed by a '--' comment).
const PATHS_RECORD_RE = /^\s*'([^']+)'\s+'([^']+)'/;
// Standalone-'/' line that closes the PATHS record list.
const STANDALONE_TERM_RE = /^\s*\/\s*(--.*)?$/;
// $ALIAS or $(ALIAS) anchored at the start of a path. ALIAS is a C-style
// identifier: starts with a letter or underscore, followed by letters,
// digits, or underscores. The braced form lets the alias be followed by
// further identifier characters without ambiguity.
const ALIAS_REF_RE = /^\$(?:\(([A-Za-z_][A-Za-z0-9_]*)\)|([A-Za-z_][A-Za-z0-9_]*))/;

/**
 * Extract `ALIAS -> expansion` mappings from every PATHS block in the deck.
 * Later definitions override earlier ones, matching OPM Flow's behaviour of
 * applying the most recently seen alias.
 */
export function parsePathsAliases(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let inBlock = false;
  for (const text of lines) {
    if (/^\s*--/.test(text) || text.trim() === '') continue;
    if (!inBlock) {
      if (PATHS_KW_RE.test(text)) inBlock = true;
      continue;
    }
    if (STANDALONE_TERM_RE.test(text)) {
      inBlock = false;
      continue;
    }
    const m = PATHS_RECORD_RE.exec(text);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Substitute a leading `$ALIAS` or `$(ALIAS)` in `rawPath` with the
 * expansion from `aliases`. If the alias is not defined the path is returned
 * unchanged — the resulting link will fail to open, which is the right
 * signal that the alias is missing or mistyped.
 */
export function resolvePathAlias(
  rawPath: string,
  aliases: ReadonlyMap<string, string>,
): string {
  const m = ALIAS_REF_RE.exec(rawPath);
  if (!m) return rawPath;
  const name = m[1] ?? m[2];
  const expansion = aliases.get(name);
  if (expansion === undefined) return rawPath;
  return expansion + rawPath.slice(m[0].length);
}
