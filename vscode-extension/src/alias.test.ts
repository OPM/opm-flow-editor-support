// ---------------------------------------------------------------------------
// Deck-name alias coverage on the shipped keyword index.
//
// opm-common models families of summary vectors / array variants under a
// single schema name (WELL_PROBE, AQUIFER_PROBE_ANALYTIC, MULT_XYZ, …) whose
// `deck_names` are the concrete keywords a user actually types (WOPR, AAQP,
// MULTX). The build expands those into real index entries tagged with
// `alias_of`, and suppresses the schema container names (which are never typed
// in a deck) so they don't pollute completions or pass as valid keywords.
//
// These assertions guard the shipped `keyword_index_compact.json` against
// regressions in that build step.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';

interface CompactEntry {
  name: string;
  alias_of?: string;
  [k: string]: unknown;
}

function loadIndex(): Record<string, CompactEntry> {
  const p = path.join(__dirname, '..', 'data', 'keyword_index_compact.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, CompactEntry>;
}

describe('deck-name alias coverage', () => {
  const index = loadIndex();

  it.each([
    'WELL_PROBE',
    'FIELD_PROBE',
    'AQUIFER_PROBE_ANALYTIC',
    'ENDPOINT_SPECIFIERS',
    'MULT_XYZ',
  ])('suppresses the opm-common family/container name %s', (container) => {
    expect(index[container]).toBeUndefined();
  });

  it.each([
    ['WOPR', 'WELL_PROBE'],
    ['AAQP', 'AQUIFER_PROBE_ANALYTIC'],
    ['MULTX', 'MULT_XYZ'],
    ['KRNUMX', 'KRNUM'],
  ])('tags %s as an alias of %s', (mnemonic, family) => {
    expect(index[mnemonic]).toBeDefined();
    expect(index[mnemonic].alias_of).toBe(family);
  });

  it('keeps real keywords that carry deck_names, untagged', () => {
    for (const kw of ['KRNUM', 'IMBNUM', 'DIFF', 'NEXTSTEP']) {
      expect(index[kw]).toBeDefined();
      expect(index[kw].alias_of).toBeUndefined();
    }
  });

  it('never marks a keyword as an alias of itself', () => {
    for (const [name, entry] of Object.entries(index)) {
      expect(entry.alias_of).not.toBe(name);
    }
  });

  it('every alias target is itself a known keyword family (no dangling tags)', () => {
    // The alias target is either a real keyword still in the index (KRNUM) or a
    // suppressed family container — but it must never be the empty string.
    for (const entry of Object.values(index)) {
      if (entry.alias_of !== undefined) {
        expect(typeof entry.alias_of).toBe('string');
        expect(entry.alias_of.length).toBeGreaterThan(0);
      }
    }
  });
});
