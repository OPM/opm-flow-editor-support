import { computeDiagnostics, AnalysisIndex } from './analysis';
import { SUPPLEMENTAL_KEYWORDS, applyKeywordSupplement } from './keyword-supplement';

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
