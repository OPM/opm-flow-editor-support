import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  Token,
  tokenizeLine,
  columnAtCursor,
  columnForCompletion,
  RecordLine,
  parseRecordLine,
  isCommentLine,
  NUMERIC_TOKEN_RE,
  KEYWORD_TOKEN_RE,
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

interface Parameter {
  index: number | string;
  name: string;
  description: string;
  units: { field?: string; metric?: string; laboratory?: string };
  default: string;
  value_type?: string;        // INT | DOUBLE | STRING | RAW_STRING | UDA
  dimension?: string | string[]; // Length | Pressure | Time | … (may be a list for multi-column items)
  options?: string[];         // valid string values (extracted from the manual)
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
  const scanLimit = Math.max(0, position.line - 200);
  for (let lineNum = position.line; lineNum >= scanLimit; lineNum--) {
    const text = document.lineAt(lineNum).text;
    if (text.trim().startsWith('--')) continue;
    const m = text.match(KEYWORD_LINE_RE);
    if (m) return m[1];
  }
  return null;
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
  // 16 chars of [a-z0-9]; collision-irrelevant, only used to authorize the
  // single inline script we ship below.
  let out = '';
  for (let i = 0; i < 16; i++) out += Math.random().toString(36).charAt(2) || '0';
  return out;
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

  let paramsHtml = '';
  if (entry.parameters && entry.parameters.length > 0) {
    const hasUnits = entry.parameters.some(p => p.units && Object.keys(p.units).length > 0);
    const hasType  = entry.parameters.some(p => paramTypeLabel(p));
    const unitCols = hasUnits ? '<th>Field</th><th>Metric</th><th>Lab</th>' : '';
    const typeCol  = hasType ? '<th>Type</th>' : '';
    const rows = entry.parameters.map(p => {
      const u = p.units ?? {};
      const unitCells = hasUnits
        ? `<td>${escWithBreaks(u.field ?? '')}</td><td>${escWithBreaks(u.metric ?? '')}</td><td>${escWithBreaks(u.laboratory ?? '')}</td>`
        : '';
      const typeCell  = hasType ? `<td>${escWithBreaks(paramTypeLabel(p))}</td>` : '';
      const hl = highlightParam && highlightParam.index === p.index ? ' class="highlight"' : '';
      return `<tr${hl}><td>${p.index}</td><td><code>${escHtml(p.name)}</code></td><td>${escHtml(p.description)}</td>${typeCell}${unitCells}<td>${escHtml(p.default)}</td></tr>`;
    }).join('');
    paramsHtml = `<h2>Parameters</h2>
      <table><thead><tr><th>No.</th><th>Name</th><th>Description</th>${typeCol}${unitCols}<th>Default</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  const exampleHtml = entry.example
    ? `<h2>Example</h2><pre>${escHtml(entry.example)}</pre>`
    : '';

  const summaryHtml = entry.summary ? `<p>${escHtml(entry.summary)}</p>` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
    <style>${css}</style></head>
    <body>
      <h1><code>${escHtml(entry.name)}</code></h1>
      <p class="sections">Section${entry.sections.length > 1 ? 's' : ''}: ${escHtml(entry.sections.join(', '))}</p>
      ${summaryHtml}
      ${paramsHtml}
      ${exampleHtml}
      <script nonce="${n}">
        const hl = document.querySelector('tr.highlight');
        if (hl) hl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      </script>
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
    view.webview.options = { enableScripts: true };
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

function buildKeywordHover(
  entry: KeywordEntry,
  currentSection?: string | null,
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
  const typeLabel = paramTypeLabel(param);
  if (typeLabel) md.appendMarkdown(`*Type: ${typeLabel}*\n\n`);
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
  const hasType  = parameters.some(p => paramTypeLabel(p));
  const typeHead = hasType ? ' Type |' : '';
  const typeSep  = hasType ? '------|' : '';
  if (hasUnits) {
    md.appendMarkdown(`**Parameters**\n\n| No. | Name | Description |${typeHead} Field | Metric | Lab | Default |\n|-----|------|-------------|${typeSep}-------|--------|-----|---------|\n`);
    for (const p of parameters) {
      const u = p.units || {};
      const typeCell = hasType ? ` ${paramTypeLabel(p)} |` : '';
      md.appendMarkdown(`| ${p.index} | \`${p.name}\` | ${p.description} |${typeCell} ${u.field ?? ''} | ${u.metric ?? ''} | ${u.laboratory ?? ''} | ${p.default} |\n`);
    }
  } else {
    md.appendMarkdown(`**Parameters**\n\n| No. | Name | Description |${typeHead} Default |\n|-----|------|-------------|${typeSep}---------|\n`);
    for (const p of parameters) {
      const typeCell = hasType ? ` ${paramTypeLabel(p)} |` : '';
      md.appendMarkdown(`| ${p.index} | \`${p.name}\` | ${p.description} |${typeCell} ${p.default} |\n`);
    }
  }
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

function refreshDiagnostics(
  document: vscode.TextDocument,
  index: KeywordIndex,
  collection: vscode.DiagnosticCollection,
): void {
  if (document.languageId !== 'opm-flow') return;
  const lines: string[] = [];
  for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);
  const diags = computeDiagnostics(lines, index).map(d => {
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
        const param = entry.parameters.find(p => {
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

        return param.options.map(opt => {
          const quoted = `'${opt}'`;
          const item = new vscode.CompletionItem(quoted, vscode.CompletionItemKind.EnumMember);
          item.insertText = quoted;
          // Match against the bare option so typing `OP` still finds `'OPEN'`.
          item.filterText = opt;
          item.detail = `${kwName} parameter ${param.index}: ${param.name}`;
          if (param.description) item.documentation = new vscode.MarkdownString(param.description);
          if (replaceRange) item.range = replaceRange;
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
      if (word && index[word]) {
        const currentSection = findCurrentSection(document, position);
        return new vscode.Hover(buildKeywordHover(index[word], currentSection));
      }

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
    const tokens = group[0].tokens;
    const nCols = tokens.length;
    const names: string[] = [];
    let paramIdx = 1;
    for (const tok of tokens) {
      const param = entry?.parameters.find(p => Number(p.index) === paramIdx);
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
  );

  context.subscriptions.push(completionProvider, valueCompletionProvider, hoverProvider, generateReferenceCommand, addColumnHeadersCommand, alignColumnsCommand, includeLinkProvider, foldingProvider);
}

export function deactivate(): void {}
