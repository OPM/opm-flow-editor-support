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
  KEYWORD_LINE_RE,
  SECTION_KEYWORDS,
  SECTION_KEYWORD_SET,
  formatRecordGroup,
  parseHeadingPositions,
  formatRecordGroupWithHeading,
  buildHeadingAndAlignedRecords,
  tokenColumnCount,
} from './formatting';
import { computeDiagnostics } from './analysis';
import { DEFAULT_DIAGNOSTICS_EXCLUDED_KEYWORDS } from './diagnostics-exclusions';

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

// ---------------------------------------------------------------------------
// Backward keyword scanner
// ---------------------------------------------------------------------------

function findActiveKeyword(document: vscode.TextDocument, position: vscode.Position): string | null {
  for (let lineNum = position.line; lineNum >= 0; lineNum--) {
    const text = document.lineAt(lineNum).text;
    if (text.trim().startsWith('--')) continue;
    const m = text.match(KEYWORD_LINE_RE);
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
    if (KEYWORD_LINE_RE.test(text)) return lineNum;
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
    const m = text.match(KEYWORD_LINE_RE);
    if (m && SECTION_KEYWORD_SET.has(m[1])) return m[1];
  }
  return null;
}

function wordAtPosition(document: vscode.TextDocument, position: vscode.Position): string {
  const range = document.getWordRangeAtPosition(position, /[A-Z][A-Z0-9_-]*/);
  return range ? document.getText(range) : '';
}

// ---------------------------------------------------------------------------
// HTML builder for the sidebar docs panel
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
}

function getDocColumns(): DocColumns {
  const u = vscode.workspace.getConfiguration('opm-flow.units');
  const c = vscode.workspace.getConfiguration('opm-flow.columns');
  return {
    type:    c.get<boolean>('showType', true),
    field:   u.get<boolean>('showField', true),
    metric:  u.get<boolean>('showMetric', true),
    lab:     u.get<boolean>('showLab', true),
    default: c.get<boolean>('showDefault', true),
  };
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
      const u = p.units ?? {};
      const unitCells =
        (showField  ? `<td>${escWithBreaks(u.field ?? '')}</td>`      : '') +
        (showMetric ? `<td>${escWithBreaks(u.metric ?? '')}</td>`     : '') +
        (showLab    ? `<td>${escWithBreaks(u.laboratory ?? '')}</td>` : '');
      const typeCell    = showType    ? `<td>${escWithBreaks(paramTypes[idx])}</td>` : '';
      const defaultCell = showDefault ? `<td>${escHtml(p.default)}</td>`              : '';
      const sameRecord  = (highlightParam?.record ?? 1) === (p.record ?? 1);
      const hl = highlightParam && highlightParam.index === p.index && sameRecord
        ? ' class="highlight"' : '';
      const dataRecord = p.record !== undefined
        ? ` data-record="${escHtml(String(p.record))}"` : '';
      return `<tr data-param-index="${escHtml(String(p.index))}"${dataRecord}${hl}><td>${p.index}</td><td class="name"><code>${escHtml(p.name)}</code></td><td>${escHtml(p.description)}</td>${typeCell}${unitCells}${defaultCell}</tr>`;
    };

    const tableHead = `<thead><tr><th>No.</th><th class="name">Name</th><th>Description</th>${typeCol}${unitCols}${defaultCol}</tr></thead>`;

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
    view.webview.options = { enableScripts: true };
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
  md.isTrusted = true;
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
  md.isTrusted = true;
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

      const m = text.match(KEYWORD_LINE_RE);
      if (!m) continue;

      const kw = m[1];
      const prevEnd = i - 1;

      if (kw === 'END') {
        pushRange(keywordStart, prevEnd);
        pushRange(sectionStart, prevEnd);
        keywordStart = -1;
        sectionStart = -1;
        continue;
      }

      if (SECTION_KEYWORD_SET.has(kw)) {
        pushRange(keywordStart, prevEnd);
        pushRange(sectionStart, prevEnd);
        keywordStart = -1;
        sectionStart = i;
      } else {
        pushRange(keywordStart, prevEnd);
        keywordStart = i;
      }
    }

    const lastLine = document.lineCount - 1;
    pushRange(keywordStart, lastLine);
    pushRange(sectionStart, lastLine);

    return ranges;
  }
}

// ---------------------------------------------------------------------------
// INCLUDE file link provider
// ---------------------------------------------------------------------------

// Matches a bare INCLUDE keyword line (no path), e.g. "INCLUDE", "INCLUDE -- comment", "INCLUDE / -- comment"
const INCLUDE_KW_RE = /^\s*INCLUDE\s*(?:--|\/\s*(?:--|$)|$)/;
const INCLUDE_PATH_RE = /^\s*'([^']+)'/;
// Maximum number of lines to scan after INCLUDE for the quoted path
const INCLUDE_MAX_LOOKAHEAD = 4;

class IncludeLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    if (!document.uri.fsPath) return links;
    const docDir = path.dirname(document.uri.fsPath);

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;
      if (!INCLUDE_KW_RE.test(line)) continue;

      // The path is on the next non-blank, non-comment line after INCLUDE
      for (let j = i + 1; j < Math.min(i + INCLUDE_MAX_LOOKAHEAD, document.lineCount); j++) {
        const nextLine = document.lineAt(j).text;
        if (/^\s*(--|$)/.test(nextLine)) continue;

        const m = INCLUDE_PATH_RE.exec(nextLine);
        if (!m) break;

        const quotedPath = m[1];
        const startChar = nextLine.indexOf("'") + 1;
        const endChar = startChar + quotedPath.length;
        const range = new vscode.Range(j, startChar, j, endChar);
        const absPath = path.resolve(docDir, quotedPath);
        const uri = vscode.Uri.file(absPath);
        links.push(new vscode.DocumentLink(range, uri));
        break;
      }
    }

    return links;
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

function refreshDiagnostics(
  document: vscode.TextDocument,
  index: KeywordIndex,
  collection: vscode.DiagnosticCollection,
): void {
  if (document.languageId !== 'opm-flow') return;
  const lines = document.getText().split(/\r?\n/);
  const excluded = getExcludedKeywords(document.uri);
  const diags = computeDiagnostics(lines, index, excluded).map(d => {
    const range = new vscode.Range(d.line, d.startChar, d.line, d.endChar);
    const out = new vscode.Diagnostic(range, d.message, vscode.DiagnosticSeverity.Warning);
    out.source = 'OPM Flow';
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

export function activate(context: vscode.ExtensionContext): void {
  const index = loadKeywordIndex(context);
  const keywords = Object.keys(index);

  // --- Sidebar docs panel ---
  const docsProvider = new DocsViewProvider(context.extensionUri, index);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('opm-flow.docsView', docsProvider)
  );

  // --- Cursor-driven docs update ---
  const onCursorMove = debounce((editor: vscode.TextEditor) => {
    const pos = editor.selection.active;
    const line = editor.document.lineAt(pos).text;

    const word = wordAtPosition(editor.document, pos);
    if (word && index[word]) {
      docsProvider.update(index[word]);
      return;
    }

    const col = columnAtCursor(line, pos.character);
    if (col >= 1) {
      const kwName = findActiveKeyword(editor.document, pos);
      const entry = kwName ? index[kwName] : undefined;
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
        e.affectsConfiguration('opm-flow.columns')
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
        return keywords.map((kw) => {
          const entry = index[kw];
          const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
          item.detail = `[${entry.sections.join(', ')}] OPM Flow`;
          if (entry.summary) item.documentation = new vscode.MarkdownString(entry.summary);
          return item;
        });
      },
    },
    ...('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))
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

      const word = wordAtPosition(document, position);
      const excluded = getExcludedKeywords(document.uri);
      if (word && index[word]) {
        const currentSection = findCurrentSection(document, position);
        return new vscode.Hover(
          buildKeywordHover(index[word], currentSection, excluded.has(word)),
        );
      }

      // Excluded keyword not in the index: still show a short notice so the
      // user knows why no diagnostics or docs appear on it.
      if (word && excluded.has(word)) {
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

  // --- INCLUDE file link provider ---
  const includeLinkProvider = vscode.languages.registerDocumentLinkProvider(
    'opm-flow',
    new IncludeLinkProvider()
  );

  // --- Folding range provider ---
  const foldingProvider = vscode.languages.registerFoldingRangeProvider(
    'opm-flow',
    new OpmFlowFoldingRangeProvider()
  );

  // --- Diagnostics: over-arity records and wrong-section keywords ---
  const diagnostics = vscode.languages.createDiagnosticCollection('opm-flow');
  const refreshDiags = debounce((doc: vscode.TextDocument) => {
    refreshDiagnostics(doc, index, diagnostics);
  }, 250);
  for (const editor of vscode.window.visibleTextEditors) {
    refreshDiagnostics(editor.document, index, diagnostics);
  }
  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(doc => refreshDiagnostics(doc, index, diagnostics)),
    vscode.workspace.onDidChangeTextDocument(e => refreshDiags(e.document)),
    vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('opm-flow.diagnostics.excludedKeywords')) return;
      for (const doc of vscode.workspace.textDocuments) {
        refreshDiagnostics(doc, index, diagnostics);
      }
    }),
  );

  context.subscriptions.push(completionProvider, valueCompletionProvider, hoverProvider, generateReferenceCommand, addColumnHeadersCommand, alignColumnsCommand, includeLinkProvider, foldingProvider);
}

export function deactivate(): void {}
