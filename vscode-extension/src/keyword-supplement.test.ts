import { computeDiagnostics, AnalysisIndex } from './analysis';
import {
  SUPPLEMENTAL_KEYWORDS,
  applyKeywordSupplement,
  normalizeSummaryVectorShapes,
} from './keyword-supplement';

describe('applyKeywordSupplement', () => {
  it('adds curated keywords that are absent from the index', () => {
    const index: AnalysisIndex = {};
    applyKeywordSupplement(index);
    expect(index['WELLSHUT']).toBeDefined();
    expect(index['FGDN']).toBeDefined();
    expect(index['CVTYPE']).toBeDefined();
  });

  it('does not overwrite an existing index entry', () => {
    const existing = { name: 'STORE', sections: ['RUNSPEC'], size_kind: 'fixed' as const };
    const index: AnalysisIndex = { STORE: existing };
    applyKeywordSupplement(index);
    expect(index['STORE']).toBe(existing);
  });
});

describe('computeDiagnostics with the supplement applied', () => {
  const index = applyKeywordSupplement({ ...SUPPLEMENTAL_KEYWORDS });

  it('recognises a bare field SUMMARY vector', () => {
    expect(computeDiagnostics(['SUMMARY', 'FGDN'], index)).toEqual([]);
  });

  it('absorbs the well-name list under WELLSHUT instead of flagging it', () => {
    const lines = ['SCHEDULE', 'WELLSHUT', 'INJ1 /', '/'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('recognises a thermal keyword with a numeric body', () => {
    const lines = ['PROPS', 'SPECHA', '0.83 4.81 0.009', '/'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });
});

describe('normalizeSummaryVectorShapes', () => {
  it('gives a shapeless SUMMARY vector the array shape', () => {
    const idx: AnalysisIndex = {
      CGMIRL: { name: 'CGMIRL', sections: ['SUMMARY'] },
      KRNUMX: { name: 'KRNUMX', sections: ['REGIONS'] },
    };
    normalizeSummaryVectorShapes(idx);
    expect(idx['CGMIRL'].size_kind).toBe('array');
    // Non-SUMMARY entries are untouched.
    expect(idx['KRNUMX'].size_kind).toBeUndefined();
  });

  it('does not override an existing size_kind', () => {
    const idx: AnalysisIndex = {
      FOPR: { name: 'FOPR', sections: ['SUMMARY'], size_kind: 'none' },
    };
    normalizeSummaryVectorShapes(idx);
    expect(idx['FOPR'].size_kind).toBe('none');
  });

  it('absorbs the well-name body of a normalised connection vector', () => {
    const idx = normalizeSummaryVectorShapes({
      CGMIRL: { name: 'CGMIRL', sections: ['SUMMARY'] },
      CGMITL: { name: 'CGMITL', sections: ['SUMMARY'] },
    });
    const lines = ['SUMMARY', 'CGMIRL', 'INJ1 /', '/', 'CGMITL', 'INJ1 /', '/'];
    expect(computeDiagnostics(lines, idx)).toEqual([]);
  });

  it('does not let a bare normalised vector swallow following UDQ mnemonics', () => {
    // PERFORMA is a bare enable-keyword; the UDQ summary names after it start
    // their own vectors and must not be absorbed as PERFORMA's name list (which
    // would then trip a missing-terminator diagnostic).
    const idx = normalizeSummaryVectorShapes({
      PERFORMA: { name: 'PERFORMA', sections: ['SUMMARY'] },
      WMCTL: { name: 'WMCTL', sections: ['SUMMARY'] },
    });
    const lines = ['SUMMARY', 'PERFORMA', 'FU_WBHP', 'FU_WBHP0', 'WMCTL'];
    expect(computeDiagnostics(lines, idx)).toEqual([]);
  });
});
