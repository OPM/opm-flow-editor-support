// Keyword boilerplate snippet generation.
//
// Produces VS Code snippet syntax (``${1:value}`` tabstops, ``$0`` final
// cursor) for a sample data record so accepting a keyword completion drops in
// a correctly-shaped, type-appropriate record rather than just the bare name.
//
// Kept free of vscode imports so it can be unit-tested under jest.

export type SizeKind = 'none' | 'fixed' | 'list' | 'array';
export type StringValueStyle = 'both' | 'quoted' | 'unquoted';

/** Structural subset of the loaded ``Parameter`` shape (see extension.ts). */
export interface SnippetParam {
  /** 1-based column, or a grouped range string ("3-52") for variadic spans. */
  index: number | string;
  /** opm-common value type: INT | DOUBLE | STRING | RAW_STRING | UDA. */
  value_type?: string;
  /** Manual default value, or the literal string "None" when absent. */
  default?: string;
  /** 1-based record number for multi-record keywords. */
  record?: number;
}

/** Structural subset of the loaded ``KeywordEntry`` shape (see extension.ts). */
export interface SnippetKeyword {
  name: string;
  size_kind?: SizeKind;
  size_count?: number;
  parameters?: SnippetParam[];
}

const RECORD_INDENT = '    '; // 4 spaces — matches the deck format convention.

/** True when a manual ``default`` carries a usable value (not absent). */
function hasDefault(d: string | undefined): d is string {
  return !!d && d !== 'None' && d.trim() !== '';
}

/** Escape the characters that carry meaning inside a VS Code snippet so a
 *  literal value can't corrupt the surrounding `${n:…}` placeholder. */
function escapeSnippet(text: string): string {
  return text.replace(/[\\$}]/g, '\\$&');
}

/** The placeholder text for one parameter: its manual default when present,
 *  otherwise a dummy value of the correct type. */
function sampleValue(p: SnippetParam, style: StringValueStyle): string {
  if (hasDefault(p.default)) return escapeSnippet(p.default.trim());
  switch (p.value_type) {
    case 'INT':
      return '1';
    case 'DOUBLE':
      return '0.0';
    case 'STRING':
    case 'RAW_STRING':
      return style === 'unquoted' ? 'STRING' : "'STRING'";
    case 'UDA':
      return '1*';
    default:
      return '1*';
  }
}

/** Parameters belonging to the single sample record we generate — the first
 *  record for multi-record keywords, plus any record-less (shared) params. */
function sampleRecordParams(params: SnippetParam[]): SnippetParam[] {
  const numbered = params.map(p => p.record).filter((r): r is number => r != null);
  if (numbered.length === 0) return params;
  const first = Math.min(...numbered);
  return params.filter(p => p.record == null || p.record === first);
}

/**
 * Build a VS Code snippet for ``entry`` whose shape follows ``size_kind``:
 *   - none  -> the keyword alone (activation keyword, no record, no '/').
 *   - fixed -> keyword + one indented record line ending ' /'.
 *   - list  -> keyword + one record line ' /' + a standalone '/' terminator.
 *   - array -> keyword + one indented value line ending ' /'.
 *
 * Each value is a numbered tabstop so TAB cycles through them; ``$0`` lands
 * after the inserted block.
 */
export function buildKeywordSnippet(entry: SnippetKeyword, style: StringValueStyle = 'quoted'): string {
  const name = entry.name;
  const kind = entry.size_kind ?? 'none';
  const params = entry.parameters ?? [];

  if (kind === 'none' || params.length === 0) {
    // Activation keyword (or a keyword we have no parameter data for): just
    // the name. Still a snippet so the final cursor is positioned cleanly.
    return `${name}\n$0`;
  }

  let tab = 0;
  const record = sampleRecordParams(params)
    .map(p => `\${${++tab}:${sampleValue(p, style)}}`)
    .join(' ');

  if (kind === 'list') {
    // One sample record, then the block terminator on its own line.
    return `${name}\n${RECORD_INDENT}${record} /\n/\n$0`;
  }

  // 'fixed' and 'array' both: keyword + a single terminated record line.
  return `${name}\n${RECORD_INDENT}${record} /\n$0`;
}
