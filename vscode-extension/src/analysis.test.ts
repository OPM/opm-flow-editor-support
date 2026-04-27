import { computeDiagnostics, AnalysisEntry } from './analysis';

const index: Record<string, AnalysisEntry> = {
  PORO: {
    name: 'PORO',
    sections: ['GRID'],
    size_kind: 'array',
  },
  NTG: {
    name: 'NTG',
    sections: ['GRID'],
    size_kind: 'array',
  },
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

  it('does not flag value lines or missing list terminator for array-kind keywords', () => {
    // PORO is a cell-property array: no per-line '/' and no separate list
    // terminator. The single trailing '/' closes the value stream.
    const lines = [
      'GRID',
      'PORO',
      '0.1 0.2 0.3',
      '0.4 0.5 0.6',
      '/',
    ];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('also accepts an array-kind block whose values run right up to the / on the same line', () => {
    // Real-world array decks (ACTNUM, PORO, …) typically end with the '/'
    // trailing the last value line rather than on a line of its own.
    const lines = ['GRID', 'PORO', '0.1 0.2 0.3 /'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('flags an array-kind block that is missing the closing /', () => {
    const lines = [
      'GRID',
      'PORO',
      '0.1 0.2 0.3',
      '0.4 0.5 0.6',
      'NTG',          // next keyword without a '/' first
      '0.9 /',
    ];
    const diags = computeDiagnostics(lines, index);
    const arrDiag = diags.find(d => d.message.includes('close the value array'));
    expect(arrDiag).toBeDefined();
    expect(arrDiag!.message).toMatch(/PORO/);
    // Anchored at the end of the last PORO value line
    expect(arrDiag!.line).toBe(3);
  });

  it('flags an array-kind block that is missing the closing / at end of file', () => {
    const lines = ['GRID', 'PORO', '0.1 0.2 0.3'];
    const diags = computeDiagnostics(lines, index);
    expect(diags.some(d => d.message.includes('close the value array'))).toBe(true);
  });

  it('flags an empty array-kind block with no values and no /', () => {
    const lines = ['GRID', 'PORO', 'NTG', '0.1 /'];
    const diags = computeDiagnostics(lines, index);
    const arrDiag = diags.find(d => d.message.includes('close the value array'));
    expect(arrDiag).toBeDefined();
    // No records seen, so the squiggle anchors on the keyword name.
    expect(arrDiag!.line).toBe(1);
    expect(arrDiag!.startChar).toBe(0);
    expect(arrDiag!.endChar).toBe('PORO'.length);
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

// ---------------------------------------------------------------------------
// Unknown keyword detection
// ---------------------------------------------------------------------------

describe('computeDiagnostics — unknown keywords', () => {
  it('flags a keyword token that is not in the index', () => {
    const lines = ['RUNSPEC', 'WELSPECZ', '/'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(1);
    expect(diags[0].message).toMatch(/WELSPECZ/);
    expect(diags[0].message).toMatch(/not a recognised/);
    expect(diags[0].startChar).toBe(0);
    expect(diags[0].endChar).toBe('WELSPECZ'.length);
  });

  it('points the squiggle at the keyword, not the indent', () => {
    const lines = ['RUNSPEC', '   FOOBAR'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].startChar).toBe(3);
    expect(diags[0].endChar).toBe(3 + 'FOOBAR'.length);
  });

  it('does not flag section keywords as unknown', () => {
    // Section keywords are recognised even when absent from the supplied index.
    const lines = ['RUNSPEC', 'GRID', 'PROPS', 'SCHEDULE'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('does not flag keywords on the exclusion list', () => {
    // RPTSCHED is excluded — must not be flagged as unknown even though it's
    // absent from the supplied test index.
    const lines = ['SCHEDULE', 'RPTSCHED', "'WELLS=2' /", '/'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('does not run record-body checks after an unknown keyword', () => {
    // The only diagnostic should be the unknown-keyword one; the bogus record
    // line must not produce extra arity/terminator diagnostics.
    const lines = ['RUNSPEC', 'WELSPECZ', '1 2 3 4 5 6 7 8'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/WELSPECZ/);
  });
});

// ---------------------------------------------------------------------------
// Exclusion list — keywords opted out of diagnostics (e.g. RPTSCHED)
// ---------------------------------------------------------------------------

describe('computeDiagnostics — excluded keywords', () => {
  const indexWithRptsched: Record<string, AnalysisEntry> = {
    ...index,
    // Pretend opm-common claims RPTSCHED is RUNSPEC-only with a fixed arity.
    // None of these should produce diagnostics because RPTSCHED is excluded.
    RPTSCHED: {
      name: 'RPTSCHED',
      expected_columns: 1,
      sections: ['RUNSPEC'],
      size_kind: 'list',
    },
  };

  it('does not flag RPTSCHED in a section where it would otherwise be invalid', () => {
    const lines = ['SCHEDULE', 'RPTSCHED', "'WELLS=2' 'SUMMARY=2' 'CPU=2' /", '/'];
    expect(computeDiagnostics(lines, indexWithRptsched)).toEqual([]);
  });

  it('does not flag arity overflow on RPTSCHED records', () => {
    const lines = ['SCHEDULE', 'RPTSCHED', "'A' 'B' 'C' 'D' /", '/'];
    expect(computeDiagnostics(lines, indexWithRptsched)).toEqual([]);
  });

  it('does not flag a missing list terminator on RPTSCHED', () => {
    const lines = ['SCHEDULE', 'RPTSCHED', "'WELLS=2' /", 'WELSPECS', '/'];
    expect(computeDiagnostics(lines, indexWithRptsched)).toEqual([]);
  });

  it('honours a custom exclusion set passed to computeDiagnostics', () => {
    // The runtime threads the user-configured set through to the engine.
    // Same WELSPECS-in-RUNSPEC case that normally trips section-validity,
    // but with WELSPECS placed on the exclusion set the diagnostic must
    // be suppressed.
    const lines = ['RUNSPEC', 'WELSPECS', '/'];
    const custom = new Set(['WELSPECS']);
    expect(computeDiagnostics(lines, index, custom)).toEqual([]);
  });

  it('an empty exclusion set lets RPTSCHED be diagnosed normally', () => {
    // Sanity check the parameter is honoured even when empty: with the
    // default it would be silenced; with an explicit empty set the
    // section-validity diagnostic fires (the fixture pins RPTSCHED to
    // RUNSPEC, so SCHEDULE is invalid).
    const lines = ['SCHEDULE', 'RPTSCHED', "'WELLS=2' /", '/'];
    const empty: ReadonlySet<string> = new Set();
    const diags = computeDiagnostics(lines, indexWithRptsched, empty);
    expect(diags.some(d => d.message.includes('not valid in SCHEDULE'))).toBe(true);
  });
});
