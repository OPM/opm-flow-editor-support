#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SUBMODULE = 'opm-reference-manual';
const SUBMODULE_REPO = 'https://github.com/OPM/opm-reference-manual';
const MARK_START = '<!-- manual-ref:start -->';
const MARK_END = '<!-- manual-ref:end -->';

const readmeArg = process.argv[2];
if (!readmeArg) {
  console.error('Usage: sync-manual-ref.js <readme-path>');
  process.exit(1);
}

const readmePath = path.resolve(readmeArg);
const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

const lsTree = execSync(`git ls-tree HEAD ${SUBMODULE}`, { cwd: repoRoot, encoding: 'utf8' }).trim();
const match = lsTree.match(/^160000\s+commit\s+([0-9a-f]+)\t/);
if (!match) {
  console.error(`Could not parse submodule SHA from: ${lsTree}`);
  process.exit(1);
}
const sha = match[1];
const shortSha = sha.slice(0, 8);
const commitUrl = `${SUBMODULE_REPO}/commit/${sha}`;

const newLine = `Keyword data is built from [OPM/opm-reference-manual](${SUBMODULE_REPO}) at commit [\`${shortSha}\`](${commitUrl}).`;

const readme = fs.readFileSync(readmePath, 'utf8');
const startIdx = readme.indexOf(MARK_START);
const endIdx = readme.indexOf(MARK_END);
if (startIdx === -1 || endIdx === -1) {
  console.error(`Could not find ${MARK_START} ... ${MARK_END} markers in ${readmePath}`);
  process.exit(1);
}
const before = readme.slice(0, startIdx + MARK_START.length);
const after = readme.slice(endIdx);
const updated = `${before}\n${newLine}\n${after}`;

if (updated === readme) {
  console.log(`No change: ${readmePath} already at ${shortSha}`);
} else {
  fs.writeFileSync(readmePath, updated);
  console.log(`Updated ${readmePath} → ${shortSha}`);
}
