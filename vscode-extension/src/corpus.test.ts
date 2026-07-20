// ---------------------------------------------------------------------------
// Corpus false-positive harness.
//
// The OPM/opm-tests repository (https://github.com/OPM/opm-tests) is a large
// collection of OPM Flow decks that are *mostly* known-good. That makes it a
// useful false-positive guard: a diagnostic this extension emits on those decks
// is a suspect — an analyzer bug, a keyword/shape the index is missing, or a
// keyword that belongs on the exclusion list.
//
// A suspect, not a verdict. The corpus is not all-good, and treating it as
// such leads to suppressing correct warnings. Confirmed counter-example:
//
//   spe1/SPE1CASE2_AQUFET.DATA writes AQUFET with no standalone '/'. AQUFET
//   declares items and no size, so opm-common classifies it SLASH_TERMINATED,
//   and RawKeyword::can_complete() is false for that size type — meaning the
//   next keyword does NOT end it. The parser swallows SUMMARY, FOPR, WGOR and
//   'PROD' as records and dies with "Malformed floating point number
//   'SUMMARY'". The deck does not load at all. Reported as OPM/opm-tests#1548.
//
// So before "fixing" an entry here, verify against the real thing — read the
// parser in opm-common, or run the deck:
//
//   flow <deck> --enable-dry-run=true
//
// Domain reasoning about what a keyword ought to mean is not sufficient; what
// the parser does is what decides whether a deck loads.
//
// This harness walks the corpus, runs `computeDiagnostics` on every text input
// file, aggregates the warnings by diagnostic *type* and *keyword*, and writes a
// triage report (corpus-report.md) next to the extension. It is gated on the
// corpus being present so the normal `npm test` run is unaffected:
//
//   - Point it at a clone with `OPM_TESTS_DIR=/path/to/opm-tests`, or
//   - drop the clone at the default path below.
//
// Run just this harness:  npx jest corpus
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { computeDiagnostics, AnalysisIndex, LineDiagnostic } from './analysis';
import { DEFAULT_DIAGNOSTICS_EXCLUDED_KEYWORDS } from './diagnostics-exclusions';
import { prepareKeywordIndex } from './keyword-supplement';

const DEFAULT_CORPUS = 'M:/gitroot/opm-tests';
const CORPUS_DIR = process.env.OPM_TESTS_DIR ?? DEFAULT_CORPUS;

const INPUT_EXTENSIONS = new Set([
  '.data', '.inc', '.sch', '.grdecl', '.vfp', '.pvt', '.incl', '.dat', '.prop', '.sattab',
]);

/** Diagnostic-type buckets, keyed off the stable parts of each message. */
type DiagType =
  | 'unrecognised-keyword'
  | 'wrong-section'
  | 'column-1'
  | 'lowercase'
  | 'missing-record-terminator'
  | 'missing-list-array-terminator'
  | 'over-arity'
  | 'value-type'
  | 'requires-missing'
  | 'prohibits-conflict'
  | 'other';

function classify(message: string): DiagType {
  if (/is not a recognised OPM Flow keyword/.test(message)) return 'unrecognised-keyword';
  if (/is not valid in /.test(message)) return 'wrong-section';
  if (/must start in column 1/.test(message)) return 'column-1';
  if (/must be in capital case/.test(message)) return 'lowercase';
  if (/record is missing the terminating/.test(message)) return 'missing-record-terminator';
  if (/missing terminating '\/'/.test(message)) return 'missing-list-array-terminator';
  if (/record has \d+ values; expected/.test(message)) return 'over-arity';
  if (/expects an integer|expects a number|is not a valid .* expected one of/.test(message)) return 'value-type';
  if (/requires .*which is not present/.test(message)) return 'requires-missing';
  if (/cannot be used together with/.test(message)) return 'prohibits-conflict';
  return 'other';
}

/** Pull the leading keyword token out of a message for per-keyword grouping. */
function keywordOf(message: string): string {
  const m = message.match(/^([A-Z][A-Z0-9_-]*)\b/);
  return m ? m[1] : '(?)';
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.git') continue;
      walk(full, out);
    } else if (e.isFile() && INPUT_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
}

function loadIndex(): AnalysisIndex {
  const p = path.join(__dirname, '..', 'data', 'keyword_index_compact.json');
  const index = JSON.parse(fs.readFileSync(p, 'utf-8')) as AnalysisIndex;
  return prepareKeywordIndex(index);
}

function loadSummaryPatterns(): RegExp[] {
  const p = path.join(__dirname, '..', 'data', 'summary_name_patterns.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as string[];
    return raw.map(src => new RegExp(`^(?:${src})$`));
  } catch {
    return [];
  }
}

const corpusPresent = fs.existsSync(CORPUS_DIR);
const describeCorpus = corpusPresent ? describe : describe.skip;

describeCorpus('opm-tests corpus false-positive harness', () => {
  it('runs computeDiagnostics over every deck and writes a triage report', () => {
    const index = loadIndex();
    const excluded = new Set(DEFAULT_DIAGNOSTICS_EXCLUDED_KEYWORDS);
    const summaryPatterns = loadSummaryPatterns();

    const files: string[] = [];
    walk(CORPUS_DIR, files);

    const byType = new Map<DiagType, number>();
    const byKeyword = new Map<string, { count: number; type: DiagType; example: string; file: string }>();
    const byFile = new Map<string, number>();
    let totalDiagnostics = 0;
    let scanned = 0;

    for (const file of files) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      scanned++;
      const lines = text.split(/\r?\n/);
      let diags: LineDiagnostic[];
      try {
        diags = computeDiagnostics(lines, index, excluded, summaryPatterns);
      } catch (err) {
        diags = [{ line: 0, startChar: 0, endChar: 0, message: `HARNESS-ERROR: ${String(err)}` }];
      }
      if (diags.length === 0) continue;
      const rel = path.relative(CORPUS_DIR, file).replace(/\\/g, '/');
      byFile.set(rel, diags.length);
      totalDiagnostics += diags.length;
      for (const d of diags) {
        const type = classify(d.message);
        byType.set(type, (byType.get(type) ?? 0) + 1);
        const kw = keywordOf(d.message);
        const key = `${type} ${kw}`;
        const prev = byKeyword.get(key);
        if (prev) {
          prev.count++;
        } else {
          byKeyword.set(key, { count: 1, type, example: d.message, file: rel });
        }
      }
    }

    // ----- report -----
    const md: string[] = [];
    md.push('# opm-tests corpus triage report');
    md.push('');
    md.push(`Corpus: \`${CORPUS_DIR}\``);
    md.push('');
    md.push(`- Files scanned: **${scanned}**`);
    md.push(`- Files with at least one diagnostic: **${byFile.size}**`);
    md.push(`- Total diagnostics (suspected false positives): **${totalDiagnostics}**`);
    md.push('');
    md.push('Most decks here are known-good, so a diagnostic below is a suspect:');
    md.push('an analyzer bug, a missing index keyword/shape, or an exclusion candidate.');
    md.push('');
    md.push('**A suspect, not a verdict.** The corpus is not all-good. Verify against');
    md.push('the parser (opm-common) or run `flow <deck> --enable-dry-run=true` before');
    md.push('treating an entry as a false positive — `AQUFET` in');
    md.push('`spe1/SPE1CASE2_AQUFET.DATA` is a real defect that stops the deck loading');
    md.push('(OPM/opm-tests#1548), not noise.');
    md.push('');

    md.push('## By diagnostic type');
    md.push('');
    md.push('| Type | Count |');
    md.push('| --- | ---: |');
    for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      md.push(`| ${type} | ${count} |`);
    }
    md.push('');

    md.push('## Top offenders by (type, keyword)');
    md.push('');
    md.push('| Count | Type | Keyword | Example message | First file |');
    md.push('| ---: | --- | --- | --- | --- |');
    const rows = [...byKeyword.values()].sort((a, b) => b.count - a.count).slice(0, 60);
    for (const r of rows) {
      const kw = keywordOf(r.example);
      const msg = r.example.replace(/\|/g, '\\|');
      md.push(`| ${r.count} | ${r.type} | ${kw} | ${msg} | ${r.file} |`);
    }
    md.push('');

    md.push('## Noisiest files');
    md.push('');
    md.push('| Diagnostics | File |');
    md.push('| ---: | --- |');
    for (const [rel, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      md.push(`| ${n} | ${rel} |`);
    }
    md.push('');

    // Full index-coverage worklist: every unique unrecognised keyword token,
    // most frequent first. Useful when deciding which keywords to add to the
    // index. Not truncated.
    const unknownTokens = new Map<string, number>();
    for (const { type, example, count } of byKeyword.values()) {
      if (type !== 'unrecognised-keyword') continue;
      const kw = keywordOf(example);
      unknownTokens.set(kw, (unknownTokens.get(kw) ?? 0) + count);
    }
    md.push('## All unrecognised keywords (index-coverage worklist)');
    md.push('');
    md.push(`${unknownTokens.size} unique tokens.`);
    md.push('');
    md.push('| Count | Keyword |');
    md.push('| ---: | --- |');
    for (const [kw, n] of [...unknownTokens.entries()].sort((a, b) => b[1] - a[1])) {
      md.push(`| ${n} | ${kw} |`);
    }
    md.push('');

    const reportPath = path.join(__dirname, '..', 'corpus-report.md');
    fs.writeFileSync(reportPath, md.join('\n'), 'utf-8');

    // eslint-disable-next-line no-console
    console.log(
      `\nCorpus harness: scanned ${scanned} files, ` +
      `${byFile.size} with diagnostics, ${totalDiagnostics} total.\n` +
      `Report: ${reportPath}\n` +
      `By type: ${[...byType.entries()].map(([t, c]) => `${t}=${c}`).join(', ')}`,
    );

    // The harness always passes; it is a reporting tool. Once the corpus is
    // triaged, tighten this into a baseline assertion (e.g. totalDiagnostics
    // must not exceed the agreed baseline).
    expect(scanned).toBeGreaterThan(0);
  }, 300000);
});
