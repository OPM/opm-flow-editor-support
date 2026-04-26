import { computeDiagnostics, AnalysisEntry } from './analysis';

const index: Record<string, AnalysisEntry> = {
  WELSPECS: {
    name: 'WELSPECS',
    expected_columns: 17,
    sections: ['SCHEDULE'],
  },
  ACTDIMS: {
    name: 'ACTDIMS',
    expected_columns: 4,
    sections: ['RUNSPEC'],
  },
  INCLUDE: {
    name: 'INCLUDE',
    sections: ['RUNSPEC', 'GRID', 'EDIT', 'PROPS', 'REGIONS', 'SOLUTION', 'SUMMARY', 'SCHEDULE'],
  },
  // Synthetic keyword without authoritative section data — must not trigger
  // section diagnostics.
  BARE: {
    name: 'BARE',
  },
};

// ---------------------------------------------------------------------------
// Arity checks
// ---------------------------------------------------------------------------

describe('computeDiagnostics — arity', () => {
  it('flags records with too many values', () => {
    const lines = ['RUNSPEC', 'ACTDIMS', '1 2 3 4 5 / -- one too many'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(2);
    expect(diags[0].message).toMatch(/ACTDIMS/);
    expect(diags[0].message).toMatch(/5 values/);
    expect(diags[0].message).toMatch(/at most 4/);
  });

  it('does not flag records with fewer values (auto-defaulted)', () => {
    const lines = ['RUNSPEC', 'ACTDIMS', '1 2 /'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('does not flag records with the exact expected count', () => {
    const lines = ['RUNSPEC', 'ACTDIMS', '1 2 3 4 /'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('counts N* as N columns', () => {
    const lines = ['RUNSPEC', 'ACTDIMS', '1 4* 5 /']; // 1 + 4 + 1 = 6
    const diags = computeDiagnostics(lines, index);
    expect(diags.find(d => d.message.includes('6 values'))).toBeDefined();
  });

  it('skips keywords without expected_columns', () => {
    const lines = ['RUNSPEC', 'BARE', '1 2 3 4 5 6 7 8 /'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('ignores comment lines and blank lines between records', () => {
    const lines = ['RUNSPEC', 'ACTDIMS', '-- a comment', '', '1 2 3 4 5 /'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Section validity checks
// ---------------------------------------------------------------------------

describe('computeDiagnostics — section validity', () => {
  it('flags a SCHEDULE-only keyword placed in RUNSPEC', () => {
    const lines = [
      'RUNSPEC',
      'WELSPECS',  // wrong section
    ];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(1);
    expect(diags[0].message).toMatch(/WELSPECS is not valid in RUNSPEC/);
    expect(diags[0].message).toMatch(/SCHEDULE/);
    // Range should cover just the keyword token
    expect(diags[0].startChar).toBe(0);
    expect(diags[0].endChar).toBe('WELSPECS'.length);
  });

  it('does not flag a keyword in one of its valid sections', () => {
    const lines = ['SCHEDULE', 'WELSPECS'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('does not flag a keyword that is valid in every section (e.g. INCLUDE)', () => {
    const lines = ['RUNSPEC', 'INCLUDE'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('skips section check for keywords without sections data', () => {
    const lines = ['RUNSPEC', 'BARE'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('skips section check before the first section header', () => {
    const lines = ['WELSPECS'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('points the diagnostic range at the keyword, not the indent', () => {
    const lines = ['RUNSPEC', '   WELSPECS'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].startChar).toBe(3);
    expect(diags[0].endChar).toBe(3 + 'WELSPECS'.length);
  });

  it('updates the active section when a new section keyword appears', () => {
    const lines = [
      'RUNSPEC',
      'ACTDIMS',
      '1 2 3 4 /',
      'SCHEDULE',
      'WELSPECS',  // now valid
    ];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });
});
