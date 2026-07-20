// ---------------------------------------------------------------------------
// Record-shape regressions on the shipped keyword index.
//
// `analysis.test.ts` drives `computeDiagnostics` with a small hand-written
// fixture, which is right for exercising the analyzer's logic but cannot
// catch a keyword whose *shape* is mis-derived by the index build: an
// unknown keyword simply produces no shape diagnostics, so an assertion
// that "no terminator warning is emitted" passes for the wrong reason.
//
// These cases load the real `keyword_index_compact.json` and run the
// canonical deck blocks through the analyzer, so a bad `size_kind` or a
// dropped section fails the build.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { computeDiagnostics, AnalysisIndex } from './analysis';
import { prepareKeywordIndex } from './keyword-supplement';

function loadIndex(): AnalysisIndex {
  const p = path.join(__dirname, '..', 'data', 'keyword_index_compact.json');
  return prepareKeywordIndex(JSON.parse(fs.readFileSync(p, 'utf-8')) as AnalysisIndex);
}

describe('shipped index — record shapes', () => {
  const index = loadIndex();

  describe('ROCK', () => {
    // opm-common gives ROCK the sentinel size "SPECIAL_CASE_ROCK". Falling
    // through to the generic string branch made it list-kind, demanding a
    // standalone '/' that no deck writes — this fired on 366 of the 1440
    // decks in the opm-tests corpus.
    it('is dependent-count, not an unbounded list', () => {
      expect(index.ROCK.size_kind).toBe('fixed');
    });

    it('accepts the canonical SPE1 block with no standalone terminator', () => {
      const diags = computeDiagnostics(
        ['PROPS', 'ROCK', '\t14.7 3E-6 /', 'SWOF'],
        index,
      );
      expect(diags.find(d => d.code === 'missing-list-terminator')).toBeUndefined();
    });
  });

  describe('TEMPVD', () => {
    // Defined twice in opm-common: PROPS-only with two scalar items
    // (Eclipse100), and PROPS+SOLUTION with an EQLDIMS:NTEQUL size and one
    // size_type:ALL data item (Eclipse300). Keeping only the first dropped
    // the SOLUTION section and the dependent record count.
    it('keeps both dialects\' sections', () => {
      expect(index.TEMPVD.sections).toEqual(
        expect.arrayContaining(['PROPS', 'SOLUTION']),
      );
    });

    it('takes the shape of the dialect that declares a size', () => {
      expect(index.TEMPVD.size_kind).toBe('fixed');
    });

    it('accepts a SOLUTION table closed by a single /', () => {
      const diags = computeDiagnostics(
        ['SOLUTION', 'TEMPVD', '2000 80', '2100 80', '/'],
        index,
      );
      expect(diags.find(d => d.code === 'missing-list-terminator')).toBeUndefined();
      // Section validity carries no quick-fix code, so match the message.
      expect(diags.find(d => /is not valid in SOLUTION/.test(d.message))).toBeUndefined();
    });
  });
});
