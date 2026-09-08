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

import * as path from 'path';
import { findFileReferences } from './links';

/**
 * Candidate `.PRT` print-file paths for a deck file, most-preferred first.
 * OPM Flow writes ``<CASE>.PRT`` next to ``<CASE>.DATA`` after a run. The
 * extension casing varies by platform, so we offer the conventional
 * uppercase form first and the lowercase form as a fallback; the caller
 * picks whichever exists on disk. Returns an empty array for an input with
 * no recognisable basename.
 */
export function prtCandidatePaths(deckFsPath: string): string[] {
  if (!deckFsPath) return [];
  const dir = path.dirname(deckFsPath);
  const ext = path.extname(deckFsPath);
  const base = path.basename(deckFsPath, ext);
  if (!base) return [];
  return ['.PRT', '.prt'].map(e => path.join(dir, base + e));
}

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

/**
 * Collect the absolute paths of all files reachable from a root deck file
 * by following INCLUDE references, recursively. The root file itself is
 * always the first entry. Files are visited at most once (cycles are broken).
 *
 * `readLines` is a callback that returns the lines of a file given its
 * absolute path, or `null` when the file cannot be read. This indirection
 * keeps the function free of filesystem imports so it can be unit-tested.
 *
 * Only INCLUDE references are followed; IMPORT / RESTART / GDFILE are not
 * include-file chains and are left alone.
 *
 * `resolveLink` maps a resolved include path to the file it stands for, so a
 * symlink surrogate is walked through rather than parsed as deck text.
 * It defaults to the identity, leaving paths untouched.
 */
export function collectDeckIncludeFiles(
  rootFsPath: string,
  readLines: (fsPath: string) => string[] | null,
  visited: Set<string> = new Set(),
  resolveLink: (fsPath: string) => string = p => p,
): string[] {
  if (visited.has(rootFsPath)) return [];
  visited.add(rootFsPath);

  const results: string[] = [rootFsPath];
  const lines = readLines(rootFsPath);
  if (!lines) return results;

  const aliases = parsePathsAliases(lines);
  const refs = findFileReferences(lines);
  const dir = path.dirname(rootFsPath);

  for (const ref of refs) {
    if (ref.keyword !== 'INCLUDE') continue;
    const resolved = resolvePathAlias(ref.rawPath, aliases);
    const absPath = resolveLink(path.resolve(dir, resolved));
    const sub = collectDeckIncludeFiles(absPath, readLines, visited, resolveLink);
    results.push(...sub);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Symlink surrogates
//
// A symlink made on Linux does not always survive the crossing to Windows.
// Where it does not, what arrives in its place is an ordinary file holding
// the target path, and the editor shows that path string instead of the file
// it stands for. Two shapes are known to reach a Windows client:
//
//   * Minshall+French, written by the Linux CIFS client when a share is
//     mounted with `mfsymlinks`. A fixed 1067-byte file: the header `XSym`,
//     the target length, an MD5 of the target, then the target itself. A
//     Windows client has no idea what it means and shows the raw header.
//   * A bare target path, from a copy or export that flattened the link.
//     Whether a trailing newline survives depends on what did the copying,
//     so one is tolerated.
//
// Both are recognised below. A symlink the file server resolves on our
// behalf never reaches here, and one the server refuses to follow — a target
// outside the share, with `wide links` off — leaves nothing on disk to find,
// so neither is this code's business.
// ---------------------------------------------------------------------------

/** A file that large cannot plausibly be a stored path. */
const MAX_SURROGATE_BYTES = 4096;
/** Cap on following surrogate-to-surrogate chains, so a cycle cannot hang. */
const MAX_SURROGATE_HOPS = 8;

// Minshall+French layout: 'XSym\n', '%04u\n' target length, 32-char MD5 plus
// a newline, then the target padded out to a fixed total size.
const MF_MAGIC = 'XSym\n';
const MF_LENGTH_OFFSET = 5;
const MF_TARGET_OFFSET = 43;
const MF_MAX_TARGET = 1024;

/**
 * The target path a surrogate stands for, or null when the content is not a
 * surrogate at all.
 */
function parseSurrogateTarget(text: string): string | null {
  if (text.startsWith(MF_MAGIC)) {
    const declared = Number.parseInt(text.slice(MF_LENGTH_OFFSET, MF_LENGTH_OFFSET + 4), 10);
    if (!Number.isInteger(declared) || declared <= 0 || declared > MF_MAX_TARGET) return null;
    const target = text.slice(MF_TARGET_OFFSET, MF_TARGET_OFFSET + declared);
    // Trust the header only if it described something whole.
    if (target.length !== declared) return null;
    return target;
  }

  // A bare path. One trailing newline is allowed, since a copy may have added
  // one, but anything else — inner line breaks, leading or trailing spaces —
  // means this is deck text rather than a stored path.
  const body = text.replace(/\r?\n$/, '');
  if (body === '' || body !== body.trim()) return null;
  if (/[\r\n]/.test(body)) return null;
  return body;
}

/** Filesystem access needed to recognise a surrogate, injected for testing. */
export interface SurrogateFs {
  /** Size of a regular file, or null when missing or not a regular file. */
  statFileSize(fsPath: string): number | null;
  /** Full text of a file, or null when it cannot be read. */
  readText(fsPath: string): string | null;
  /** Whether the path exists and is a directory. */
  isDirectory(fsPath: string): boolean;
}

/**
 * Follow one path component through any surrogate chain standing at it.
 *
 * `wantFile` says what the component has to end up being: the last component
 * of a path names a file, every earlier one names a directory. Checking the
 * kind rather than mere existence is what stops a genuine one-line fragment
 * from being read as a link — a fragment holding just `/` names the drive
 * root, which exists but is not a file.
 *
 * Returns `fsPath` unchanged when it is not a surrogate, or when the chain
 * does not end in something of the required kind.
 */
function followSurrogate(fsPath: string, fsApi: SurrogateFs, wantFile: boolean): string {
  let current = fsPath;
  const seen = new Set<string>([current]);

  for (let hop = 0; hop < MAX_SURROGATE_HOPS; hop++) {
    const size = fsApi.statFileSize(current);
    if (size === null || size === 0 || size > MAX_SURROGATE_BYTES) break;

    const text = fsApi.readText(current);
    if (text === null) break;
    const stored = parseSurrogateTarget(text);
    if (stored === null) break;

    // The stored path is POSIX whatever wrote it; resolve brings it back
    // into the host's own form.
    const target = path.resolve(path.dirname(current), stored);
    if (target === current || seen.has(target)) break;

    const targetIsDir = fsApi.isDirectory(target);
    if (!targetIsDir && fsApi.statFileSize(target) === null) break;

    seen.add(target);
    current = target;
    // A directory is never itself a surrogate, so the chain ends here.
    if (targetIsDir) break;
  }

  if (current === fsPath) return fsPath;
  const ok = wantFile ? fsApi.statFileSize(current) !== null : fsApi.isDirectory(current);
  return ok ? current : fsPath;
}

/**
 * Follow `fsPath` to the file it stands for, resolving a symlink
 * surrogate at any component of the path, not only at the end.
 *
 * Symlinking a whole `include/` directory is the common layout in a shared
 * deck, and then the INCLUDE paths below it name nothing that exists on a
 * Windows checkout — the directory is a file. Each component is therefore
 * resolved in turn and the rest of the path rebuilt onto the result.
 *
 * Paths that hold no surrogate come back unchanged.
 */
export function resolveSymlinkSurrogate(fsPath: string, fsApi: SurrogateFs): string {
  const absolute = path.resolve(fsPath);
  const { root, dir, base } = path.parse(absolute);
  if (!base) return absolute;

  const segments = dir
    .slice(root.length)
    .split(/[\\/]/)
    .filter(s => s !== '');
  segments.push(base);

  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = followSurrogate(
      path.join(current, segments[i]),
      fsApi,
      i === segments.length - 1,
    );
  }
  return current;
}
