import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  tokenizeLine,
  columnAtCursor,
  columnForCompletion,
  RecordLine,
  parseRecordLine,
  isCommentLine,
  KEYWORD_LINE_COL1_RE,
  SECTION_KEYWORDS,
  matchSectionLine,
  formatRecordGroup,
  parseHeadingPositions,
  formatRecordGroupWithHeading,
  buildHeadingAndAlignedRecords,
  tokenColumnCount,
  toggleLineComments,
} from './formatting';
import { computeDiagnostics, DiagnosticCode } from './analysis';
import { buildOutline, OutlineNode } from './outline';
import { findFileReferences } from './links';
import { parsePathsAliases, resolvePathAlias, prtCandidatePaths } from './paths';
import { DEFAULT_DIAGNOSTICS_EXCLUDED_KEYWORDS } from './diagnostics-exclusions';
import { buildKeywordSnippet } from './boilerplate';

interface Parameter {
  index: number | string;
  name: string;
  description: string;
  units: { field?: string; metric?: string; laboratory?: string };
  default: string;
  value_type?: string;        // INT | DOUBLE | STRING | RAW_STRING | UDA
  dimension?: string | string[]; // Length | Pressure | Time | … (may be a list for multi-column items)
  options?: string[];         // valid string values (extracted from the manual)
  /** 1-based record number for multi-record keywords (WELSEGS, VFPPROD, …). */
  record?: number;
}

interface RecordMeta {
  expected_columns?: number;
}

interface KeywordEntry {
  name: string;
  sections: string[];
  supported: boolean | null;
  summary: string;
  parameters: Parameter[];
  example: string;
  /** Per-record arity from opm-common; absent for keywords lacking parser data. */
  expected_columns?: number;
  /**
   * Per-record metadata for multi-record keywords. When present,
   * ``expected_columns`` is omitted and arity / column lookup must use
   * ``records_meta[record-1].expected_columns`` for the active record.
   */
  records_meta?: RecordMeta[];
  /** Record-arity kind — drives missing-'/'-terminator diagnostics. */
  size_kind?: 'none' | 'fixed' | 'list' | 'array';
  /** For `size_kind: 'fixed'`, the number of records the keyword expects. */
  size_count?: number;
  /**
   * True for SUMMARY-section *templates*: the user appends a tracer or
   * component name to form the actual deck keyword (FTPR -> FTPRSEA).
   * Docs/hover lookups fall back to the shortest matching template
   * when the literal token isn't in the index.
   */
  templated?: boolean;
}

type KeywordIndex = Record<string, KeywordEntry>;

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadKeywordIndex(context: vscode.ExtensionContext): KeywordIndex {
  const indexPath = path.join(context.extensionPath, 'data', 'keyword_index_compact.json');
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    return JSON.parse(raw) as KeywordIndex;
  } catch (e) {
    console.error('OPM Flow: failed to load keyword index', e);
    return {};
  }
}

/**
 * Load the open-ended summary-vector regex families (UDQ, tracer, water-cut
 * mnemonics) emitted alongside the index from opm-common's `deck_name_regex`.
 * Each source pattern is anchored so a deck token must match in full.
 */
function loadSummaryPatterns(context: vscode.ExtensionContext): RegExp[] {
  const p = path.join(context.extensionPath, 'data', 'summary_name_patterns.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as string[];
    return raw.map(src => new RegExp(`^(?:${src})$`));
  } catch (e) {
    console.error('OPM Flow: failed to load summary-vector patterns', e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Backward keyword scanner
// ---------------------------------------------------------------------------

function findActiveKeyword(document: vscode.TextDocument, position: vscode.Position): string | null {
  for (let lineNum = position.line; lineNum >= 0; lineNum--) {
    const text = document.lineAt(lineNum).text;
    if (text.trim().startsWith('--')) continue;
    const m = text.match(KEYWORD_LINE_COL1_RE);
    if (m) return m[1];
  }
  return null;
}

/**
 * Locate the keyword line for the keyword that owns `position`. Returns
 * -1 when no keyword precedes the position.
 */
function findActiveKeywordLine(
  document: vscode.TextDocument,
  position: vscode.Position,
): number {
  for (let lineNum = position.line; lineNum >= 0; lineNum--) {
    const text = document.lineAt(lineNum).text;
    if (text.trim().startsWith('--')) continue;
    if (KEYWORD_LINE_COL1_RE.test(text)) return lineNum;
  }
  return -1;
}

/**
 * For a multi-record keyword, return the 1-based record number the cursor
 * line belongs to. Records advance on each line whose last non-comment
 * character is '/'; the count is capped at ``records_meta.length`` so the
 * trailing variadic record absorbs all subsequent lines.
 *
 * Returns 1 for single-record keywords (no records_meta) so callers can
 * always use the result.
 */
function findActiveRecord(
  document: vscode.TextDocument,
  entry: KeywordEntry,
  position: vscode.Position,
): number {
  if (!entry.records_meta?.length) return 1;
  const kwLine = findActiveKeywordLine(document, position);
  if (kwLine < 0) return 1;
  const total = entry.records_meta.length;
  let record = 1;
  for (let ln = kwLine + 1; ln < position.line; ln++) {
    const text = document.lineAt(ln).text;
    if (isCommentLine(text) || text.trim() === '') continue;
    // Strip trailing '-- comment' before checking for the trailing '/'.
    const noComment = text.replace(/\s*--.*$/, '').trimEnd();
    if (noComment.endsWith('/')) {
      record = Math.min(record + 1, total);
    }
  }
  return record;
}

/** Filter a parameter table by record (when known) before matching by index. */
function findParam(
  entry: KeywordEntry,
  record: number,
  predicate: (p: Parameter) => boolean,
): Parameter | undefined {
  const candidates = entry.records_meta
    ? entry.parameters.filter(p => (p.record ?? 1) === record)
    : entry.parameters;
  return candidates.find(predicate);
}

function findCurrentSection(document: vscode.TextDocument, position: vscode.Position): string | null {
  for (let lineNum = position.line; lineNum >= 0; lineNum--) {
    const text = document.lineAt(lineNum).text;
    if (text.trim().startsWith('--')) continue;
    // Tolerate trailing decoration after the section name (`GRID ======`).
    const section = matchSectionLine(text);
    if (section) return section.name;
  }
  return null;
}

const TEMPLATE_SUFFIX_RE = /^[A-Z0-9]+$/;

/**
 * Resolve a keyword token to its index entry, falling back to the
 * shortest templated entry whose name is a strict prefix (with a
 * ``[A-Z0-9]+`` suffix). Mirrors the diagnostics engine's lookupEntry
 * so docs/hover on a templated SUMMARY mnemonic like ``FTPRSEA`` find
 * the base ``FTPR`` template entry.
 */
function resolveKeyword(index: KeywordIndex, kw: string): KeywordEntry | undefined {
  const direct = index[kw];
  if (direct) return direct;
  let best: KeywordEntry | undefined;
  let bestLen = Infinity;
  for (const name in index) {
    if (name.length >= bestLen) continue;
    if (name.length >= kw.length) continue;
    if (!kw.startsWith(name)) continue;
    const entry = index[name];
    if (!entry?.templated) continue;
    if (!TEMPLATE_SUFFIX_RE.test(kw.slice(name.length))) continue;
    best = entry;
    bestLen = name.length;
  }
  return best;
}

// ---------------------------------------------------------------------------
// HTML builder for the sidebar docs panel
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paramTypeLabel(p: Parameter): string {
  const dim = Array.isArray(p.dimension) ? p.dimension.join(', ') : (p.dimension || '');
  if (p.value_type && dim) return `${p.value_type} (${dim})`;
  return p.value_type || dim || '';
}

/** HTML-escape a string and insert <wbr> break opportunities after every
 *  `/`, `*`, `_` so dense unit/dimension labels can wrap inside narrow
 *  table cells without the browser breaking mid-word arbitrarily. */
function escWithBreaks(s: string): string {
  return escHtml(s).replace(/([\/_*])/g, '$1<wbr>');
}

function nonce(): string {
  return crypto.randomBytes(8).toString('hex');
}

interface DocColumns {
  type: boolean;
  field: boolean;
  metric: boolean;
  lab: boolean;
  default: boolean;
  /**
   * 'columns'  — render Type / units / Default as separate table columns
   *              (the original layout).
   * 'embedded' — fold that metadata into a muted sub-line under each
   *              description, giving the Description far more width. The
   *              same show/hide flags still control which bits appear.
   */
  layout: 'columns' | 'embedded';
}

function getDocColumns(): DocColumns {
  const u = vscode.workspace.getConfiguration('opm-flow.units');
  const c = vscode.workspace.getConfiguration('opm-flow.columns');
  const d = vscode.workspace.getConfiguration('opm-flow.docs');
  return {
    type:    c.get<boolean>('showType', true),
    field:   u.get<boolean>('showField', true),
    metric:  u.get<boolean>('showMetric', true),
    lab:     u.get<boolean>('showLab', true),
    default: c.get<boolean>('showDefault', true),
    layout:  d.get<'columns' | 'embedded'>('layout', 'embedded'),
  };
}

/**
 * Build the metadata bits (type, units, default) for a parameter, honouring
 * the column show/hide flags and skipping anything the parameter doesn't
 * carry. Shared shape for both the sidebar (HTML) and the hover (markdown);
 * callers supply the per-bit renderers.
 */
function metaBits(
  p: Parameter,
  typeLabel: string,
  cols: DocColumns,
  fmt: { type: (s: string) => string; pair: (label: string, value: string) => string },
): string[] {
  const bits: string[] = [];
  if (cols.type && typeLabel) bits.push(fmt.type(typeLabel));
  const u = p.units ?? {};
  if (cols.field  && u.field)      bits.push(fmt.pair('Field',  u.field));
  if (cols.metric && u.metric)     bits.push(fmt.pair('Metric', u.metric));
  if (cols.lab    && u.laboratory) bits.push(fmt.pair('Lab',    u.laboratory));
  if (cols.default && p.default)   bits.push(fmt.pair('default', p.default));
  return bits;
}

/** Embedded metadata sub-line for the sidebar (HTML). Empty string when no
 *  bits are visible. */
function buildMetaHtml(p: Parameter, typeLabel: string, cols: DocColumns): string {
  const bits = metaBits(p, typeLabel, cols, {
    type: t => `<span class="meta-type">${escWithBreaks(t)}</span>`,
    pair: (label, value) => `<span class="meta-key">${label}:</span> ${escWithBreaks(value)}`,
  });
  return bits.length ? `<div class="meta">${bits.join(' <span class="meta-sep">&middot;</span> ')}</div>` : '';
}

/** Embedded metadata sub-line for the hover (markdown). Empty string when no
 *  bits are visible. */
function buildMetaMarkdown(p: Parameter, typeLabel: string, cols: DocColumns): string {
  const bits = metaBits(p, typeLabel, cols, {
    type: t => t,
    pair: (label, value) => `${label}: ${value}`,
  });
  return bits.length ? `_${bits.join(' · ')}_` : '';
}

function buildDocsHtml(
  entry: KeywordEntry | null,
  highlightParam: Parameter | null,
  cols: DocColumns,
): string {
  const css = `
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 8px 12px;
      margin: 0;
      line-height: 1.5;
    }
    h1 { font-size: 1.15em; margin: 0 0 4px 0; }
    h2 { font-size: 1em; margin: 12px 0 4px 0; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 2px; }
    h3 { font-size: 0.95em; margin: 10px 0 4px 0; color: var(--vscode-descriptionForeground); }
    p { margin: 4px 0 8px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9em; margin-bottom: 8px; table-layout: auto; }
    th {
      text-align: left; padding: 4px 6px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border: 1px solid var(--vscode-panel-border);
    }
    td {
      padding: 3px 6px; border: 1px solid var(--vscode-panel-border); vertical-align: top;
      overflow-wrap: break-word;
    }
    th.name, td.name { white-space: nowrap; overflow-wrap: normal; }
    tr.highlight td { background: var(--vscode-editor-selectionBackground); }
    code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textBlockQuote-background);
      padding: 1px 4px; border-radius: 3px; font-size: 0.9em;
    }
    pre {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.88em;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      padding: 6px 10px; margin: 4px 0;
      white-space: pre-wrap; word-break: break-all;
      overflow-x: auto;
    }
    .placeholder { color: var(--vscode-descriptionForeground); font-style: italic; margin-top: 20px; }
    .sections { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 0 0 8px 0; }
    .meta {
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
      margin-top: 3px;
    }
    .meta-type { font-style: italic; }
    .meta-key { opacity: 0.8; }
    .meta-sep { opacity: 0.5; padding: 0 2px; }
  `;

  if (!entry) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
      <style>${css}</style></head>
      <body><p class="placeholder">Move the cursor over a keyword or value to see documentation.</p></body></html>`;
  }

  const n = nonce();
  const allParams = entry.parameters ?? [];
  const paramTypes = allParams.map(paramTypeLabel);

  let paramsHtml = '';
  if (allParams.length > 0) {
    const embedded = cols.layout === 'embedded';
    const showField   = cols.field   && allParams.some(p => p.units?.field);
    const showMetric  = cols.metric  && allParams.some(p => p.units?.metric);
    const showLab     = cols.lab     && allParams.some(p => p.units?.laboratory);
    const showType    = cols.type    && paramTypes.some(t => t.length > 0);
    const showDefault = cols.default;
    const unitCols =
      (showField  ? '<th>Field</th>'  : '') +
      (showMetric ? '<th>Metric</th>' : '') +
      (showLab    ? '<th>Lab</th>'    : '');
    const typeCol    = showType    ? '<th>Type</th>'    : '';
    const defaultCol = showDefault ? '<th>Default</th>' : '';

    const renderRow = (p: Parameter, idx: number): string => {
      const sameRecord  = (highlightParam?.record ?? 1) === (p.record ?? 1);
      const hl = highlightParam && highlightParam.index === p.index && sameRecord
        ? ' class="highlight"' : '';
      const dataRecord = p.record !== undefined
        ? ` data-record="${escHtml(String(p.record))}"` : '';
      const head = `<tr data-param-index="${escHtml(String(p.index))}"${dataRecord}${hl}>`
        + `<td>${escHtml(String(p.index))}</td>`
        + `<td class="name"><code>${escHtml(p.name)}</code></td>`;

      if (embedded) {
        const descCell = `<td>${escHtml(p.description)}${buildMetaHtml(p, paramTypes[idx], cols)}</td>`;
        return `${head}${descCell}</tr>`;
      }

      const u = p.units ?? {};
      const unitCells =
        (showField  ? `<td>${escWithBreaks(u.field ?? '')}</td>`      : '') +
        (showMetric ? `<td>${escWithBreaks(u.metric ?? '')}</td>`     : '') +
        (showLab    ? `<td>${escWithBreaks(u.laboratory ?? '')}</td>` : '');
      const typeCell    = showType    ? `<td>${escWithBreaks(paramTypes[idx])}</td>` : '';
      const defaultCell = showDefault ? `<td>${escHtml(p.default)}</td>`              : '';
      return `${head}<td>${escHtml(p.description)}</td>${typeCell}${unitCells}${defaultCell}</tr>`;
    };

    const tableHead = embedded
      ? `<thead><tr><th>No.</th><th class="name">Name</th><th>Description</th></tr></thead>`
      : `<thead><tr><th>No.</th><th class="name">Name</th><th>Description</th>${typeCol}${unitCols}${defaultCol}</tr></thead>`;

    if (entry.records_meta?.length) {
      // Multi-record: render one table per record so the user can see
      // which row group each parameter belongs to.
      const buckets = new Map<number, Parameter[]>();
      allParams.forEach(p => {
        const r = p.record ?? 1;
        if (!buckets.has(r)) buckets.set(r, []);
        buckets.get(r)!.push(p);
      });
      const sectionsHtmlParts: string[] = ['<h2>Parameters</h2>'];
      for (const r of [...buckets.keys()].sort((a, b) => a - b)) {
        const rows = buckets.get(r)!.map(p => {
          const flatIdx = allParams.indexOf(p);
          return renderRow(p, flatIdx);
        }).join('');
        sectionsHtmlParts.push(
          `<h3>Record ${r}</h3>`
          + `<table>${tableHead}<tbody>${rows}</tbody></table>`,
        );
      }
      paramsHtml = sectionsHtmlParts.join('\n');
    } else {
      const rows = allParams.map((p, i) => renderRow(p, i)).join('');
      paramsHtml = `<h2>Parameters</h2><table>${tableHead}<tbody>${rows}</tbody></table>`;
    }
  }

  const exampleHtml = entry.example
    ? `<h2>Example</h2><pre>${escHtml(entry.example)}</pre>`
    : '';

  const summaryHtml = entry.summary ? `<p>${escHtml(entry.summary)}</p>` : '';
  const sectionsHtml = entry.sections.length
    ? `<p class="sections">Section${entry.sections.length > 1 ? 's' : ''}: ${escHtml(entry.sections.join(', '))}</p>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
    <style>${css}</style></head>
    <body>
      <h1><code>${escHtml(entry.name)}</code></h1>
      ${sectionsHtml}
      ${summaryHtml}
      ${paramsHtml}
      ${exampleHtml}
      <script nonce="${n}">
        function highlightRow(idx, record) {
          document.querySelectorAll('tr.highlight').forEach(r => r.classList.remove('highlight'));
          if (idx === null || idx === undefined) return;
          const ix = CSS.escape(String(idx));
          let target = null;
          if (record !== null && record !== undefined) {
            target = document.querySelector(
              'tr[data-param-index="' + ix + '"][data-record="' + CSS.escape(String(record)) + '"]'
            );
          }
          if (!target) {
            target = document.querySelector('tr[data-param-index="' + ix + '"]');
          }
          if (target) {
            target.classList.add('highlight');
            target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        }
        const initial = document.querySelector('tr.highlight');
        if (initial) initial.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        window.addEventListener('message', (e) => {
          const msg = e.data;
          if (msg && msg.type === 'highlight') highlightRow(msg.paramIndex, msg.record);
        });
      </script>
    </body></html>`;
}

// ---------------------------------------------------------------------------
// Sidebar docs panel
// ---------------------------------------------------------------------------

class DocsViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _currentEntry?: KeywordEntry;
  private _currentParam?: Parameter;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _index: KeywordIndex
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this._view = view;
    // The docs panel renders only inline HTML/CSS/JS that we build here, so
    // it never needs to load files from disk. Drop `localResourceRoots` to
    // an empty list to deny the webview any filesystem access.
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = buildDocsHtml(null, null, getDocColumns());
    this._currentEntry = undefined;
    this._currentParam = undefined;
  }

  // While the user is moving the cursor inside the same keyword, just send a
  // message to swap the highlighted row instead of rebuilding the whole HTML
  // (which forces a full webview reload).
  update(entry: KeywordEntry, param?: Parameter): void {
    if (!this._view) return;
    if (this._currentEntry?.name === entry.name) {
      this._currentParam = param;
      this._view.webview.postMessage({
        type: 'highlight',
        paramIndex: param?.index ?? null,
        record:     param?.record ?? null,
      });
      return;
    }
    this._view.webview.html = buildDocsHtml(entry, param ?? null, getDocColumns());
    this._currentEntry = entry;
    this._currentParam = param;
  }

  // Force a full HTML rebuild against the current entry — used when a setting
  // that affects column visibility changes.
  refresh(): void {
    if (!this._view) return;
    this._view.webview.html = buildDocsHtml(
      this._currentEntry ?? null,
      this._currentParam ?? null,
      getDocColumns(),
    );
  }
}

// ---------------------------------------------------------------------------
// Hover markdown builders (tooltip)
// ---------------------------------------------------------------------------

function buildKeywordHover(
  entry: KeywordEntry,
  currentSection?: string | null,
  isExcluded?: boolean,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  // `supportHtml` is enough for the inline <span style="..."> notices below.
  // `isTrusted` would additionally permit `command:` links to execute, which
  // these hovers never use — keep it off as defense in depth.
  md.supportHtml = true;

  if (
    currentSection
    && entry.sections.length > 0
    && !entry.sections.includes(currentSection)
  ) {
    md.appendMarkdown(
      `<span style="color:#cca700;">⚠ ${entry.name} is not valid in ${currentSection}; valid in: ${entry.sections.join(', ')}.</span>\n\n`,
    );
  }

  if (isExcluded) {
    md.appendMarkdown(
      `<span style="color:#cca700;">ℹ ${entry.name} is on the diagnostics exclusion list `
      + `(\`opm-flow.diagnostics.excludedKeywords\`); arity, terminator, and section checks are skipped for this keyword.</span>\n\n`,
    );
  }

  const sectionLabel = entry.sections.length ? ` — ${entry.sections.join(', ')}` : '';
  md.appendMarkdown(`## \`${entry.name}\`${sectionLabel}\n\n`);
  if (entry.summary) md.appendMarkdown(`${entry.summary}\n\n`);
  appendParameterTable(md, entry.parameters, getDocColumns());
  if (entry.example) md.appendMarkdown(`**Example**\n\`\`\`\n${entry.example}\n\`\`\`\n`);
  return md;
}

function buildParameterHover(entry: KeywordEntry, param: Parameter): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  // No HTML or command links needed here — pure markdown is sufficient.
  md.appendMarkdown(`**\`${entry.name}\` — parameter ${param.index}: \`${param.name}\`**\n\n`);
  md.appendMarkdown(`${param.description}\n\n`);
  const cols = getDocColumns();
  const typeLabel = paramTypeLabel(param);
  if (cols.type && typeLabel) md.appendMarkdown(`*Type: ${typeLabel}*\n\n`);
  const u = param.units ?? {};
  const showField  = cols.field  && !!u.field;
  const showMetric = cols.metric && !!u.metric;
  const showLab    = cols.lab    && !!u.laboratory;
  if (showField || showMetric || showLab) {
    const headers: string[] = [];
    const seps: string[]    = [];
    const cells: string[]   = [];
    if (showField)  { headers.push('Field');      seps.push('-------');      cells.push(u.field ?? ''); }
    if (showMetric) { headers.push('Metric');     seps.push('--------');     cells.push(u.metric ?? ''); }
    if (showLab)    { headers.push('Laboratory'); seps.push('------------'); cells.push(u.laboratory ?? ''); }
    md.appendMarkdown(`| ${headers.join(' | ')} |\n|${seps.join('|')}|\n`);
    md.appendMarkdown(`| ${cells.join(' | ')} |\n\n`);
  }
  if (cols.default) md.appendMarkdown(`*Default: ${param.default || '—'}*`);
  return md;
}

function appendParameterTable(
  md: vscode.MarkdownString,
  parameters: Parameter[],
  cols: DocColumns,
): void {
  if (!parameters || parameters.length === 0) return;
  const types = parameters.map(paramTypeLabel);

  if (cols.layout === 'embedded') {
    // Fold Type / units / Default into a muted sub-line beneath each
    // description so the Description column isn't squeezed.
    md.appendMarkdown(`**Parameters**\n\n| No. | Name | Description |\n|-----|------|-------------|\n`);
    parameters.forEach((p, i) => {
      const meta = buildMetaMarkdown(p, types[i], cols);
      const desc = meta ? `${p.description}<br>${meta}` : p.description;
      md.appendMarkdown(`| ${p.index} | \`${p.name}\` | ${desc} |\n`);
    });
    md.appendMarkdown('\n');
    return;
  }

  const showField   = cols.field   && parameters.some(p => p.units?.field);
  const showMetric  = cols.metric  && parameters.some(p => p.units?.metric);
  const showLab     = cols.lab     && parameters.some(p => p.units?.laboratory);
  const showType    = cols.type    && types.some(t => t.length > 0);
  const showDefault = cols.default;
  const typeHead = showType ? ' Type |' : '';
  const typeSep  = showType ? '------|' : '';
  const unitHead =
    (showField  ? ' Field |'  : '') +
    (showMetric ? ' Metric |' : '') +
    (showLab    ? ' Lab |'    : '');
  const unitSep =
    (showField  ? '-------|'  : '') +
    (showMetric ? '--------|' : '') +
    (showLab    ? '-----|'    : '');
  const defaultHead = showDefault ? ' Default |'   : '';
  const defaultSep  = showDefault ? '---------|'   : '';
  md.appendMarkdown(`**Parameters**\n\n| No. | Name | Description |${typeHead}${unitHead}${defaultHead}\n|-----|------|-------------|${typeSep}${unitSep}${defaultSep}\n`);
  parameters.forEach((p, i) => {
    const u = p.units || {};
    const typeCell = showType ? ` ${types[i]} |` : '';
    const unitCells =
      (showField  ? ` ${u.field ?? ''} |`      : '') +
      (showMetric ? ` ${u.metric ?? ''} |`     : '') +
      (showLab    ? ` ${u.laboratory ?? ''} |` : '');
    const defaultCell = showDefault ? ` ${p.default} |` : '';
    md.appendMarkdown(`| ${p.index} | \`${p.name}\` | ${p.description} |${typeCell}${unitCells}${defaultCell}\n`);
  });
  md.appendMarkdown('\n');
}

// Find the contiguous record group that contains (or is nearest to) the given line.
// Comment lines interspersed within the group are skipped over (not returned).
function findRecordGroupAtLine(
  document: vscode.TextDocument,
  startLine: number
): { groupLines: number[]; group: RecordLine[] } | null {
  let anchorLine = -1;
  let anchorRec: RecordLine | null = null;
  outer: for (let delta = 0; delta <= 5; delta++) {
    for (const sign of [0, 1, -1]) {
      const ln = startLine + sign * delta;
      if (ln < 0 || ln >= document.lineCount) continue;
      const r = parseRecordLine(document.lineAt(ln).text);
      if (r) { anchorLine = ln; anchorRec = r; break outer; }
    }
  }
  if (anchorLine < 0 || !anchorRec) return null;
  const nCols = anchorRec.tokens.length;
  // Walk backward to the first record in the group, skipping comment lines
  let groupStartLine = anchorLine;
  while (groupStartLine > 0) {
    const prevLine = document.lineAt(groupStartLine - 1).text;
    if (isCommentLine(prevLine)) { groupStartLine--; continue; }
    const prev = parseRecordLine(prevLine);
    if (!prev || prev.tokens.length !== nCols) break;
    groupStartLine--;
  }
  // Collect group forward, skipping comment lines
  const groupLines: number[] = [];
  const group: RecordLine[] = [];
  let ln = groupStartLine;
  while (ln < document.lineCount) {
    const lineText = document.lineAt(ln).text;
    if (isCommentLine(lineText)) { ln++; continue; }
    const r = parseRecordLine(lineText);
    if (!r || r.tokens.length !== nCols) break;
    groupLines.push(ln);
    group.push(r);
    ln++;
  }
  return { groupLines, group };
}

function computeAlignEdits(document: vscode.TextDocument, range?: vscode.Range): vscode.TextEdit[] {
  const edits: vscode.TextEdit[] = [];
  const first = range ? range.start.line : 0;
  const last = range ? range.end.line : document.lineCount - 1;
  let i = first;
  while (i <= last) {
    const rec = parseRecordLine(document.lineAt(i).text);
    if (!rec) { i++; continue; }
    const nCols = rec.tokens.length;

    // Collect the group: record lines and interspersed comment lines.
    // A comment line does not break the group — only a non-comment, non-record line does.
    const entries: Array<{ lineNum: number; record: RecordLine | null }> = [
      { lineNum: i, record: rec }
    ];
    let j = i + 1;
    while (j <= last) {
      const lineText = document.lineAt(j).text;
      const r2 = parseRecordLine(lineText);
      if (r2 && r2.tokens.length === nCols) {
        entries.push({ lineNum: j, record: r2 });
        j++;
      } else if (isCommentLine(lineText)) {
        entries.push({ lineNum: j, record: null });
        j++;
      } else {
        break;
      }
    }

    // Extract just the record entries for formatting
    const records = entries.filter(e => e.record !== null).map(e => e.record as RecordLine);

    // Look for a heading comment on the line immediately before the group
    const headingPositions = i > 0 ? parseHeadingPositions(document.lineAt(i - 1).text) : null;
    if (records.length > 1 || headingPositions) {
      const formatted = headingPositions
        ? formatRecordGroupWithHeading(records, headingPositions)
        : formatRecordGroup(records);
      let recordIdx = 0;
      for (const entry of entries) {
        if (entry.record === null) { continue; } // comment line — leave as-is
        const lineRange = document.lineAt(entry.lineNum).range;
        const orig = document.lineAt(entry.lineNum).text;
        if (formatted[recordIdx] !== orig) {
          edits.push(vscode.TextEdit.replace(lineRange, formatted[recordIdx]));
        }
        recordIdx++;
      }
    }
    i = j;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Folding range provider
// ---------------------------------------------------------------------------

class OpmFlowFoldingRangeProvider implements vscode.FoldingRangeProvider {
  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    const ranges: vscode.FoldingRange[] = [];
    let sectionStart = -1;
    let keywordStart = -1;

    const pushRange = (start: number, end: number) => {
      if (start >= 0 && end > start) {
        ranges.push(new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region));
      }
    };

    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      if (text.trim().startsWith('--')) continue;

      const prevEnd = i - 1;

      // Section header — checked first so trailing decoration (`GRID ======`)
      // still opens a section fold instead of being skipped as a value line.
      const section = matchSectionLine(text);
      if (section && section.indent === 0) {
        pushRange(keywordStart, prevEnd);
        pushRange(sectionStart, prevEnd);
        keywordStart = -1;
        sectionStart = i;
        continue;
      }

      const m = text.match(KEYWORD_LINE_COL1_RE);
      if (!m) continue;

      const kw = m[1];

      if (kw === 'END') {
        pushRange(keywordStart, prevEnd);
        pushRange(sectionStart, prevEnd);
        keywordStart = -1;
        sectionStart = -1;
        continue;
      }

      pushRange(keywordStart, prevEnd);
      keywordStart = i;
    }

    const lastLine = document.lineCount - 1;
    pushRange(keywordStart, lastLine);
    pushRange(sectionStart, lastLine);

    return ranges;
  }
}

// ---------------------------------------------------------------------------
// Outline tree view — section -> keyword navigation
// ---------------------------------------------------------------------------

class OpmFlowOutlineProvider implements vscode.TreeDataProvider<OutlineNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: OutlineNode[] = [];
  /** Source document of the current outline, for the reveal command. */
  private docUri?: vscode.Uri;

  constructor(private readonly index: KeywordIndex) {}

  /** Rebuild the outline from `doc` (or clear it for non-opm-flow docs). */
  refresh(doc?: vscode.TextDocument): void {
    if (doc?.languageId === 'opm-flow') {
      this.roots = buildOutline(doc.getText().split(/\r?\n/));
      this.docUri = doc.uri;
    } else {
      this.roots = [];
      this.docUri = undefined;
    }
    this._onDidChangeTreeData.fire();
  }

  getChildren(node?: OutlineNode): OutlineNode[] {
    return node ? node.children : this.roots;
  }

  /** Required for `TreeView.reveal` to locate a node. Sections are roots;
   *  a keyword's parent is the section that contains it (undefined for
   *  pre-section keywords attached directly to the root). */
  getParent(node: OutlineNode): OutlineNode | undefined {
    if (node.kind === 'section') return undefined;
    return this.roots.find(s => s.children.includes(node));
  }

  getTreeItem(node: OutlineNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      node.kind === 'section'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon(
      node.kind === 'section' ? 'symbol-namespace' : 'symbol-keyword',
    );
    const summary = resolveKeyword(this.index, node.name)?.summary;
    if (summary) item.tooltip = summary;
    if (node.kind === 'keyword' && this.docUri) {
      item.command = {
        command: 'opm-flow.revealKeyword',
        title: 'Go to keyword',
        arguments: [this.docUri, node.line],
      };
    }
    return item;
  }

  /** Find the deepest node whose declaration line is at or before `line`. */
  nodeAtLine(line: number): OutlineNode | undefined {
    let match: OutlineNode | undefined;
    for (const section of this.roots) {
      if (section.line > line) break;
      match = section;
      for (const kw of section.children) {
        if (kw.line > line) break;
        match = kw;
      }
    }
    return match;
  }
}

// ---------------------------------------------------------------------------
// File-reference link provider — INCLUDE / IMPORT / RESTART / GDFILE
// ---------------------------------------------------------------------------

class FileReferenceLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    if (!document.uri.fsPath) return [];
    const docDir = path.dirname(document.uri.fsPath);

    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);
    const aliases = parsePathsAliases(lines);

    return findFileReferences(lines).map(ref => {
      const range = new vscode.Range(ref.line, ref.startChar, ref.line, ref.endChar);
      const resolved = resolvePathAlias(ref.rawPath, aliases);
      const absPath = path.resolve(docDir, resolved);
      return new vscode.DocumentLink(range, vscode.Uri.file(absPath));
    });
  }
}

// ---------------------------------------------------------------------------
// Diagnostics — over-arity records and wrong-section keywords
// ---------------------------------------------------------------------------

function getExcludedKeywords(resource?: vscode.Uri): ReadonlySet<string> {
  const raw = vscode.workspace
    .getConfiguration('opm-flow.diagnostics', resource ?? null)
    .get<string[]>('excludedKeywords', [...DEFAULT_DIAGNOSTICS_EXCLUDED_KEYWORDS]);
  // Normalise: keywords are uppercase by OPM Flow convention; tolerate
  // mixed-case user input by upper-casing on read.
  return new Set(raw.map(k => k.toUpperCase()));
}

/** A diagnostic carrying the extra fields the quick-fix provider reads back
 *  off `context.diagnostics` (same object instances within the host). */
type OpmDiagnostic = vscode.Diagnostic & { suggestion?: string };

/** Build the quick-fix code actions for the OPM Flow diagnostics in range. */
function provideOpmCodeActions(
  document: vscode.TextDocument,
  context: vscode.CodeActionContext,
): vscode.CodeAction[] {
  const actions: vscode.CodeAction[] = [];
  for (const diag of context.diagnostics) {
    if (diag.source !== 'OPM Flow') continue;
    const code = diag.code as DiagnosticCode | undefined;
    if (!code) continue;
    const range = diag.range;

    const makeFix = (title: string, edit: (e: vscode.WorkspaceEdit) => void, preferred = false) => {
      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      edit(action.edit);
      action.diagnostics = [diag];
      action.isPreferred = preferred;
      actions.push(action);
    };

    switch (code) {
      case 'lowercase-keyword': {
        const token = document.getText(range);
        makeFix(`Convert '${token}' to uppercase`, e => {
          e.replace(document.uri, range, token.toUpperCase());
        }, true);
        break;
      }
      case 'indented-keyword': {
        // Delete the leading whitespace so the keyword starts in column 1.
        const lineStart = new vscode.Position(range.start.line, 0);
        const dedent = new vscode.Range(lineStart, range.start);
        makeFix('Move keyword to column 1', e => {
          e.delete(document.uri, dedent);
        }, true);
        break;
      }
      case 'missing-record-terminator': {
        // Append ' /' at the end of the record line.
        const line = document.lineAt(range.start.line);
        makeFix("Add terminating '/'", e => {
          e.insert(document.uri, line.range.end, ' /');
        }, true);
        break;
      }
      case 'missing-list-terminator':
      case 'missing-array-terminator': {
        // Insert a standalone '/' line after the (last) record line.
        const line = document.lineAt(range.start.line);
        const what = code === 'missing-array-terminator' ? 'value array' : 'record list';
        makeFix(`Add '/' to close the ${what}`, e => {
          e.insert(document.uri, line.range.end, '\n/');
        }, true);
        break;
      }
      case 'unknown-keyword': {
        const suggestion = (diag as OpmDiagnostic).suggestion;
        if (suggestion) {
          makeFix(`Replace with '${suggestion}'`, e => {
            e.replace(document.uri, range, suggestion);
          }, true);
        }
        break;
      }
    }
  }
  return actions;
}

function refreshDiagnostics(
  document: vscode.TextDocument,
  index: KeywordIndex,
  collection: vscode.DiagnosticCollection,
  summaryPatterns: readonly RegExp[],
): void {
  if (document.languageId !== 'opm-flow') return;
  const lines = document.getText().split(/\r?\n/);
  const excluded = getExcludedKeywords(document.uri);
  const diags = computeDiagnostics(lines, index, excluded, summaryPatterns).map(d => {
    const range = new vscode.Range(d.line, d.startChar, d.line, d.endChar);
    const out: OpmDiagnostic = new vscode.Diagnostic(range, d.message, vscode.DiagnosticSeverity.Warning);
    out.source = 'OPM Flow';
    // Carry the quick-fix discriminator (and any typo suggestion) through to
    // the code-action provider, which reads them off the diagnostic object.
    if (d.code) out.code = d.code;
    if (d.suggestion) out.suggestion = d.suggestion;
    return out;
  });
  collection.set(document.uri, diags);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------
// Additional file extensions — `opm-flow.additionalFileExtensions`
// ---------------------------------------------------------------------------

/** Read and normalise the user's extra-extensions setting. Accepts entries
 *  with or without a leading '.'; matches case-insensitively. */
function getAdditionalFileExtensions(resource?: vscode.Uri): Set<string> {
  const raw = vscode.workspace
    .getConfiguration('opm-flow', resource ?? null)
    .get<string[]>('additionalFileExtensions', []);
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    let s = entry.trim();
    if (!s) continue;
    if (s.startsWith('.')) s = s.slice(1);
    if (s) out.add(s.toLowerCase());
  }
  return out;
}

/** If the document's extension matches one of the user-configured extras
 *  and the document isn't already opm-flow, retag it. Failures (closed
 *  document, virtual scheme, etc.) are silently ignored. */
async function retagDocumentIfMatches(
  doc: vscode.TextDocument,
  extensions: Set<string>,
): Promise<void> {
  if (extensions.size === 0) return;
  if (doc.languageId === 'opm-flow') return;
  const fileName = doc.fileName ?? doc.uri.path ?? '';
  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx < 0) return;
  const ext = fileName.slice(dotIdx + 1).toLowerCase();
  if (!ext || !extensions.has(ext)) return;
  try {
    await vscode.languages.setTextDocumentLanguage(doc, 'opm-flow');
  } catch {
    // The doc may have been closed, or its scheme may not support
    // language reassignment — both are fine to skip.
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const index = loadKeywordIndex(context);
  const keywords = Object.keys(index);

  // --- Additional file extensions ---
  // Retag any open file whose extension is listed in
  // `opm-flow.additionalFileExtensions` and watch for new opens + config
  // changes. The extension activates `onStartupFinished` so this works on
  // first open of an unknown-extension file too.
  const retagAllOpenDocuments = (): void => {
    const exts = getAdditionalFileExtensions();
    if (exts.size === 0) return;
    for (const doc of vscode.workspace.textDocuments) {
      void retagDocumentIfMatches(doc, exts);
    }
  };
  retagAllOpenDocuments();
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      void retagDocumentIfMatches(doc, getAdditionalFileExtensions(doc.uri));
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('opm-flow.additionalFileExtensions')) {
        retagAllOpenDocuments();
      }
    }),
  );

  // --- Sidebar docs panel ---
  const docsProvider = new DocsViewProvider(context.extensionUri, index);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('opm-flow.docsView', docsProvider)
  );

  // --- Cursor-driven docs update ---
  const onCursorMove = debounce((editor: vscode.TextEditor) => {
    const pos = editor.selection.active;
    const line = editor.document.lineAt(pos).text;

    // Only treat the word at the cursor as a keyword *declaration* when it
    // starts in column 1. OPM Flow only recognises keywords there, so an
    // indented uppercase token (e.g. `THPRES` on ` THPRES /` under EQLOPTS)
    // is a record value, not the THPRES keyword — fall through to the
    // active-keyword + column lookup below.
    const wordRange = editor.document.getWordRangeAtPosition(pos, /[A-Z][A-Z0-9_-]*/);
    const word = wordRange ? editor.document.getText(wordRange) : '';
    const wordEntry = word ? resolveKeyword(index, word) : undefined;
    if (wordEntry && wordRange?.start.character === 0) {
      docsProvider.update(wordEntry);
      return;
    }

    const col = columnAtCursor(line, pos.character);
    if (col >= 1) {
      const kwName = findActiveKeyword(editor.document, pos);
      const entry = kwName ? resolveKeyword(index, kwName) : undefined;
      if (entry) {
        const record = findActiveRecord(editor.document, entry, pos);
        const param = findParam(entry, record, p => p.index === col);
        docsProvider.update(entry, param);
        return;
      }
    }
  }, 150);

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.textEditor.document.languageId === 'opm-flow') {
        onCursorMove(e.textEditor);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('opm-flow.units') ||
        e.affectsConfiguration('opm-flow.columns') ||
        e.affectsConfiguration('opm-flow.docs')
      ) {
        docsProvider.refresh();
      }
    }),
  );

  // --- Completion provider: keyword names at the start of a line ---
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    'opm-flow',
    {
      provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
      ): vscode.CompletionItem[] {
        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        if (!/^\s*[A-Z][A-Z0-9_-]*$/.test(linePrefix)) return [];
        const completionConfig = vscode.workspace.getConfiguration('opm-flow.completion', document.uri);
        const style = completionConfig.get<'both' | 'quoted' | 'unquoted'>('stringValueStyle', 'quoted');
        const insertMode = completionConfig.get<'template' | 'keyword'>('keywordInsert', 'template');
        return keywords.map((kw) => {
          const entry = index[kw];
          const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
          item.detail = `[${entry.sections.join(', ')}] OPM Flow`;
          if (entry.summary) item.documentation = new vscode.MarkdownString(entry.summary);
          // Insert a correctly-shaped sample record (typed placeholders /
          // defaults) so the keyword arrives ready to edit, unless the user
          // prefers just the bare keyword name.
          if (insertMode === 'template') {
            item.insertText = new vscode.SnippetString(buildKeywordSnippet(entry, style));
          }
          return item;
        });
      },
    },
    ...('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))
  );

  // --- Code-action provider: quick fixes for fixable diagnostics ---
  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    'opm-flow',
    {
      provideCodeActions(document, _range, context): vscode.CodeAction[] {
        return provideOpmCodeActions(document, context);
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  );

  // --- Completion provider: enum-style values inside record lines ---
  const valueCompletionProvider = vscode.languages.registerCompletionItemProvider(
    'opm-flow',
    {
      provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
      ): vscode.CompletionItem[] {
        const line = document.lineAt(position).text;
        const prefix = line.substring(0, position.character);
        // Skip when the prefix still looks like a keyword declaration —
        // the keyword completion provider handles that case.
        if (/^\s*[A-Z][A-Z0-9_-]*$/.test(prefix)) return [];
        // Skip inside line comments
        if (/^\s*--/.test(prefix)) return [];

        const kwName = findActiveKeyword(document, position);
        if (!kwName) return [];
        const entry = index[kwName];
        if (!entry?.parameters?.length) return [];

        const col = columnForCompletion(line, position.character);
        const record = findActiveRecord(document, entry, position);
        const param = findParam(entry, record, p => {
          if (p.index === col) return true;
          if (typeof p.index === 'string') {
            const start = Number(p.index.split('-')[0]);
            const end   = Number(p.index.split('-')[1] || start);
            return col >= start && col <= end;
          }
          return false;
        });
        if (!param?.options?.length) return [];

        // If the cursor sits inside (or right after) a token that already
        // starts with a single quote, the inserted `'VALUE'` should replace
        // that whole token so we don't end up with `''VALUE'`.
        const tokens = tokenizeLine(line);
        const quotedTok = tokens.find(t =>
          position.character >= t.start &&
          position.character <= t.end &&
          t.text.startsWith("'"),
        );
        const replaceRange = quotedTok
          ? new vscode.Range(position.line, quotedTok.start, position.line, quotedTok.end)
          : undefined;

        // Inside an existing quoted token only the quoted form makes sense
        // (replacing inside `'OPE'` with a bare value would yield `''OPE'`).
        // Otherwise honour the user's `stringValueStyle` preference.
        const style = vscode.workspace
          .getConfiguration('opm-flow.completion', document.uri)
          .get<'both' | 'quoted' | 'unquoted'>('stringValueStyle', 'quoted');

        const detail = `${kwName} parameter ${param.index}: ${param.name}`;
        const documentation = param.description
          ? new vscode.MarkdownString(param.description)
          : undefined;

        const makeItem = (insert: string, opt: string, formRank: string): vscode.CompletionItem => {
          const item = new vscode.CompletionItem(insert, vscode.CompletionItemKind.EnumMember);
          item.insertText = insert;
          // Match against the bare option so typing `OP` finds both `OPEN` and `'OPEN'`.
          item.filterText = opt;
          // Sort by option then form, so each option's bare/quoted pair stays grouped.
          item.sortText = `${opt}${formRank}`;
          item.detail = detail;
          if (documentation) item.documentation = documentation;
          if (replaceRange) item.range = replaceRange;
          return item;
        };

        return param.options.flatMap(opt => {
          const quoted = makeItem(`'${opt}'`, opt, '1');
          if (quotedTok) return [quoted];
          const bare = makeItem(opt, opt, '0');
          if (style === 'quoted') return [quoted];
          if (style === 'unquoted') return [bare];
          return [bare, quoted];
        });
      },
    },
    ...('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))
  );

  // --- Hover provider (tooltip) ---
  const hoverProvider = vscode.languages.registerHoverProvider('opm-flow', {
    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
      const line = document.lineAt(position).text;

      // Same column-1 discipline as the docs panel: an indented uppercase
      // token is a record value, not a keyword declaration, even when its
      // name happens to match an index entry (THPRES under EQLOPTS, …).
      const wordRange = document.getWordRangeAtPosition(position, /[A-Z][A-Z0-9_-]*/);
      const word = wordRange ? document.getText(wordRange) : '';
      const wordAtCol1 = wordRange?.start.character === 0;
      const excluded = getExcludedKeywords(document.uri);
      const wordEntry = word ? resolveKeyword(index, word) : undefined;
      if (word && wordEntry && wordAtCol1) {
        const currentSection = findCurrentSection(document, position);
        return new vscode.Hover(
          buildKeywordHover(wordEntry, currentSection, excluded.has(word)),
        );
      }

      // Excluded keyword not in the index: still show a short notice so the
      // user knows why no diagnostics or docs appear on it.
      if (word && wordAtCol1 && excluded.has(word)) {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.appendMarkdown(`## \`${word}\`\n\n`);
        md.appendMarkdown(
          `<span style="color:#cca700;">ℹ ${word} is on the diagnostics exclusion list `
          + `(\`opm-flow.diagnostics.excludedKeywords\`); arity, terminator, and section checks are skipped for this keyword.</span>`,
        );
        return new vscode.Hover(md);
      }

      const col = columnAtCursor(line, position.character);
      if (col < 1) return undefined;

      const kwName = findActiveKeyword(document, position);
      if (!kwName) return undefined;
      const entry = index[kwName];
      if (!entry?.parameters?.length) return undefined;

      const record = findActiveRecord(document, entry, position);
      const param = findParam(entry, record, p => p.index === col);
      if (!param) return undefined;

      return new vscode.Hover(buildParameterHover(entry, param));
    },
  });

  // --- Command: generate keyword reference ---
  const generateReferenceCommand = vscode.commands.registerCommand('opm-flow.generateKeywordReference', async () => {
    const bySection: Record<string, KeywordEntry[]> = {};
    for (const entry of Object.values(index)) {
      for (const sec of entry.sections) {
        if (!bySection[sec]) bySection[sec] = [];
        bySection[sec].push(entry);
      }
    }
    const lines: string[] = ['# OPM Flow Keyword Reference\n'];
    for (const sec of SECTION_KEYWORDS) {
      const entries = bySection[sec];
      if (!entries) continue;
      lines.push(`## ${sec}\n`);
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`### \`${e.name}\``);
        if (e.summary) lines.push(e.summary);
        if (e.parameters?.length) {
          lines.push('');
          for (const p of e.parameters) lines.push(`- **${p.name}**: ${p.description} *(default: ${p.default})*`);
        }
        lines.push('');
      }
    }
    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
    await vscode.window.showTextDocument(doc);
  });

  // --- Command: add column headers ---
  const addColumnHeadersCommand = vscode.commands.registerCommand('opm-flow.addColumnHeaders', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const pos = editor.selection.active;
    const result = findRecordGroupAtLine(doc, pos.line);
    if (!result) {
      vscode.window.showInformationMessage('OPM Flow: no record table found at cursor');
      return;
    }
    const { groupLines, group } = result;
    const groupStartLine = groupLines[0];
    const groupPos = new vscode.Position(groupStartLine, 0);
    const kwName = findActiveKeyword(doc, groupPos);
    const entry = kwName ? index[kwName] : undefined;
    const record = entry ? findActiveRecord(doc, entry, groupPos) : 1;
    const tokens = group[0].tokens;
    const nCols = tokens.length;
    const names: string[] = [];
    let paramIdx = 1;
    for (const tok of tokens) {
      const param = entry
        ? findParam(entry, record, p => Number(p.index) === paramIdx)
        : undefined;
      names.push(param?.name ?? `COL${paramIdx}`);
      paramIdx += tokenColumnCount(tok);
    }
    const prevLineIdx = groupStartLine - 1;
    const hasHeading = prevLineIdx >= 0 && /^\s*--/.test(doc.lineAt(prevLineIdx).text);

    // When a heading already exists, use its positions as the stable anchor so that
    // calling the command multiple times is idempotent.
    if (hasHeading) {
      const existingPositions = parseHeadingPositions(doc.lineAt(prevLineIdx).text);
      if (existingPositions && existingPositions.length >= nCols) {
        const formattedRecords = formatRecordGroupWithHeading(group, existingPositions);
        // Rebuild heading at the same stable positions (1-space gap guaranteed)
        let newHeading = '--';
        for (let c = 0; c < nCols; c++) {
          const target = Math.max(existingPositions[c] ?? newHeading.length + 1, newHeading.length + 1);
          while (newHeading.length < target) newHeading += ' ';
          newHeading += names[c] ?? '';
        }
        await editor.edit(b => {
          for (let k = 0; k < groupLines.length; k++) {
            b.replace(doc.lineAt(groupLines[k]).range, formattedRecords[k]);
          }
          b.replace(doc.lineAt(prevLineIdx).range, newHeading);
        });
        return;
      }
    }

    const { heading, formattedRecords } = buildHeadingAndAlignedRecords(group, names);
    await editor.edit(b => {
      for (let k = 0; k < groupLines.length; k++) {
        b.replace(doc.lineAt(groupLines[k]).range, formattedRecords[k]);
      }
      if (hasHeading) {
        b.replace(doc.lineAt(prevLineIdx).range, heading);
      } else {
        b.insert(new vscode.Position(groupStartLine, 0), heading + '\n');
      }
    });

    // After inserting the heading, run align so records snap to the new heading positions
    const headingLine = hasHeading ? prevLineIdx : groupStartLine;
    const lastGroupLine = groupLines[groupLines.length - 1] + (hasHeading ? 0 : 1);
    const alignRange = new vscode.Range(headingLine, 0, lastGroupLine, 0);
    const alignEdits = computeAlignEdits(editor.document, alignRange);
    if (alignEdits.length > 0) {
      await editor.edit(b => { for (const e of alignEdits) b.replace(e.range, e.newText); });
    }
  });

  // --- Command: toggle line comment (`--` at the absolute start of line) ---
  const toggleCommentCommand = vscode.commands.registerCommand('opm-flow.toggleLineComment', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;

    // Toggle every line touched by any selection (deduplicated). A decision
    // (comment vs. uncomment) is made independently per contiguous selection
    // so each behaves like the editor's native toggle.
    await editor.edit(b => {
      for (const sel of editor.selections) {
        const firstLine = sel.start.line;
        // An empty trailing line in the selection (cursor at column 0 of the
        // line after the last selected character) should not be included.
        const lastLine = sel.end.line > sel.start.line && sel.end.character === 0
          ? sel.end.line - 1
          : sel.end.line;
        const originals: string[] = [];
        for (let ln = firstLine; ln <= lastLine; ln++) {
          originals.push(doc.lineAt(ln).text);
        }
        const toggled = toggleLineComments(originals);
        if (!toggled) continue;
        for (let k = 0; k < toggled.length; k++) {
          if (toggled[k] === originals[k]) continue;
          b.replace(doc.lineAt(firstLine + k).range, toggled[k]);
        }
      }
    });
  });

  const alignColumnsCommand = vscode.commands.registerCommand('opm-flow.alignRecordColumns', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const range = editor.selection.isEmpty ? undefined : editor.selection;
    const edits = computeAlignEdits(editor.document, range);
    if (edits.length === 0) {
      vscode.window.showInformationMessage('OPM Flow: no record groups to align');
      return;
    }
    await editor.edit(b => { for (const e of edits) b.replace(e.range, e.newText); });
  });

  // --- Command: open the corresponding .PRT print file ---
  const openPrtCommand = vscode.commands.registerCommand(
    'opm-flow.openPrtFile',
    async (resource?: vscode.Uri) => {
      // Invoked from the editor context menu with the resource URI; from the
      // command palette with no argument — fall back to the active editor.
      const target = resource ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') {
        vscode.window.showInformationMessage(
          'OPM Flow: open a .DATA file to view its .PRT output.',
        );
        return;
      }
      const found = prtCandidatePaths(target.fsPath).find(p => fs.existsSync(p));
      if (!found) {
        const base = path.basename(target.fsPath, path.extname(target.fsPath));
        vscode.window.showInformationMessage(
          `OPM Flow: no ${base}.PRT file found next to ${path.basename(target.fsPath)}. Run the deck first.`,
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(found));
      await vscode.window.showTextDocument(doc, { preview: false });
    },
  );

  // --- File-reference link provider (INCLUDE / IMPORT / RESTART / GDFILE) ---
  const fileLinkProvider = vscode.languages.registerDocumentLinkProvider(
    'opm-flow',
    new FileReferenceLinkProvider()
  );

  // --- Folding range provider ---
  const foldingProvider = vscode.languages.registerFoldingRangeProvider(
    'opm-flow',
    new OpmFlowFoldingRangeProvider()
  );

  // --- Outline tree view: section -> keyword navigation ---
  const outlineProvider = new OpmFlowOutlineProvider(index);
  const outlineView = vscode.window.createTreeView('opm-flow.outlineView', {
    treeDataProvider: outlineProvider,
  });
  outlineProvider.refresh(vscode.window.activeTextEditor?.document);

  const revealKeywordCommand = vscode.commands.registerCommand(
    'opm-flow.revealKeyword',
    async (uri: vscode.Uri, line: number) => {
      const editor = await vscode.window.showTextDocument(uri);
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter,
      );
    },
  );

  const refreshOutline = debounce((doc: vscode.TextDocument) => {
    outlineProvider.refresh(doc);
  }, 250);

  // Keep the tree's selection in sync with the cursor's active keyword.
  let lastRevealedLine = -1;
  const syncOutlineSelection = (editor: vscode.TextEditor): void => {
    if (editor.document.languageId !== 'opm-flow' || !outlineView.visible) return;
    const node = outlineProvider.nodeAtLine(editor.selection.active.line);
    if (!node || node.line === lastRevealedLine) return;
    lastRevealedLine = node.line;
    void outlineView.reveal(node, { select: true, focus: false });
  };

  context.subscriptions.push(
    outlineView,
    revealKeywordCommand,
    vscode.window.onDidChangeActiveTextEditor(editor => {
      outlineProvider.refresh(editor?.document);
      lastRevealedLine = -1;
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        refreshOutline(e.document);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection(e => {
      syncOutlineSelection(e.textEditor);
    }),
  );

  // --- Diagnostics: over-arity records and wrong-section keywords ---
  const summaryPatterns = loadSummaryPatterns(context);
  const diagnostics = vscode.languages.createDiagnosticCollection('opm-flow');
  const refreshDiags = debounce((doc: vscode.TextDocument) => {
    refreshDiagnostics(doc, index, diagnostics, summaryPatterns);
  }, 250);
  for (const editor of vscode.window.visibleTextEditors) {
    refreshDiagnostics(editor.document, index, diagnostics, summaryPatterns);
  }
  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(doc => refreshDiagnostics(doc, index, diagnostics, summaryPatterns)),
    vscode.workspace.onDidChangeTextDocument(e => refreshDiags(e.document)),
    vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('opm-flow.diagnostics.excludedKeywords')) return;
      for (const doc of vscode.workspace.textDocuments) {
        refreshDiagnostics(doc, index, diagnostics, summaryPatterns);
      }
    }),
  );

  context.subscriptions.push(completionProvider, valueCompletionProvider, codeActionProvider, hoverProvider, generateReferenceCommand, addColumnHeadersCommand, alignColumnsCommand, toggleCommentCommand, openPrtCommand, fileLinkProvider, foldingProvider);
}

export function deactivate(): void {}
