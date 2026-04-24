import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface Parameter {
  index: number | string;
  name: string;
  description: string;
  units: { field?: string; metric?: string; laboratory?: string };
  default: string;
}

interface KeywordEntry {
  name: string;
  sections: string[];
  supported: boolean | null;
  summary: string;
  parameters: Parameter[];
  example: string;
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
// Record tokenizer
// ---------------------------------------------------------------------------

interface Token {
  text: string;
  start: number;
  end: number;
  columnCount: number;
}

function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    if (line[i] === '-' && line[i + 1] === '-') break;
    if (line[i] === '/') break;

    const start = i;
    let text: string;

    if (line[i] === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== "'") j++;
      text = line.substring(i, j + 1);
      i = j + 1;
    } else {
      let j = i;
      while (j < line.length && !/[\s/]/.test(line[j])) j++;
      text = line.substring(i, j);
      i = j;
    }

    const repeatMatch = text.match(/^(\d+)\*$/);
    const columnCount = repeatMatch ? parseInt(repeatMatch[1]) : 1;
    tokens.push({ text, start, end: i, columnCount });
  }
  return tokens;
}

function columnAtCursor(line: string, cursorChar: number): number {
  const tokens = tokenizeLine(line);
  let col = 1;
  for (const tok of tokens) {
    if (cursorChar >= tok.start && cursorChar < tok.end) return col;
    col += tok.columnCount;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Backward keyword scanner
// ---------------------------------------------------------------------------

const KEYWORD_LINE_RE = /^\s*([A-Z][A-Z0-9_+-]{1,})\s*(?:--|\/\s*(?:--|$)|$)/;

function findActiveKeyword(document: vscode.TextDocument, position: vscode.Position): string | null {
  const scanLimit = Math.max(0, position.line - 200);
  for (let lineNum = position.line; lineNum >= scanLimit; lineNum--) {
    const text = document.lineAt(lineNum).text;
    if (text.trim().startsWith('--')) continue;
    const m = text.match(KEYWORD_LINE_RE);
    if (m) return m[1];
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

function buildDocsHtml(entry: KeywordEntry | null, highlightParam: Parameter | null): string {
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
    p { margin: 4px 0 8px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9em; margin-bottom: 8px; }
    th {
      text-align: left; padding: 4px 6px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border: 1px solid var(--vscode-panel-border);
    }
    td { padding: 3px 6px; border: 1px solid var(--vscode-panel-border); vertical-align: top; }
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

  let paramsHtml = '';
  if (entry.parameters && entry.parameters.length > 0) {
    const hasUnits = entry.parameters.some(p => p.units && Object.keys(p.units).length > 0);
    const unitCols = hasUnits ? '<th>Field</th><th>Metric</th><th>Lab</th>' : '';
    const rows = entry.parameters.map(p => {
      const u = p.units ?? {};
      const unitCells = hasUnits
        ? `<td>${escHtml(u.field ?? '')}</td><td>${escHtml(u.metric ?? '')}</td><td>${escHtml(u.laboratory ?? '')}</td>`
        : '';
      const hl = highlightParam && highlightParam.index === p.index ? ' class="highlight"' : '';
      return `<tr${hl}><td>${p.index}</td><td><code>${escHtml(p.name)}</code></td><td>${escHtml(p.description)}</td>${unitCells}<td>${escHtml(p.default)}</td></tr>`;
    }).join('');
    paramsHtml = `<h2>Parameters</h2>
      <table><thead><tr><th>No.</th><th>Name</th><th>Description</th>${unitCols}<th>Default</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  const exampleHtml = entry.example
    ? `<h2>Example</h2><pre>${escHtml(entry.example)}</pre>`
    : '';

  const summaryHtml = entry.summary ? `<p>${escHtml(entry.summary)}</p>` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <style>${css}</style></head>
    <body>
      <h1><code>${escHtml(entry.name)}</code></h1>
      <p class="sections">Section${entry.sections.length > 1 ? 's' : ''}: ${escHtml(entry.sections.join(', '))}</p>
      ${summaryHtml}
      ${paramsHtml}
      ${exampleHtml}
    </body></html>`;
}

// ---------------------------------------------------------------------------
// Sidebar docs panel
// ---------------------------------------------------------------------------

class DocsViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _index: KeywordIndex
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this._view = view;
    view.webview.options = { enableScripts: false };
    view.webview.html = buildDocsHtml(null, null);
  }

  update(entry: KeywordEntry, param?: Parameter): void {
    if (this._view) {
      this._view.webview.html = buildDocsHtml(entry, param ?? null);
    }
  }
}

// ---------------------------------------------------------------------------
// Hover markdown builders (tooltip)
// ---------------------------------------------------------------------------

function buildKeywordHover(entry: KeywordEntry): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;

  md.appendMarkdown(`## \`${entry.name}\` — ${entry.sections.join(', ')}\n\n`);
  if (entry.summary) md.appendMarkdown(`${entry.summary}\n\n`);
  appendParameterTable(md, entry.parameters);
  if (entry.example) md.appendMarkdown(`**Example**\n\`\`\`\n${entry.example}\n\`\`\`\n`);
  return md;
}

function buildParameterHover(entry: KeywordEntry, param: Parameter): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.appendMarkdown(`**\`${entry.name}\` — parameter ${param.index}: \`${param.name}\`**\n\n`);
  md.appendMarkdown(`${param.description}\n\n`);
  const u = param.units ?? {};
  if (u.field || u.metric || u.laboratory) {
    md.appendMarkdown(`| Field | Metric | Laboratory |\n|-------|--------|------------|\n`);
    md.appendMarkdown(`| ${u.field ?? ''} | ${u.metric ?? ''} | ${u.laboratory ?? ''} |\n\n`);
  }
  md.appendMarkdown(`*Default: ${param.default || '—'}*`);
  return md;
}

function appendParameterTable(md: vscode.MarkdownString, parameters: Parameter[]): void {
  if (!parameters || parameters.length === 0) return;
  const hasUnits = parameters.some(p => p.units && Object.keys(p.units).length > 0);
  if (hasUnits) {
    md.appendMarkdown(`**Parameters**\n\n| No. | Name | Description | Field | Metric | Lab | Default |\n|-----|------|-------------|-------|--------|-----|---------|\n`);
    for (const p of parameters) {
      const u = p.units || {};
      md.appendMarkdown(`| ${p.index} | \`${p.name}\` | ${p.description} | ${u.field ?? ''} | ${u.metric ?? ''} | ${u.laboratory ?? ''} | ${p.default} |\n`);
    }
  } else {
    md.appendMarkdown(`**Parameters**\n\n| No. | Name | Description | Default |\n|-----|------|-------------|----------|\n`);
    for (const p of parameters) {
      md.appendMarkdown(`| ${p.index} | \`${p.name}\` | ${p.description} | ${p.default} |\n`);
    }
  }
  md.appendMarkdown('\n');
}

// ---------------------------------------------------------------------------
// Record-column alignment
// ---------------------------------------------------------------------------

const NUMERIC_TOKEN_RE = /^(\*|\d+\*|[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)$/;

interface RecordLine {
  indent: string;
  tokens: string[];
  trailComment: string;
  hasTerminator: boolean;
}

const KEYWORD_TOKEN_RE = /^[A-Z][A-Z0-9_+-]*$/;

function parseRecordLine(line: string): RecordLine | null {
  const indent = line.match(/^[ \t]*/)![0];
  let i = indent.length;
  const tokens: string[] = [];
  let hasTerminator = false;

  while (i < line.length) {
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= line.length) break;
    if (line[i] === '-' && line[i + 1] === '-') break;
    if (line[i] === '/') { hasTerminator = true; break; }

    const start = i;
    if (line[i] === "'") {
      i++;
      while (i < line.length && line[i] !== "'") i++;
      if (i < line.length) i++;
      tokens.push(line.substring(start, i));
    } else {
      while (i < line.length) {
        const c = line[i];
        if (c === ' ' || c === '\t' || c === '/') break;
        if (c === '-' && line[i + 1] === '-') break;
        i++;
      }
      tokens.push(line.substring(start, i));
    }
  }

  if (tokens.length === 0) return null;

  if (hasTerminator) {
    i++;
  } else if (tokens.length === 1 && KEYWORD_TOKEN_RE.test(tokens[0])) {
    // A lone uppercase identifier on a line is a keyword declaration, not a record.
    return null;
  }

  const rest = line.substring(i).replace(/^[ \t]+/, '').trimEnd();
  if (rest && !rest.startsWith('--')) return null;
  return { indent, tokens, trailComment: rest, hasTerminator };
}

function isCommentLine(line: string): boolean {
  return /^\s*--/.test(line);
}

function formatRecordGroup(records: RecordLine[]): string[] {
  const nCols = records[0].tokens.length;
  const widths = new Array(nCols).fill(0);
  const numeric = new Array(nCols).fill(true);
  for (const r of records) {
    for (let c = 0; c < nCols; c++) {
      const t = r.tokens[c];
      if (t.length > widths[c]) widths[c] = t.length;
      if (!NUMERIC_TOKEN_RE.test(t)) numeric[c] = false;
    }
  }
  const groupIndent = records[0].indent;
  return records.map(r => {
    const cells = r.tokens.map((t, c) =>
      numeric[c] ? t.padStart(widths[c]) : t.padEnd(widths[c])
    );
    const body = groupIndent + cells.join(' ') + (r.hasTerminator ? ' /' : '');
    return r.trailComment ? `${body} ${r.trailComment}` : body;
  });
}

// Parse absolute char positions of each word in a heading comment line (-- word1 word2 ...)
function parseHeadingPositions(line: string): number[] | null {
  const m = line.match(/^(\s*--\s*)(.*)/);
  if (!m) return null;
  const offset = m[1].length;
  const rest = m[2];
  if (!rest.trim()) return null;
  const positions: number[] = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && rest[i] === ' ') i++;
    if (i >= rest.length) break;
    positions.push(offset + i);
    while (i < rest.length && rest[i] !== ' ') i++;
  }
  return positions.length >= 2 ? positions : null;
}

// Format a record group aligning columns to heading word positions
function formatRecordGroupWithHeading(records: RecordLine[], headingPositions: number[]): string[] {
  const nCols = records[0].tokens.length;
  const maxWidth: number[] = new Array(nCols).fill(0);
  const numeric: boolean[] = new Array(nCols).fill(true);
  for (const r of records) {
    for (let c = 0; c < nCols; c++) {
      const t = r.tokens[c] ?? '';
      if (t.length > maxWidth[c]) maxWidth[c] = t.length;
      if (!NUMERIC_TOKEN_RE.test(t)) numeric[c] = false;
    }
  }
  // Compute actual column start positions; heading defines the minimum start
  const colStart: number[] = new Array(nCols).fill(0);
  colStart[0] = headingPositions[0] ?? 0;
  for (let c = 1; c < nCols; c++) {
    const prevEnd = colStart[c - 1] + maxWidth[c - 1];
    const fromHeading = headingPositions[c] ?? (prevEnd + 1);
    colStart[c] = Math.max(fromHeading, prevEnd + 1);
  }
  return records.map(r => {
    let line = '';
    for (let c = 0; c < nCols; c++) {
      const t = r.tokens[c];
      // numeric: right-align end to colStart[c] + maxWidth[c]; string: left-align to colStart[c]
      const pos = numeric[c] ? colStart[c] + maxWidth[c] - t.length : colStart[c];
      while (line.length < pos) line += ' ';
      line += t;
    }
    line = line.trimEnd() + (r.hasTerminator ? ' /' : '');
    return r.trailComment ? `${line} ${r.trailComment}` : line;
  });
}

// Build a heading comment and consistently aligned records in one pass
function buildHeadingAndAlignedRecords(
  records: RecordLine[],
  names: string[]
): { heading: string; formattedRecords: string[] } {
  const nCols = records[0].tokens.length;
  const dataWidths: number[] = new Array(nCols).fill(0);
  const numeric: boolean[] = new Array(nCols).fill(true);
  for (const r of records) {
    for (let c = 0; c < nCols; c++) {
      const t = r.tokens[c] ?? '';
      if (t.length > dataWidths[c]) dataWidths[c] = t.length;
      if (!NUMERIC_TOKEN_RE.test(t)) numeric[c] = false;
    }
  }
  // Effective column width = max of data width and heading name width
  const colWidths = dataWidths.map((w, c) => Math.max(w, names[c]?.length ?? 0));
  // Column start positions
  const baseIndent = records[0].indent.length;
  const colStarts: number[] = [baseIndent];
  for (let c = 1; c < nCols; c++) {
    colStarts[c] = colStarts[c - 1] + colWidths[c - 1] + 1;
  }
  // Build heading line — ensure at least one space before each name
  let heading = '--';
  for (let c = 0; c < nCols; c++) {
    const target = Math.max(colStarts[c], heading.length + 1);
    while (heading.length < target) heading += ' ';
    heading += names[c] ?? '';
  }
  // Build aligned record lines
  const formattedRecords = records.map(r => {
    let line = '';
    for (let c = 0; c < nCols; c++) {
      const t = r.tokens[c];
      const pos = numeric[c] ? colStarts[c] + colWidths[c] - t.length : colStarts[c];
      while (line.length < pos) line += ' ';
      line += t;
    }
    line = line.trimEnd() + (r.hasTerminator ? ' /' : '');
    return r.trailComment ? `${line} ${r.trailComment}` : line;
  });
  return { heading, formattedRecords };
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

const SECTION_KEYWORDS = [
  'RUNSPEC', 'GRID', 'EDIT', 'PROPS', 'REGIONS',
  'SOLUTION', 'SUMMARY', 'SCHEDULE', 'OPTIMIZE'
] as const;
const SECTION_KEYWORD_SET: ReadonlySet<string> = new Set(SECTION_KEYWORDS);

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
        const param = entry.parameters.find(p => p.index === col);
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
    })
  );

  // --- Completion provider ---
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

  // --- Hover provider (tooltip) ---
  const hoverProvider = vscode.languages.registerHoverProvider('opm-flow', {
    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
      const line = document.lineAt(position).text;

      const word = wordAtPosition(document, position);
      if (word && index[word]) return new vscode.Hover(buildKeywordHover(index[word]));

      const col = columnAtCursor(line, position.character);
      if (col < 1) return undefined;

      const kwName = findActiveKeyword(document, position);
      if (!kwName) return undefined;
      const entry = index[kwName];
      if (!entry?.parameters?.length) return undefined;

      const param = entry.parameters.find(p => p.index === col);
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
    const kwName = findActiveKeyword(doc, new vscode.Position(groupStartLine, 0));
    const entry = kwName ? index[kwName] : undefined;
    const nCols = group[0].tokens.length;
    const names: string[] = [];
    for (let c = 0; c < nCols; c++) {
      const param = entry?.parameters.find(p => Number(p.index) === c + 1);
      names.push(param?.name ?? `COL${c + 1}`);
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

  context.subscriptions.push(completionProvider, hoverProvider, generateReferenceCommand, addColumnHeadersCommand, alignColumnsCommand, includeLinkProvider, foldingProvider);
}

export function deactivate(): void {}
