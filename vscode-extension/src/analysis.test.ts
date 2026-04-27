import { computeDiagnostics, AnalysisEntry } from './analysis';

const index: Record<string, AnalysisEntry> = {
  WELSPECS: {
    name: 'WELSPECS',
    expected_columns: 17,
    sections: ['SCHEDULE'],
    size_kind: 'list',
  },
  ACTDIMS: {
    name: 'ACTDIMS',
    expected_columns: 4,
    sections: ['RUNSPEC'],
    size_kind: 'fixed',
  },
  DIMENS: {
    name: 'DIMENS',
    expected_columns: 3,
    sections: ['RUNSPEC'],
    size_kind: 'fixed',
  },
  OIL: {
    name: 'OIL',
    sections: ['RUNSPEC'],
    size_kind: 'none',
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
    // Range pins to the offending token, not the whole line
    expect(diags[0].startChar).toBe('1 2 3 4 '.length);
    expect(diags[0].endChar).toBe('1 2 3 4 5'.length);
  });

  it('pins overflow range to the first offending N* token', () => {
    // ACTDIMS expected=4; "1 4* 5 /" yields 1 + 4 + 1 = 6 columns.
    // The 4* itself drives total to 5, so the overflow starts there.
    const lines = ['RUNSPEC', 'ACTDIMS', '1 4* 5 /'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].startChar).toBe('1 '.length);
    expect(diags[0].endChar).toBe('1 4* 5'.length);
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

  it('does not treat a section header as a record-owning keyword', () => {
    // If a section keyword's index entry happens to carry expected_columns,
    // records that follow it must not be checked against that arity.
    const sectionWithArity: Record<string, AnalysisEntry> = {
      ...index,
      RUNSPEC: { name: 'RUNSPEC', expected_columns: 2, sections: [] },
      ACTDIMS: index.ACTDIMS,
    };
    // No active record-owning keyword between RUNSPEC and the record line.
    const lines = ['RUNSPEC', '1 2 3 4 5 /'];
    expect(computeDiagnostics(lines, sectionWithArity)).toEqual([]);
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
      '/',
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
    const lines = ['SCHEDULE', 'WELSPECS', '/'];
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
    const lines = ['WELSPECS', '/'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('points the diagnostic range at the keyword, not the indent', () => {
    const lines = ['RUNSPEC', '   WELSPECS', '/'];
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
      'WELSPECS',
      '/',
    ];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Record / list terminator checks
// ---------------------------------------------------------------------------

describe('computeDiagnostics — terminators', () => {
  it('flags a fixed-size record line that is missing the trailing /', () => {
    const lines = ['RUNSPEC', 'DIMENS', '10 10 10'];
    const diags = computeDiagnostics(lines, index);
    const recordDiag = diags.find(d => d.message.includes('missing the terminating'));
    expect(recordDiag).toBeDefined();
    expect(recordDiag!.line).toBe(2);
    expect(recordDiag!.startChar).toBe('10 10 '.length);
    expect(recordDiag!.endChar).toBe('10 10 10'.length);
  });

  it('does not flag a fixed-size record line that ends with /', () => {
    const lines = ['RUNSPEC', 'DIMENS', '10 10 10 /'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('flags a list-keyword block missing its terminating / before the next keyword', () => {
    const lines = [
      'SCHEDULE',
      'WELSPECS',
      "'W1' 'G' 1 1 /",
      'INCLUDE',
    ];
    const diags = computeDiagnostics(lines, index);
    const listDiag = diags.find(d => d.message.includes('close the record list'));
    expect(listDiag).toBeDefined();
    // Anchored at the end of the last record in the WELSPECS block
    expect(listDiag!.line).toBe(2);
  });

  it('flags a list-keyword block missing the / at end of file', () => {
    const lines = [
      'SCHEDULE',
      'WELSPECS',
      "'W1' 'G' 1 1 /",
    ];
    const diags = computeDiagnostics(lines, index);
    expect(diags.some(d => d.message.includes('close the record list'))).toBe(true);
  });

  it('does not flag a list-keyword block closed by a standalone /', () => {
    const lines = [
      'SCHEDULE',
      'WELSPECS',
      "'W1' 'G' 1 1 /",
      '/',
    ];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('accepts a / line with a trailing comment as the list terminator', () => {
    const lines = [
      'SCHEDULE',
      'WELSPECS',
      "'W1' 'G' 1 1 /",
      '/   -- end of WELSPECS',
    ];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('does not require / for a "none"-kind keyword like OIL', () => {
    const lines = ['RUNSPEC', 'OIL', 'DIMENS', '10 10 10 /'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('skips terminator checks for keywords without size_kind', () => {
    const lines = ['RUNSPEC', 'BARE', '1 2 3'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('flags both missing record terminator and missing list terminator', () => {
    const lines = [
      'SCHEDULE',
      'WELSPECS',
      "'W1' 'G' 1 1",  // record missing /
      // no closing / before EOF either
    ];
    const diags = computeDiagnostics(lines, index);
    expect(diags.some(d => d.message.includes('missing the terminating'))).toBe(true);
    expect(diags.some(d => d.message.includes('close the record list'))).toBe(true);
  });
});
