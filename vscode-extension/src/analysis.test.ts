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
// Multi-record arity (records_meta) — WELSEGS-style keywords
// ---------------------------------------------------------------------------

describe('computeDiagnostics — multi-record arity', () => {
  // WELSEGS-shaped fixture: rec 1 has 9 expected columns, rec 2 has 12.
  // The trailing rec 2 is variadic and absorbs all subsequent records.
  const multiIndex: Record<string, AnalysisEntry> = {
    ...index,
    WELSEGS: {
      name: 'WELSEGS',
      sections: ['SCHEDULE'],
      size_kind: 'list',
      records_meta: [
        { expected_columns: 9 },
        { expected_columns: 12 },
      ],
    },
    // VFPPROD-shaped: rec 1 has 9 cols, rec 2 has no expected_columns
    // (variadic ALL-arity item) — over-arity must NOT fire on rec 2.
    VFPPROD: {
      name: 'VFPPROD',
      sections: ['SCHEDULE'],
      size_kind: 'list',
      records_meta: [
        { expected_columns: 9 },
        {},
      ],
    },
  };

  it('uses the per-record column count for the first record', () => {
    // 10 cols on rec 1, expected 9 → over-arity.
    const lines = [
      'SCHEDULE',
      'WELSEGS',
      "'W' 100 100 1e-5 ABS HFA HO 0 0 99 /", // rec 1, 10 columns
      '/',                                    // block terminator
    ];
    const diags = computeDiagnostics(lines, multiIndex);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(2);
    expect(diags[0].message).toMatch(/in record 1/);
    expect(diags[0].message).toMatch(/10 values/);
    expect(diags[0].message).toMatch(/at most 9/);
  });

  it('uses the per-record column count for the second record', () => {
    // Rec 1 OK (9 cols), rec 2 has 13 cols, expected 12 → over-arity.
    const lines = [
      'SCHEDULE',
      'WELSEGS',
      "'W' 100 100 1e-5 ABS HFA HO 0 0 /",            // rec 1: 9
      '1 1 1 1 100 100 0.1 0.0001 0.01 1 0 0 99 /',  // rec 2: 13 → over
      '/',
    ];
    const diags = computeDiagnostics(lines, multiIndex);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(3);
    expect(diags[0].message).toMatch(/in record 2/);
    expect(diags[0].message).toMatch(/13 values/);
    expect(diags[0].message).toMatch(/at most 12/);
  });

  it('keeps using the last record for repeated trailing rows (variadic)', () => {
    // Three rec 2 rows; only the last is over-arity. The trailing record
    // absorbs all remaining lines — none of them should be checked
    // against rec 1's column count.
    const lines = [
      'SCHEDULE',
      'WELSEGS',
      "'W' 100 100 1e-5 ABS HFA HO 0 0 /",          // rec 1
      '1 1 1 1 100 100 0.1 0.0001 0.01 1 0 0 /',    // rec 2 ✓
      '2 2 1 1 200 200 0.1 0.0001 0.01 1 0 0 /',    // rec 2 ✓
      '3 3 1 1 300 300 0.1 0.0001 0.01 1 0 0 99 /', // rec 2 over (13)
      '/',
    ];
    const diags = computeDiagnostics(lines, multiIndex);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(5);
    expect(diags[0].message).toMatch(/in record 2/);
  });

  it('does not check arity on a record whose meta has no expected_columns', () => {
    // VFPPROD rec 2 is ALL-arity: any column count is legal.
    const lines = [
      'SCHEDULE',
      'VFPPROD',
      '1 1000 LIQ WCT GOR THP GRAT METRIC BHP /', // rec 1: 9 ✓
      '0.1 0.5 1.0 5.0 10.0 50.0 100.0 /',         // rec 2: 7, no check
      '/',
    ];
    expect(computeDiagnostics(lines, multiIndex)).toEqual([]);
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

  it('suppresses the wrong-section check after an INCLUDE (sections may be split across files)', () => {
    // SPE5-style master deck: RUNSPEC then an INCLUDE that pulls in the rest of
    // the sections, followed by SCHEDULE keywords written in the master file.
    const lines = [
      'RUNSPEC',
      'INCLUDE',
      "  'SPE5.BASE' /",
      'WELSPECS',         // SCHEDULE-only, but reachable via the included file
      "  'W1' 'G' 1 1 /",
      '/',
    ];
    const diags = computeDiagnostics(lines, index);
    expect(diags.some(d => /is not valid in/.test(d.message))).toBe(false);
  });

  it('still flags a wrong-section keyword when no INCLUDE precedes it', () => {
    const lines = ['RUNSPEC', 'WELSPECS', "  'W1' 'G' 1 1 /", '/'];
    const diags = computeDiagnostics(lines, index);
    expect(diags.some(d => /is not valid in/.test(d.message))).toBe(true);
  });

  it('re-enables the wrong-section check after a later section header resets the INCLUDE state', () => {
    const lines = [
      'RUNSPEC',
      'INCLUDE',
      "  'grid.inc' /",
      'GRID',             // explicit header resets the include-suppression
      'WELSPECS',         // SCHEDULE-only, now genuinely wrong
      "  'W1' 'G' 1 1 /",
      '/',
    ];
    const diags = computeDiagnostics(lines, index);
    expect(diags.some(d => /WELSPECS is not valid in GRID/.test(d.message))).toBe(true);
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

  // Regression for #31: a section header dressed with a trailing separator
  // must still advance the active section, otherwise every following keyword
  // is wrongly flagged as belonging to RUNSPEC.
  it('advances the section past a header with a trailing "===" separator', () => {
    const lines = ['RUNSPEC', 'GRID ==================', 'PORO', '0.1 /'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('handles a trailing separator with no space before it', () => {
    const lines = ['RUNSPEC', 'GRID==================', 'PORO', '0.1 /'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('flags a wrong-section keyword correctly after a decorated header', () => {
    const lines = ['GRID =====', 'WELSPECS', '/'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/WELSPECS is not valid in GRID/);
  });

  it('does not mistake a longer keyword for a decorated section', () => {
    // GRIDFILE / GRIDUNIT etc. must not be read as the GRID section.
    const lines = ['RUNSPEC', 'GRIDOPT'];
    const diags = computeDiagnostics(lines, index);
    // GRIDOPT is unknown here, so it gets the unknown-keyword diagnostic —
    // crucially it is NOT swallowed as a section header.
    expect(diags.some(d => d.message.includes('not a recognised'))).toBe(true);
  });

  it('points the diagnostic range at the keyword, not the indent', () => {
    const lines = ['RUNSPEC', '   WELSPECS', '/'];
    const diags = computeDiagnostics(lines, index);
    // Two issues: indented (column-1) and wrong section. Both anchor at
    // the keyword token, not the leading whitespace.
    expect(diags).toHaveLength(2);
    for (const d of diags) {
      expect(d.startChar).toBe(3);
      expect(d.endChar).toBe(3 + 'WELSPECS'.length);
    }
    expect(diags.some(d => d.message.includes('not valid in RUNSPEC'))).toBe(true);
    expect(diags.some(d => d.message.includes('start in column 1'))).toBe(true);
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

  it('accepts a fixed-size record whose terminating / is on its own line', () => {
    // OPM Flow allows the '/' to sit on a line after the values
    // (MINPV / PINCH / SPECGRID are commonly written this way).
    const lines = ['RUNSPEC', 'DIMENS', '10 10 10', '/'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('accepts a fixed-size record split across several value lines before the /', () => {
    const lines = ['RUNSPEC', 'DIMENS', '10', '10 10', '/'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('still flags a fixed-size record with no / before the next keyword', () => {
    const lines = ['RUNSPEC', 'DIMENS', '10 10 10', 'OIL'];
    const diags = computeDiagnostics(lines, index);
    const recordDiag = diags.find(d => d.message.includes('missing the terminating'));
    expect(recordDiag).toBeDefined();
    expect(recordDiag!.line).toBe(2);
  });

  it('accepts a list record whose values and / are on separate lines', () => {
    const lines = [
      'SCHEDULE',
      'WELSPECS',
      "'W1' 'G' 1 1",
      '/',                 // terminates the record
      '/',                 // terminates the list
    ];
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

  it('accepts a / line with bare trailing text as the list terminator', () => {
    // Issue #9: text after '/' is treated as a comment with or without '--'.
    const lines = [
      'SCHEDULE',
      'WELSPECS',
      "'W1' 'G' 1 1 /",
      '/   end of WELSPECS',
    ];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('accepts bare trailing text after a per-record /', () => {
    // Issue #9: trailing text after a per-record '/' is also a comment.
    const lines = [
      'SCHEDULE',
      'WELSPECS',
      "'W1' 'G' 1 1 / first well",
      "'W2' 'G' 2 2 / (2) second well",
      '/',
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

  it('does not require a closing / for a variadic-record list keyword (VFP-style)', () => {
    // A VFP table is a record list whose final table record is closed by its
    // own '/', with no separate standalone list terminator.
    const vfp = {
      VFPTAB: { name: 'VFPTAB', sections: ['SCHEDULE'], size_kind: 'list' as const, variadic_record: true },
    };
    const lines = [
      'SCHEDULE',
      'VFPTAB',
      '1 2249 /',
      '100 300 600 /',
      '30 54 /',
      '1 1 441.2 /',
    ];
    expect(computeDiagnostics(lines, vfp).some(d => /close the record list/.test(d.message))).toBe(false);
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

  it('does not flag an indented well-name body under a SUMMARY vector as unknown', () => {
    // A SUMMARY well vector takes a list of well names; when a single name sits
    // on its own indented line ('  PROD2 /') it must be read as body content,
    // not mistaken for an unknown keyword.
    const local = {
      ...index,
      SOFR: { name: 'SOFR', sections: ['SUMMARY'], optional_body: true },
    };
    const lines = ['SUMMARY', 'SOFR', '  PROD1 /', '  PROD2 /', '/'];
    expect(computeDiagnostics(lines, local).some(d => /not a recognised/.test(d.message))).toBe(false);
  });

  it('still flags an indented unknown token when no keyword block is active', () => {
    const lines = ['RUNSPEC', '   FOOBAR'];
    const diags = computeDiagnostics(lines, index);
    expect(diags.some(d => /FOOBAR is not a recognised/.test(d.message))).toBe(true);
  });

  it('does not flag user-defined quantity (UDQ) names as unknown', () => {
    // UDQ names begin with a data-type letter followed by 'U'. They are
    // user-defined (never in the index) but valid as bare SUMMARY mnemonics.
    const lines = ['SUMMARY', 'FU_VAR1', 'FU_TIME', 'WU_WBHP', 'GUOPR'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('still flags a typo that does not match the UDQ name shape', () => {
    const lines = ['RUNSPEC', 'WELSPECZ', '/'];
    const diags = computeDiagnostics(lines, index);
    expect(diags.some(d => /not a recognised/.test(d.message))).toBe(true);
  });

  it('does not flag region summary vectors qualified by a FIP region-set name', () => {
    // ROIP (region oil in place) is a region vector; ROIP_ABC adds the named
    // FIP region set "ABC". The base must exist in the index.
    const local = { ...index, ROIP: { name: 'ROIP', sections: ['SUMMARY'] } };
    const lines = ['SUMMARY', 'ROIP_ABC'];
    expect(computeDiagnostics(lines, local).some(d => /ROIP_ABC.*not a recognised/.test(d.message))).toBe(false);
  });

  it('does not flag L-modifier summary vectors built on an indexed base', () => {
    const local = {
      ...index,
      WOPR: { name: 'WOPR', sections: ['SUMMARY'] },
      WWIR: { name: 'WWIR', sections: ['SUMMARY'] },
    };
    // WOPRL = WOPR + trailing L (completion-level); LWWIR = leading L + WWIR (LGR-local).
    const lines = ['SUMMARY', 'WOPRL', 'LWWIR'];
    expect(computeDiagnostics(lines, local).some(d => /not a recognised/.test(d.message))).toBe(false);
  });

  it('recognises summary-vector family tokens via supplied deck_name_regex patterns', () => {
    // Tracer/water-cut family patterns from opm-common deck_name_regex,
    // anchored as the extension does before calling computeDiagnostics.
    const patterns = [/^(?:WTPR.+|WTPT.+)$/];
    const lines = ['SUMMARY', 'WTPRTR1', 'WTPTTR1'];
    expect(computeDiagnostics(lines, index, undefined, patterns)
      .some(d => /not a recognised/.test(d.message))).toBe(false);
  });

  it('still flags a token that matches no supplied pattern', () => {
    const patterns = [/^(?:WTPR.+)$/];
    const lines = ['SUMMARY', 'NOPE'];
    expect(computeDiagnostics(lines, index, undefined, patterns)
      .some(d => /NOPE.*not a recognised/.test(d.message))).toBe(true);
  });

  it('still flags an L-suffixed token whose stripped base is not a summary vector', () => {
    // "CONTROL" -> base "CONTRO" is not an indexed SUMMARY vector, so it is
    // still reported rather than silently accepted.
    const lines = ['SUMMARY', 'CONTROL'];
    expect(computeDiagnostics(lines, index).some(d => /CONTROL.*not a recognised/.test(d.message))).toBe(true);
  });

  it('still flags an underscore-suffixed token whose base is not a region vector', () => {
    // WOPR_X: base WOPR is a well (W) vector, not a region (R) vector, so the
    // region-set rule does not apply and the typo is still reported.
    const local = { ...index, WOPR: { name: 'WOPR', sections: ['SUMMARY'] } };
    const lines = ['SUMMARY', 'WOPR_X'];
    expect(computeDiagnostics(lines, local).some(d => /WOPR_X.*not a recognised/.test(d.message))).toBe(true);
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
// Column-1 — keywords must start in column 1
// ---------------------------------------------------------------------------

describe('computeDiagnostics — column-1', () => {
  it('flags an indented section keyword', () => {
    const lines = ['  RUNSPEC'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(0);
    expect(diags[0].startChar).toBe(2);
    expect(diags[0].endChar).toBe(2 + 'RUNSPEC'.length);
    expect(diags[0].message).toMatch(/RUNSPEC/);
    expect(diags[0].message).toMatch(/start in column 1/);
  });

  it('flags an indented known keyword', () => {
    const lines = ['SCHEDULE', '\tWELSPECS', '/'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(1);
    expect(diags[0].startChar).toBe(1);
    expect(diags[0].endChar).toBe(1 + 'WELSPECS'.length);
    expect(diags[0].message).toMatch(/start in column 1/);
  });

  it('does not flag a keyword that starts in column 1', () => {
    const lines = ['RUNSPEC', 'ACTDIMS', '1 2 3 4 /'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('does not duplicate the column-1 message on an unknown indented token', () => {
    // Unknown indented tokens already get the "not recognised" diagnostic;
    // we don't pile on a column-1 message because the user's first task is
    // to fix the typo.
    const lines = ['RUNSPEC', '   FOOBAR'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/not a recognised/);
  });

  it('flags an indented excluded keyword', () => {
    // Excluded keywords still need to start in column 1 to be recognised.
    const lines = ['SCHEDULE', '  RPTSCHED', "'WELLS=2' /", '/'];
    const custom = new Set(['RPTSCHED']);
    const diags = computeDiagnostics(lines, index, custom);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/RPTSCHED/);
    expect(diags[0].message).toMatch(/start in column 1/);
  });
});

// ---------------------------------------------------------------------------
// Uppercase — keywords must be in capital case
// ---------------------------------------------------------------------------

describe('computeDiagnostics — uppercase', () => {
  it('flags a fully lowercase keyword whose uppercase form is known', () => {
    const lines = ['SCHEDULE', 'welspecs', '/'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(1);
    expect(diags[0].startChar).toBe(0);
    expect(diags[0].endChar).toBe('welspecs'.length);
    expect(diags[0].message).toMatch(/WELSPECS/);
    expect(diags[0].message).toMatch(/capital case/);
  });

  it('flags a mixed-case section keyword', () => {
    const lines = ['Runspec'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/RUNSPEC/);
    expect(diags[0].message).toMatch(/capital case/);
  });

  it('does not flag a lowercase identifier that is not a real keyword', () => {
    // Without authoritative knowledge that the upper-cased form is a real
    // keyword, the line might be a legitimate value or label — stay quiet.
    const lines = ['RUNSPEC', 'pathlike'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });

  it('subsequent records are not arity-checked against the discarded keyword', () => {
    // The lowercase token is discarded (closeKw); records that follow are
    // not interpreted against an active block.
    const lines = ['RUNSPEC', 'actdims', '1 2 3 4 5 6'];
    const diags = computeDiagnostics(lines, index);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/capital case/);
  });

  it('does not flag uppercase keywords', () => {
    const lines = ['SCHEDULE', 'WELSPECS', '/'];
    expect(computeDiagnostics(lines, index)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unquoted strings — single-identifier lines mid-block (issue #8)
// ---------------------------------------------------------------------------

describe('computeDiagnostics — unquoted string values', () => {
  // INCLUDE-shaped fixture: fixed/1, takes one STRING parameter.
  const stringIndex: Record<string, AnalysisEntry> = {
    ...index,
    INCFIX: {
      name: 'INCFIX',
      sections: ['RUNSPEC'],
      size_kind: 'fixed',
      size_count: 1,
      expected_columns: 1,
    },
    // List-shaped: each record may carry a single (string) value.
    LICENSES: {
      name: 'LICENSES',
      sections: ['RUNSPEC'],
      size_kind: 'list',
      expected_columns: 1,
    },
  };

  it('does not flag an unquoted string value as an unknown keyword (fixed/1)', () => {
    // INCFIX expects 1 record. A bare uppercase identifier after the
    // keyword is plausibly an unquoted string value, not a typo'd keyword.
    const lines = ['RUNSPEC', 'INCFIX', 'PATH /'];
    expect(computeDiagnostics(lines, stringIndex)).toEqual([]);
  });

  it('treats an unquoted single-identifier line as an unquoted string in a list block', () => {
    const lines = [
      'RUNSPEC',
      'LICENSES',
      'TOKEN1 /',
      'TOKEN2 /',
      '/',
    ];
    expect(computeDiagnostics(lines, stringIndex)).toEqual([]);
  });

  it('still flags a real typo when no record block is open', () => {
    // No active block at the top of the file → the unknown-keyword
    // diagnostic remains useful for typos.
    const lines = ['RUNSPEC', 'WELSPECZ'];
    const diags = computeDiagnostics(lines, stringIndex);
    expect(diags.some(d => d.message.includes('WELSPECZ'))).toBe(true);
  });

  it('still treats a real keyword as a keyword even mid-block', () => {
    // INCLUDE is in the index, so it's a real keyword and closes the
    // previous (unterminated) block instead of being absorbed as a value.
    const lines = ['RUNSPEC', 'INCFIX', 'INCLUDE'];
    const diags = computeDiagnostics(lines, stringIndex);
    expect(diags.some(d => d.message.includes('INCLUDE is not a recognised'))).toBe(false);
  });

  it('treats an indented known-keyword name as a record value (EQLOPTS / THPRES)', () => {
    // THPRES is both a real SOLUTION keyword *and* a valid EQLOPTS
    // option name. Indented (not in column 1) under an open EQLOPTS
    // block it must be parsed as the EQLOPTS record value, not as a
    // misplaced THPRES keyword declaration.
    const eqloptsIndex: Record<string, AnalysisEntry> = {
      ...stringIndex,
      EQLOPTS: {
        name: 'EQLOPTS',
        sections: ['RUNSPEC'],
        size_kind: 'fixed',
        size_count: 1,
        expected_columns: 4,
      },
      THPRES: {
        name: 'THPRES',
        sections: ['SOLUTION'],
        size_kind: 'list',
        expected_columns: 3,
      },
    };
    const lines = ['RUNSPEC', 'EQLOPTS', ' THPRES  /'];
    expect(computeDiagnostics(lines, eqloptsIndex)).toEqual([]);
  });

  it('still flags a typo once the block is finished', () => {
    // After INCFIX's single record terminates with '/', the block is done.
    // A subsequent unknown identifier IS a typo, not a string value.
    const lines = ['RUNSPEC', 'INCFIX', 'PATH /', 'TYPO'];
    const diags = computeDiagnostics(lines, stringIndex);
    expect(diags.some(d => d.message.includes('TYPO is not a recognised'))).toBe(true);
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

// ---------------------------------------------------------------------------
// Issue #15 — SUMMARY mnemonics (FOPR, WOPR, GGOR, …) must be recognised
// ---------------------------------------------------------------------------

describe('computeDiagnostics — SUMMARY mnemonics (issue #15)', () => {
  // Field-scope mnemonics are bare (no trailing '/'); every other scope
  // takes a single record (a name list, or just '/' meaning "all"). The
  // build script generates these entries with size_kind='none' /
  // size_kind='fixed' + size_count=1 respectively, so the diagnostics
  // engine accepts all valid shapes without complaint — and crucially
  // does NOT demand a second standalone '/' to close the block, since
  // these mnemonics aren't list-shaped.
  const summaryIndex: Record<string, AnalysisEntry> = {
    ...index,
    FOPR: { name: 'FOPR', sections: ['SUMMARY'], size_kind: 'none' },
    FWPR: { name: 'FWPR', sections: ['SUMMARY'], size_kind: 'none' },
    WOPR: { name: 'WOPR', sections: ['SUMMARY'], size_kind: 'fixed', size_count: 1 },
    WWIR: { name: 'WWIR', sections: ['SUMMARY'], size_kind: 'fixed', size_count: 1 },
    GGOR: { name: 'GGOR', sections: ['SUMMARY'], size_kind: 'fixed', size_count: 1 },
    WOPT: { name: 'WOPT', sections: ['SUMMARY'], size_kind: 'fixed', size_count: 1 },
  };

  it('accepts bare field-scope mnemonics', () => {
    const lines = ['SUMMARY', 'FOPR', 'FWPR'];
    expect(computeDiagnostics(lines, summaryIndex)).toEqual([]);
  });

  it('accepts well/group mnemonics with just a bare /', () => {
    // "Apply to every well/group" form from the issue body.
    const lines = ['SUMMARY', 'WOPR', '/', 'GGOR', '/', 'WOPT', '/'];
    expect(computeDiagnostics(lines, summaryIndex)).toEqual([]);
  });

  it('accepts a well mnemonic followed by a list of well names', () => {
    // Exact shape from the user's report — must not trigger
    // "missing terminating '/'". WWIR is a single-record keyword;
    // the '/' on the same line as the well list is the record terminator.
    const lines = [
      'SUMMARY',
      'WWIR',
      " 'C-1H' 'C-2H' 'C-3H' 'C-4H' 'C-4AH' 'F-1H' 'F-2H' 'F-3H' 'F-4H' /",
    ];
    expect(computeDiagnostics(lines, summaryIndex)).toEqual([]);
  });

  it('does not flag SUMMARY mnemonics as unknown keywords', () => {
    // Pre-fix, FWPR / WOPR / GGOR were flagged as "not a recognised
    // OPM Flow keyword" because they're table rows in the manual rather
    // than per-keyword files.
    const lines = ['SUMMARY', 'FWPR', 'WOPR', '/'];
    const diags = computeDiagnostics(lines, summaryIndex);
    expect(diags.filter(d => /not a recognised/.test(d.message))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tracer mnemonic templates — FTPR + SEA -> FTPRSEA must be recognised
// ---------------------------------------------------------------------------

describe('computeDiagnostics — templated tracer mnemonics', () => {
  // Tracer mnemonic templates: the deck appends a user-defined tracer name
  // (FTPRSEA = FTPR + SEA). The build script tags the bases as templated;
  // the engine accepts any <template>+[A-Z0-9]+ token using the template's
  // size_kind / size_count for diagnostics.
  const tracerIndex: Record<string, AnalysisEntry> = {
    ...index,
    FTPR:  { name: 'FTPR',  sections: ['SUMMARY'], size_kind: 'none', templated: true },
    FTPRF: { name: 'FTPRF', sections: ['SUMMARY'], size_kind: 'none', templated: true },
    WTPC:  { name: 'WTPC',  sections: ['SUMMARY'], size_kind: 'fixed', size_count: 1, templated: true },
    WTIT:  { name: 'WTIT',  sections: ['SUMMARY'], size_kind: 'fixed', size_count: 1, templated: true },
    FAPI:  { name: 'FAPI',  sections: ['SUMMARY'], size_kind: 'none' }, // not templated
  };

  it('accepts a bare F-template + tracer-name token (issue example)', () => {
    // Norne-style line `FTPRSEA` — must not be flagged as unknown.
    const lines = ['SUMMARY', 'FTPRSEA'];
    expect(computeDiagnostics(lines, tracerIndex)).toEqual([]);
  });

  it('accepts a W-template + tracer-name with a well-list record', () => {
    // Exact shape from the user's tracer.data file.
    const lines = ['SUMMARY', 'WTITSEA', " 'C-1H' 'C-2H' /"];
    expect(computeDiagnostics(lines, tracerIndex)).toEqual([]);
  });

  it('prefers the shortest matching template', () => {
    // `FTPRSEA` could parse as FTPR+SEA or FTPRS+EA — without a TRACERS
    // list we can't tell. Prefer the base template (FTPR) because real
    // decks far more often use the unqualified form + tracer name than
    // the Free/Solution-qualified form. Diagnostic shape is identical
    // either way, so this is purely a hover-description choice.
    const lines = ['SUMMARY', 'FTPRSEA', 'FTPRFOO'];
    expect(computeDiagnostics(lines, tracerIndex)).toEqual([]);
  });

  it('does not accept arbitrary suffixes on non-templated entries', () => {
    // FAPI is a literal mnemonic — FAPIFOO must still be flagged as unknown.
    const lines = ['SUMMARY', 'FAPIFOO'];
    const diags = computeDiagnostics(lines, tracerIndex);
    expect(diags.some(d => /FAPIFOO is not a recognised/.test(d.message))).toBe(true);
  });

  it('does not match a template with an empty suffix', () => {
    // The template token itself is still treated as a normal entry; the
    // prefix path only fires when there's at least one suffix character.
    // (FTPR alone is recognised via the direct lookup, no templated path.)
    const lines = ['SUMMARY', 'FTPR'];
    expect(computeDiagnostics(lines, tracerIndex)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// User-defined FIP region templates — FIP + <REGION> resolves to FIP
// ---------------------------------------------------------------------------

describe('computeDiagnostics — templated FIP region keywords', () => {
  // FIP is documented in the OPM manual as a base name to which users
  // append a 1-5 character region label (FIPZON, FIPGL, FIPNL, FIPUNIT,
  // FIPHC, …). The build script tags FIP as templated so any
  // FIP+[A-Z0-9]+ deck token resolves to the FIP entry.
  const fipIndex: Record<string, AnalysisEntry> = {
    ...index,
    FIP:    { name: 'FIP',    sections: ['REGIONS'], templated: true },
    FIPNUM: { name: 'FIPNUM', sections: ['REGIONS'], size_kind: 'array' },
  };

  it('accepts a user-defined FIPZON region keyword (issue example)', () => {
    const lines = ['REGIONS', 'FIPZON', ' 1 1 1 1 1', ' 1 /'];
    expect(computeDiagnostics(lines, fipIndex)).toEqual([]);
  });

  it('still routes FIPNUM through its direct entry, not the FIP template', () => {
    // Direct lookup wins over the template fallback, so FIPNUM keeps
    // its own (array-shape) entry and isn't misclassified as a FIP.
    const lines = ['REGIONS', 'FIPNUM', ' 1 2 3 /'];
    expect(computeDiagnostics(lines, fipIndex)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SUMMARY mnemonic body — list of names spread across multiple lines
// ---------------------------------------------------------------------------

describe('computeDiagnostics — SUMMARY mnemonic list bodies', () => {
  // W/G/C/L/R/B/A/N/S-prefixed SUMMARY mnemonics take a list of names
  // closed by a single '/'. The names can sit on one line or be spread
  // across many; only the closing '/' completes the block. Modelled as
  // `size_kind: 'array'` so per-line missing-'/' checks are suppressed
  // but a missing block-end '/' is still flagged.
  const summaryIndex: Record<string, AnalysisEntry> = {
    ...index,
    WOPR: { name: 'WOPR', sections: ['SUMMARY'], size_kind: 'array' },
  };

  it('accepts names spread across multiple lines with a closing /', () => {
    // The exact case from the user's report.
    const lines = ['SUMMARY', 'WOPR', "  'PROD'", '/'];
    expect(computeDiagnostics(lines, summaryIndex)).toEqual([]);
  });

  it('accepts the inline form with a trailing /', () => {
    const lines = ['SUMMARY', 'WOPR', "  'PROD1' 'PROD2' /"];
    expect(computeDiagnostics(lines, summaryIndex)).toEqual([]);
  });

  it('accepts a bare / meaning "all wells"', () => {
    const lines = ['SUMMARY', 'WOPR', '/'];
    expect(computeDiagnostics(lines, summaryIndex)).toEqual([]);
  });

  it('still flags a block with no terminating /', () => {
    const lines = ['SUMMARY', 'WOPR', "  'PROD'"];
    const diags = computeDiagnostics(lines, summaryIndex);
    expect(diags.some(d => /WOPR.*missing terminating/.test(d.message))).toBe(true);
  });

  it('accepts back-to-back bare mnemonics closed by one trailing /', () => {
    // The widely-used GMWPR / GMWIN pattern: stack bare optional-body
    // mnemonics and close the lot with a single '/'.
    const optionalIndex: Record<string, AnalysisEntry> = {
      ...index,
      GMWPR: { name: 'GMWPR', sections: ['SUMMARY'], size_kind: 'array', optional_body: true },
      GMWIN: { name: 'GMWIN', sections: ['SUMMARY'], size_kind: 'array', optional_body: true },
    };
    const lines = ['SUMMARY', 'GMWPR', 'GMWIN', '/'];
    expect(computeDiagnostics(lines, optionalIndex)).toEqual([]);
  });

  it('accepts a single bare optional-body mnemonic with no body and no /', () => {
    const optionalIndex: Record<string, AnalysisEntry> = {
      ...index,
      GMWPR: { name: 'GMWPR', sections: ['SUMMARY'], size_kind: 'array', optional_body: true },
    };
    const lines = ['SUMMARY', 'GMWPR'];
    expect(computeDiagnostics(lines, optionalIndex)).toEqual([]);
  });

  it('still flags a missing / once values have been listed (optional_body)', () => {
    // optional_body only relaxes the empty-body case; once names appear
    // the missing-/ diagnostic must still fire.
    const optionalIndex: Record<string, AnalysisEntry> = {
      ...index,
      GMWPR: { name: 'GMWPR', sections: ['SUMMARY'], size_kind: 'array', optional_body: true },
    };
    const lines = ['SUMMARY', 'GMWPR', "  'PROD'"];
    const diags = computeDiagnostics(lines, optionalIndex);
    expect(diags.some(d => /GMWPR.*missing terminating/.test(d.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UDQ SUMMARY mnemonics — WU<UDQ-name>, FU<UDQ-name>, … resolve via
// scope-prefix templates (WU, FU, GU, CU, RU, SU)
// ---------------------------------------------------------------------------

describe('computeDiagnostics — UDQ SUMMARY mnemonic templates', () => {
  // UDQ summary mnemonics are documented in the manual under placeholder
  // names FUXXXXXX/WUXXXXXX/etc. The build script strips the trailing X's
  // and marks the prefix entry templated so deck tokens like WUWI1 or
  // FUOIL resolve through the standard <base>+[A-Z0-9]+ fallback.
  const udqIndex: Record<string, AnalysisEntry> = {
    ...index,
    FU: { name: 'FU', sections: ['SUMMARY'], size_kind: 'none', templated: true },
    WU: { name: 'WU', sections: ['SUMMARY'], size_kind: 'array', optional_body: true, templated: true },
  };

  it('recognises WUWI1 (issue example) as a templated WU mnemonic', () => {
    const lines = ['SUMMARY', 'WUWI1'];
    expect(computeDiagnostics(lines, udqIndex)).toEqual([]);
  });

  it('recognises FUOIL as a templated FU mnemonic', () => {
    const lines = ['SUMMARY', 'FUOIL'];
    expect(computeDiagnostics(lines, udqIndex)).toEqual([]);
  });

  it('accepts a WU<name> body of wells closed by /', () => {
    const lines = ['SUMMARY', 'WUWI1', "  'PROD1' 'PROD2' /"];
    expect(computeDiagnostics(lines, udqIndex)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MESSAGES — single 13-value record canonically split across multiple lines
// ---------------------------------------------------------------------------

describe('computeDiagnostics — MESSAGES variadic record', () => {
  // MESSAGES is a single record with 13 INT parameters, but real decks
  // routinely split it as print-limits then stop-limits across two lines
  // with the trailing '/' closing the whole record. Tagged variadic_record
  // so per-line missing-/ diagnostics are suppressed.
  const messagesIndex: Record<string, AnalysisEntry> = {
    ...index,
    MESSAGES: {
      name: 'MESSAGES',
      sections: ['RUNSPEC'],
      size_kind: 'fixed',
      size_count: 1,
      expected_columns: 13,
      variadic_record: true,
    },
  };

  it('accepts the print-limits / stop-limits split form (issue example)', () => {
    const lines = [
      'RUNSPEC',
      'MESSAGES',
      '-- mess comm  warn    prob  err  bug ',
      '  80000 10000 5000000 5000  300   1 ',
      '-- mess comm  warn    prob  err bug ',
      '  80000 10000 5000000 80000 10   1 /',
    ];
    expect(computeDiagnostics(lines, messagesIndex)).toEqual([]);
  });

  it('also accepts a heavily-decorated single-line form', () => {
    const lines = [
      'RUNSPEC',
      'MESSAGES',
      '  80000 10000 5000000 5000 300 1 80000 10000 5000000 80000 10 1 /',
    ];
    expect(computeDiagnostics(lines, messagesIndex)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// VFPPROD / VFPINJ — multi-record tables with multi-line records and no
// standalone closing '/'
// ---------------------------------------------------------------------------

describe('computeDiagnostics — VFPPROD multi-line record bodies', () => {
  // VFPPROD: header record + 5 axis records + repeating BHP-table record.
  // Each axis and BHP record spans many lines and ends with '/'. The block
  // itself does NOT end with a standalone '/' — the trailing record's '/'
  // is the natural end. Reclassified to 'fixed' so closeKw doesn't demand
  // a list terminator, plus variadic_record so per-line missing-/ checks
  // are suppressed on the multi-line axis/BHP rows.
  const vfpIndex: Record<string, AnalysisEntry> = {
    ...index,
    VFPPROD: {
      name: 'VFPPROD',
      sections: ['SCHEDULE'],
      size_kind: 'fixed',
      size_count: 7,
      variadic_record: true,
      records_meta: [
        { expected_columns: 9 }, {}, {}, {}, {}, {}, {},
      ],
    },
  };

  it('accepts the user-reported header + LIQ + THP form', () => {
    const lines = [
      'SCHEDULE',
      'VFPPROD',
      '-- Table   Datum Depth   Rate Type   WFR Type   GFR Type   THP Type   ALQ Type    UNITS     TAB Type',
      '       1          1535         LIQ        WCT        GOR        THP       PUMP     METRIC        BHP /',
      '-- LIQ units',
      '  100.0   123.0   151.0   185.0   228.0',
      '  280.0   344.0   423.0   519.0   638.0',
      '  784.0   963.0  1183.0  1454.0  1786.0',
      ' 2194.0  2696.0  3312.0  4070.0  5000.0 /',
      '-- THP units',
      '   2.00   18.00   35.00   51.00   68.00',
      '  84.00  101.00  117.00  134.00  150.00 /',
    ];
    expect(computeDiagnostics(lines, vfpIndex)).toEqual([]);
  });

  it('does not demand a standalone closing / on the block', () => {
    // The next keyword (WELSPECS) ends the VFPPROD block naturally;
    // closeKw must not emit a list-terminator diagnostic.
    const lines = [
      'SCHEDULE',
      'VFPPROD',
      ' 1 1535 LIQ WCT GOR THP PUMP METRIC BHP /',
      ' 100 200 300 /',
      ' 1 2 /',
      ' 0.4 /',
      ' 0.5 /',
      ' 100 /',
      ' 1 1 1 1 12.5 /',
      'WELSPECS',
      '/',
    ];
    const diags = computeDiagnostics(lines, vfpIndex);
    expect(diags.some(d => /VFPPROD.*missing terminating/.test(d.message))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TITLE — free-form text on the next line, no '/' terminator
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Variadic-record keywords — RSVD/RVVD/PVDO/PVTO records span multiple lines
// ---------------------------------------------------------------------------

describe('computeDiagnostics — variadic-record keywords', () => {
  // RSVD-shaped fixture: items have size_type=ALL, so each record can
  // continue across many lines and only the line containing '/' closes it.
  const variadicIndex: Record<string, AnalysisEntry> = {
    ...index,
    RSVD: {
      name: 'RSVD',
      sections: ['SOLUTION'],
      size_kind: 'fixed',
      variadic_record: true,
    },
  };

  it('does not flag intermediate continuation lines as missing a /', () => {
    // From the user's deck: each record is several data rows ending with
    // '/'. Pre-fix, every intermediate row was flagged "missing terminating
    // '/'" because the engine treated each line as its own record.
    const lines = [
      'SOLUTION',
      'RSVD',
      ' 2650.000 156.324',
      ' 2660.000 153.000',
      ' 2670.000 151.000',
      ' 2680.000 149.000',
      ' 2690.000 147.000',
      ' 2700.000 145.000 /',
      '',
      ' 2600.000 150.000',
      ' 2700.000 138.134 /',
    ];
    expect(computeDiagnostics(lines, variadicIndex)).toEqual([]);
  });

  it('still does not flag a record whose only line carries /', () => {
    const lines = ['SOLUTION', 'RSVD', ' 2650.0 156.3  2700.0 145.0 /'];
    expect(computeDiagnostics(lines, variadicIndex)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Issue #12 — TUNING is fixed/3 multi-record, not list. No closing '/'.
// ---------------------------------------------------------------------------

describe('computeDiagnostics — TUNING (issue #12)', () => {
  // TUNING is a 3-record keyword: records 1/2/3 have 10/13/11 columns.
  // It does NOT close with a standalone '/'. Pre-fix, the engine treated
  // it as size_kind='list' and demanded a trailing terminator, flagging
  // the example deck from the issue.
  const tuningIndex: Record<string, AnalysisEntry> = {
    ...index,
    TUNING: {
      name: 'TUNING',
      sections: ['SCHEDULE'],
      size_kind: 'fixed',
      size_count: 3,
      records_meta: [
        { expected_columns: 10 },
        { expected_columns: 13 },
        { expected_columns: 11 },
      ],
    },
  };

  it('accepts the issue-reported 3-record TUNING block', () => {
    const lines = [
      'SCHEDULE',
      'TUNING',
      ' 1 10 0.1 0.15 3 0.3 0.3 1.2 /',
      ' 5* 0.1 0.0001 0.02 0.02 /',
      ' 2* 40 1* 15 /',
    ];
    expect(computeDiagnostics(lines, tuningIndex)).toEqual([]);
  });

  it('does not demand a closing standalone / after TUNING', () => {
    const lines = [
      'SCHEDULE',
      'TUNING',
      ' 1 10 0.1 0.15 3 0.3 0.3 1.2 /',
      ' 5* 0.1 0.0001 0.02 0.02 /',
      ' 2* 40 1* 15 /',
      'WELSPECS',
      '/',
    ];
    const diags = computeDiagnostics(lines, tuningIndex);
    // The only legitimate diagnostic candidate would be on WELSPECS itself,
    // but it's a valid SCHEDULE keyword closed by '/', so no diagnostics.
    expect(diags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-keyword constraints — requires / prohibits (plan item 1)
// ---------------------------------------------------------------------------

describe('computeDiagnostics — requires / prohibits', () => {
  // BRANPROP requires NETWORK and prohibits GRUPNET (opm-common). AQUCT
  // requires AQUDIMS. THERMAL/TEMP are mutually exclusive — only THERMAL
  // declares the prohibition in opm-common, so the engine must report it
  // from whichever side carries the field.
  const xIndex: Record<string, AnalysisEntry> = {
    ...index,
    BRANPROP: {
      name: 'BRANPROP',
      sections: ['SCHEDULE'],
      size_kind: 'list',
      requires: ['NETWORK'],
      prohibits: ['GRUPNET'],
    },
    NETWORK: { name: 'NETWORK', sections: ['RUNSPEC'], size_kind: 'fixed', size_count: 1 },
    GRUPNET: { name: 'GRUPNET', sections: ['SCHEDULE'], size_kind: 'list' },
    AQUCT: { name: 'AQUCT', sections: ['SOLUTION'], size_kind: 'list', requires: ['AQUDIMS'] },
    AQUDIMS: { name: 'AQUDIMS', sections: ['RUNSPEC'], size_kind: 'fixed', size_count: 1 },
    THERMAL: { name: 'THERMAL', sections: ['RUNSPEC'], size_kind: 'none', prohibits: ['TEMP'] },
    TEMP: { name: 'TEMP', sections: ['PROPS'], size_kind: 'array' },
  };

  it('flags a keyword whose required partner is missing', () => {
    const lines = ['SCHEDULE', 'BRANPROP', '/'];
    const diags = computeDiagnostics(lines, xIndex);
    const req = diags.find(d => /requires NETWORK/.test(d.message));
    expect(req).toBeDefined();
    expect(req!.line).toBe(1);
    expect(req!.startChar).toBe(0);
    expect(req!.endChar).toBe('BRANPROP'.length);
  });

  it('does not flag when the required partner is present', () => {
    const lines = [
      'RUNSPEC',
      'NETWORK',
      '5 5 /',
      'SCHEDULE',
      'BRANPROP',
      '/',
    ];
    const diags = computeDiagnostics(lines, xIndex);
    expect(diags.some(d => /requires NETWORK/.test(d.message))).toBe(false);
  });

  it('suppresses the requires check when the deck pulls in an INCLUDE file', () => {
    // NETWORK may be defined in the included file, so don't cry wolf.
    const lines = [
      'RUNSPEC',
      'INCLUDE',
      "  'props.inc' /",
      'SCHEDULE',
      'BRANPROP',
      '/',
    ];
    const diags = computeDiagnostics(lines, xIndex);
    expect(diags.some(d => /requires NETWORK/.test(d.message))).toBe(false);
  });

  it('anchors the diagnostic on an indented requiring keyword token', () => {
    // (Indented keywords also get a column-1 diagnostic; the requires one
    // must still point at the token, not the indent.)
    const lines = ['SCHEDULE', '  BRANPROP', '/'];
    const diags = computeDiagnostics(lines, xIndex);
    const req = diags.find(d => /requires NETWORK/.test(d.message));
    expect(req).toBeDefined();
    expect(req!.startChar).toBe(2);
    expect(req!.endChar).toBe(2 + 'BRANPROP'.length);
  });

  it('flags a prohibits conflict when both keywords are present', () => {
    const lines = [
      'SCHEDULE',
      'BRANPROP',
      '/',
      'GRUPNET',
      "'FIELD' 1* 1* /",
      '/',
    ];
    const diags = computeDiagnostics(lines, xIndex);
    const con = diags.find(d => /BRANPROP cannot be used together with GRUPNET/.test(d.message));
    expect(con).toBeDefined();
    expect(con!.line).toBe(1);
  });

  it('does not flag a prohibits conflict when the partner is absent', () => {
    const lines = ['SCHEDULE', 'BRANPROP', '/', 'GRUPTREE', '/'];
    const diags = computeDiagnostics(lines, xIndex);
    expect(diags.some(d => /cannot be used together/.test(d.message))).toBe(false);
  });

  it('reports a prohibits pair only once even when declared from one side', () => {
    // THERMAL declares prohibits: [TEMP]; TEMP carries no prohibits field.
    const lines = ['RUNSPEC', 'THERMAL', 'PROPS', 'TEMP', '0.1 /'];
    const diags = computeDiagnostics(lines, xIndex);
    const conflicts = diags.filter(d => /mutually exclusive/.test(d.message));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].message).toMatch(/THERMAL cannot be used together with TEMP/);
  });

  it('reports each requirement independently for a multi-requires keyword', () => {
    const multi: Record<string, AnalysisEntry> = {
      ...xIndex,
      NODEPROP: {
        name: 'NODEPROP',
        sections: ['SCHEDULE'],
        size_kind: 'list',
        requires: ['NETWORK', 'BRANPROP'],
      },
    };
    // NETWORK present, BRANPROP missing → exactly one requires diagnostic.
    const lines = ['RUNSPEC', 'NETWORK', '5 5 /', 'SCHEDULE', 'NODEPROP', '/'];
    const diags = computeDiagnostics(lines, multi);
    const reqs = diags.filter(d => /NODEPROP requires/.test(d.message));
    expect(reqs).toHaveLength(1);
    expect(reqs[0].message).toMatch(/requires BRANPROP/);
  });

  it('keeps quiet for keywords with no constraints', () => {
    const lines = ['RUNSPEC', 'NETWORK', '5 5 /', 'AQUDIMS', '1 2 /'];
    const diags = computeDiagnostics(lines, xIndex);
    expect(diags.some(d => /requires|cannot be used together|mutually exclusive/.test(d.message))).toBe(false);
  });
});

describe('computeDiagnostics — TITLE accepts a bare title line', () => {
  const titleIndex: Record<string, AnalysisEntry> = {
    ...index,
    TITLE: { name: 'TITLE', sections: ['RUNSPEC'], size_kind: 'none' },
  };

  it('does not demand a trailing / after the title text', () => {
    // Real OPM Flow decks write the title as the next line, with no
    // record terminator. Marking TITLE size_kind='none' suppresses the
    // missing-/ diagnostic the items-based default would otherwise fire.
    const lines = ['RUNSPEC', 'TITLE', '   BASE MODEL 1'];
    expect(computeDiagnostics(lines, titleIndex)).toEqual([]);
  });
});
