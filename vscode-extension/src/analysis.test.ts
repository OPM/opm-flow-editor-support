import {
  computeArityDiagnostics,
  AnalysisEntry,
} from './analysis';

// ---------------------------------------------------------------------------
// computeArityDiagnostics
// ---------------------------------------------------------------------------

describe('computeArityDiagnostics', () => {
  const index: Record<string, AnalysisEntry> = {
    WELSPECS: { name: 'WELSPECS', expected_columns: 17 },
    ACTDIMS:  { name: 'ACTDIMS',  expected_columns: 4 },
    BARE:     { name: 'BARE' },  // no expected_columns — should be skipped
  };

  it('flags records with too many values', () => {
    const lines = [
      'ACTDIMS',
      '1 2 3 4 5 / -- one too many',
    ];
    const diags = computeArityDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(1);
    expect(diags[0].message).toMatch(/ACTDIMS/);
    expect(diags[0].message).toMatch(/5 values/);
    expect(diags[0].message).toMatch(/at most 4/);
  });

  it('does not flag records with fewer values (auto-defaulted)', () => {
    const lines = ['ACTDIMS', '1 2 /'];
    expect(computeArityDiagnostics(lines, index)).toEqual([]);
  });

  it('does not flag records with the exact expected count', () => {
    const lines = ['ACTDIMS', '1 2 3 4 /'];
    expect(computeArityDiagnostics(lines, index)).toEqual([]);
  });

  it('counts N* as N columns', () => {
    const lines = ['ACTDIMS', '1 4* 5 /']; // 1 + 4 + 1 = 6 → too many
    const diags = computeArityDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/6 values/);
  });

  it('skips keywords without expected_columns', () => {
    const lines = ['BARE', '1 2 3 4 5 6 7 8 /'];
    expect(computeArityDiagnostics(lines, index)).toEqual([]);
  });

  it('switches keyword context across the document', () => {
    const lines = [
      'ACTDIMS',
      '1 2 3 4 /',     // ok
      '/',
      'WELSPECS',
      `'W1' 'G1' 1 1 /`,   // ok (5 values, < 17)
    ];
    expect(computeArityDiagnostics(lines, index)).toEqual([]);
  });

  it('ignores comment lines and blank lines between records', () => {
    const lines = [
      'ACTDIMS',
      '-- a comment',
      '',
      '1 2 3 4 5 /',
    ];
    const diags = computeArityDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(3);
  });

  it('returns empty when no keyword matches the index', () => {
    const lines = ['UNKNOWN', '1 2 3 /'];
    expect(computeArityDiagnostics(lines, index)).toEqual([]);
  });
});
