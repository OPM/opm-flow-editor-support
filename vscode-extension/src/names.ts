// ---------------------------------------------------------------------------
// Cross-keyword well / group name completion
// ---------------------------------------------------------------------------
//
// Many SCHEDULE keywords take a well or group name as their first item
// (WCONPROD, WCONINJE, WELOPEN, GCONPROD, …). The authoritative list of those
// names lives in the deck itself: wells are declared in WELSPECS (item 1), and
// groups in WELSPECS (item 2, the parent group) plus GRUPTREE (both the child
// and parent group items). This module provides the two pure pieces the
// completion provider wires into VS Code:
//
//   - classifyNameParam: decide whether a parameter is a well- or group-name
//     slot, by a heuristic on the opm-common item name (WELL / GROUP and their
//     spelling variants), guarded by value type and the absence of an enum.
//   - collectDeckNames: scan a deck's lines and harvest the declared well and
//     group names from WELSPECS / GRUPTREE.

import { tokenizeLine, isCommentLine, KEYWORD_LINE_COL1_RE } from './formatting';

export type NameKind = 'well' | 'group';

/** Minimal parameter shape the classifier needs. */
export interface NameParam {
  name?: string;
  value_type?: string;
  options?: string[];
}

// A well-name item: WELL, WELLS, WELNAME(S), WELLNAME, WELL_NAME — i.e. "WEL"
// or "WELL", optionally followed by "NAME"/"NAMES", optionally plural. Tested
// against the item name with underscores stripped and upper-cased, anchored so
// network/index variants (WELNETWK, WELL_SEGMENT, WELLBORE_VOL, MXWELS) are
// excluded.
const WELL_NAME_RE = /^WELL?(NAMES?)?S?$/;

// A group-name item: GROUP, GROUPS, GRPNAME(S), GROUP_NAME — "GRP" or "GROUP",
// optionally followed by "NAME"/"NAMES", optionally plural. Excludes group
// *attribute* items (GRPCNTL, GRPNETWK, GRPREIN, …) that merely start with GRP.
const GROUP_NAME_RE = /^GR(OU)?P(NAMES?)?S?$/;

/**
 * Classify a parameter as a well- or group-name slot, or null when it is
 * neither. Enum parameters (those with `options`) are never name slots — the
 * value-completion path already offers their fixed vocabulary — and only
 * string-typed items qualify (an INT `MXWELS` count is not a name).
 */
export function classifyNameParam(param: NameParam): NameKind | null {
  if (param.options && param.options.length) return null;
  const vt = param.value_type;
  if (vt && vt !== 'STRING' && vt !== 'RAW_STRING') return null;
  const name = (param.name || '').toUpperCase().replace(/_/g, '');
  if (!name) return null;
  if (WELL_NAME_RE.test(name)) return 'well';
  if (GROUP_NAME_RE.test(name)) return 'group';
  return null;
}

export interface DeckNames {
  wells: string[];
  groups: string[];
}

/** Strip surrounding single quotes from a deck token, trimming inner padding. */
function unquote(token: string): string {
  if (token.startsWith("'")) return token.replace(/^'|'$/g, '').trim();
  return token;
}

/** A token usable as a name: non-empty and not a default placeholder (`1*`, `*`). */
function isUsableName(token: string): boolean {
  if (!token) return false;
  if (token === '*' || /^\d+\*$/.test(token)) return false;
  return true;
}

/**
 * Harvest the well and group names declared across a deck's lines.
 *
 *   - WELSPECS: item 1 is the well name, item 2 the parent group.
 *   - GRUPTREE: item 1 is the child group, item 2 the parent group.
 *
 * Both keywords are record lists terminated by a standalone `/`. Names may be
 * quoted or bare, and records may be indented. `isKnownKeyword` lets the scan
 * end a block early on the next recognised keyword — without it, an unquoted
 * single-name record such as `OP01 /` (all later items defaulted) looks just
 * like a bare keyword declaration, so we only treat a column-1 keyword-shaped
 * line as a real keyword when it is one.
 *
 * Returns names sorted and de-duplicated.
 */
export function collectDeckNames(
  lines: string[],
  isKnownKeyword: (token: string) => boolean,
): DeckNames {
  const wells = new Set<string>();
  const groups = new Set<string>();
  let active: 'WELSPECS' | 'GRUPTREE' | null = null;

  for (const raw of lines) {
    if (isCommentLine(raw)) continue;
    const trimmed = raw.trim();
    if (trimmed === '') continue;

    const m = raw.match(KEYWORD_LINE_COL1_RE);
    if (m) {
      const token = m[1];
      // Inside a name block a `NAME /` record matches the bare-keyword shape;
      // only switch blocks when the token is genuinely a keyword.
      if (!active || isKnownKeyword(token)) {
        active = token === 'WELSPECS' || token === 'GRUPTREE' ? token : null;
        continue;
      }
      // else: fall through and treat this line as a record of the open block.
    }

    if (!active) continue;
    if (trimmed === '/') {
      active = null;
      continue;
    }

    const tokens = tokenizeLine(raw);
    if (!tokens.length) continue;
    const first = unquote(tokens[0].text);
    const second = tokens[1] ? unquote(tokens[1].text) : '';

    if (active === 'WELSPECS') {
      if (isUsableName(first)) wells.add(first);
      if (isUsableName(second)) groups.add(second);
    } else {
      if (isUsableName(first)) groups.add(first);
      if (isUsableName(second)) groups.add(second);
    }
  }

  return {
    wells: [...wells].sort(),
    groups: [...groups].sort(),
  };
}
