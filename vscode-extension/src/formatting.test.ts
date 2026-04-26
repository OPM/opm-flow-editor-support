import {
  tokenizeLine,
  columnAtCursor,
  columnForCompletion,
  parseRecordLine,
  isCommentLine,
  formatRecordGroup,
  parseHeadingPositions,
  formatRecordGroupWithHeading,
  buildHeadingAndAlignedRecords,
  tokenColumnCount,
  RecordLine,
} from './formatting';

// ---------------------------------------------------------------------------
// tokenizeLine
// ---------------------------------------------------------------------------

describe('tokenizeLine', () => {
  test('basic tokens', () => {
    const tokens = tokenizeLine('  1.0  2.0  3.0');
    expect(tokens.map(t => t.text)).toEqual(['1.0', '2.0', '3.0']);
    expect(tokens.every(t => t.columnCount === 1)).toBe(true);
  });

  test('single default marker *', () => {
    const tokens = tokenizeLine('  1.0  *  3.0');
    expect(tokens[1].text).toBe('*');
    expect(tokens[1].columnCount).toBe(1);
  });

  test('repeat default 5* expands columnCount', () => {
    const tokens = tokenizeLine('  5*');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].text).toBe('5*');
    expect(tokens[0].columnCount).toBe(5);
  });

  test('1* is a single default with columnCount 1', () => {
    const tokens = tokenizeLine('  1*');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].text).toBe('1*');
    expect(tokens[0].columnCount).toBe(1);
  });

  test('mixed explicit values and defaults', () => {
    const tokens = tokenizeLine('1.0 2* 4.0');
    expect(tokens.map(t => t.text)).toEqual(['1.0', '2*', '4.0']);
    expect(tokens[1].columnCount).toBe(2);
    expect(tokens[0].columnCount).toBe(1);
    expect(tokens[2].columnCount).toBe(1);
  });

  test('stops at line comment --', () => {
    const tokens = tokenizeLine('1.0 2.0 -- this is a comment');
    expect(tokens.map(t => t.text)).toEqual(['1.0', '2.0']);
  });

  test('stops at record terminator /', () => {
    const tokens = tokenizeLine('1.0 2.0 / extra stuff');
    expect(tokens.map(t => t.text)).toEqual(['1.0', '2.0']);
  });

  test('quoted string token is preserved as-is', () => {
    const tokens = tokenizeLine("'WELL-1' 1.0");
    expect(tokens[0].text).toBe("'WELL-1'");
    expect(tokens[1].text).toBe('1.0');
  });

  test('start/end positions are correct', () => {
    const tokens = tokenizeLine('  100  200');
    expect(tokens[0].start).toBe(2);
    expect(tokens[0].end).toBe(5);
    expect(tokens[1].start).toBe(7);
    expect(tokens[1].end).toBe(10);
  });

  test('empty line returns empty array', () => {
    expect(tokenizeLine('')).toEqual([]);
  });

  test('line with only whitespace returns empty array', () => {
    expect(tokenizeLine('   ')).toEqual([]);
  });

  test('line with only comment returns empty array', () => {
    expect(tokenizeLine('-- just a comment')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tokenColumnCount
// ---------------------------------------------------------------------------

describe('tokenColumnCount', () => {
  test('plain numeric token spans 1 column', () => {
    expect(tokenColumnCount('1.5')).toBe(1);
    expect(tokenColumnCount('100')).toBe(1);
  });

  test('quoted string token spans 1 column', () => {
    expect(tokenColumnCount("'WELL-1'")).toBe(1);
  });

  test('bare * default marker spans 1 column', () => {
    expect(tokenColumnCount('*')).toBe(1);
  });

  test('N* repeats span N columns', () => {
    expect(tokenColumnCount('3*')).toBe(3);
    expect(tokenColumnCount('5*')).toBe(5);
    expect(tokenColumnCount('10*')).toBe(10);
  });

  test('1* spans 1 column', () => {
    expect(tokenColumnCount('1*')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// columnAtCursor — honours N* column skipping
// ---------------------------------------------------------------------------

describe('columnAtCursor', () => {
  test('returns 1-based column for simple tokens', () => {
    const line = '10.0 20.0 30.0';
    // cursor on first token
    expect(columnAtCursor(line, 0)).toBe(1);
    expect(columnAtCursor(line, 3)).toBe(1);
    // cursor on second token
    expect(columnAtCursor(line, 5)).toBe(2);
    // cursor on third token
    expect(columnAtCursor(line, 10)).toBe(3);
  });

  test('5* skips 5 parameter columns', () => {
    const line = '5* 999';
    // cursor on "5*" is column 1
    expect(columnAtCursor(line, 0)).toBe(1);
    // cursor on "999" is column 6 (5* consumed cols 1-5)
    expect(columnAtCursor(line, 3)).toBe(6);
  });

  test('cursor not on any token returns -1', () => {
    // trailing whitespace after terminator / is not a token
    expect(columnAtCursor('1.0 /', 5)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// parseRecordLine
// ---------------------------------------------------------------------------

describe('parseRecordLine', () => {
  test('basic record with multiple tokens', () => {
    const r = parseRecordLine('  1.0 2.0 3.0');
    expect(r).not.toBeNull();
    expect(r!.tokens).toEqual(['1.0', '2.0', '3.0']);
    expect(r!.indent).toBe('  ');
    expect(r!.hasTerminator).toBe(false);
    expect(r!.trailComment).toBe('');
  });

  test('record with / terminator', () => {
    const r = parseRecordLine('1.0 2.0 /');
    expect(r).not.toBeNull();
    expect(r!.tokens).toEqual(['1.0', '2.0']);
    expect(r!.hasTerminator).toBe(true);
  });

  test('record with trailing comment after /', () => {
    const r = parseRecordLine('1.0 2.0 / -- my comment');
    expect(r).not.toBeNull();
    expect(r!.trailComment).toBe('-- my comment');
    expect(r!.hasTerminator).toBe(true);
  });

  test('keyword-only line (uppercase word) returns null', () => {
    expect(parseRecordLine('WELSPECS')).toBeNull();
    expect(parseRecordLine('GRID')).toBeNull();
  });

  test('comment line returns null', () => {
    expect(parseRecordLine('-- this is a comment')).toBeNull();
    expect(parseRecordLine('  -- indented comment')).toBeNull();
  });

  test('blank line returns null', () => {
    expect(parseRecordLine('')).toBeNull();
    expect(parseRecordLine('   ')).toBeNull();
  });

  test('N* default token is kept as a single token', () => {
    const r = parseRecordLine('  5* 100.0');
    expect(r).not.toBeNull();
    expect(r!.tokens).toEqual(['5*', '100.0']);
  });

  test('line consisting only of a default token', () => {
    const r = parseRecordLine('  3*');
    expect(r).not.toBeNull();
    expect(r!.tokens).toEqual(['3*']);
  });

  test('record with numeric and string tokens', () => {
    const r = parseRecordLine("  'WELL-1' 1.0 2* /");
    expect(r).not.toBeNull();
    expect(r!.tokens).toEqual(["'WELL-1'", '1.0', '2*']);
    expect(r!.hasTerminator).toBe(true);
  });

  test('non-comment, non-slash suffix is treated as an additional token', () => {
    // parseRecordLine collects all whitespace-delimited tokens (no type checking).
    // A dash-separated word is still a valid token (only '--' stops parsing).
    const r = parseRecordLine('1.0 2.0 extra');
    expect(r).not.toBeNull();
    expect(r!.tokens).toEqual(['1.0', '2.0', 'extra']);
  });
});

// ---------------------------------------------------------------------------
// isCommentLine
// ---------------------------------------------------------------------------

describe('isCommentLine', () => {
  test('pure comment', () => { expect(isCommentLine('-- comment')).toBe(true); });
  test('indented comment', () => { expect(isCommentLine('  -- comment')).toBe(true); });
  test('data line', () => { expect(isCommentLine('1.0 2.0')).toBe(false); });
  test('blank line', () => { expect(isCommentLine('')).toBe(false); });
});

// ---------------------------------------------------------------------------
// formatRecordGroup — integer right-alignment
// ---------------------------------------------------------------------------

describe('formatRecordGroup — integer columns', () => {
  function makeRecord(tokens: string[], opts?: Partial<RecordLine>): RecordLine {
    return { indent: '', tokens, trailComment: '', hasTerminator: false, ...opts };
  }

  test('integers are right-aligned within the widest value', () => {
    const records: RecordLine[] = [
      makeRecord(['1', '200', '30']),
      makeRecord(['100', '2', '3']),
    ];
    const result = formatRecordGroup(records);
    // col widths: 3, 3, 2
    expect(result[0]).toBe('  1 200 30');
    expect(result[1]).toBe('100   2  3');
  });

  test('single row: no change needed', () => {
    const records = [makeRecord(['42', '100'])];
    // single-record groups are formatted consistently (no grouping needed at call level)
    const result = formatRecordGroup(records);
    expect(result[0]).toBe('42 100');
  });

  test('indent is preserved', () => {
    const records = [
      { indent: '  ', tokens: ['1', '2'], trailComment: '', hasTerminator: false },
      { indent: '  ', tokens: ['10', '20'], trailComment: '', hasTerminator: false },
    ];
    const result = formatRecordGroup(records);
    expect(result[0]).toBe('   1  2');
    expect(result[1]).toBe('  10 20');
  });

  test('hasTerminator appends /', () => {
    const records = [
      makeRecord(['1', '2'], { hasTerminator: true }),
      makeRecord(['10', '20'], { hasTerminator: true }),
    ];
    const result = formatRecordGroup(records);
    expect(result[0]).toBe(' 1  2 /');
    expect(result[1]).toBe('10 20 /');
  });

  test('trailing comment is preserved', () => {
    const records = [
      makeRecord(['1', '2'], { trailComment: '-- row A' }),
      makeRecord(['10', '20']),
    ];
    const result = formatRecordGroup(records);
    expect(result[0]).toBe(' 1  2 -- row A');
    expect(result[1]).toBe('10 20');
  });
});

// ---------------------------------------------------------------------------
// formatRecordGroup — float decimal-point alignment
// ---------------------------------------------------------------------------

describe('formatRecordGroup — float columns aligned at decimal point', () => {
  function makeRecord(tokens: string[]): RecordLine {
    return { indent: '', tokens, trailComment: '', hasTerminator: false };
  }

  test('float column: decimal points are vertically aligned', () => {
    const records = [
      makeRecord(['1.5']),
      makeRecord(['10.0']),
    ];
    const result = formatRecordGroup(records);
    // col 0: maxIntLen=2 ("10"), maxDecLen=2 (".0"/.5"), effectiveWidth=4
    // "1.5"  → intPart=" 1", decPart=".5", padEnd(4) → " 1.5"
    // "10.0" → intPart="10", decPart=".0", padEnd(4) → "10.0"
    expect(result[0]).toBe(' 1.5');
    expect(result[1]).toBe('10.0');
    // Verify decimal positions are the same
    const dot0 = result[0].indexOf('.');
    const dot1 = result[1].indexOf('.');
    expect(dot0).toBe(dot1);
  });

  test('float column: different decimal digit counts', () => {
    const records = [
      makeRecord(['1.5']),
      makeRecord(['10.123']),
    ];
    const result = formatRecordGroup(records);
    // maxIntLen=2, maxDecLen=4 (".123"), effectiveWidth=6
    // "1.5"   → " 1.5  " (padEnd(6))
    // "10.123" → "10.123"
    const dot0 = result[0].indexOf('.');
    const dot1 = result[1].indexOf('.');
    expect(dot0).toBe(dot1);
  });

  test('multiple float columns each aligned independently', () => {
    const records = [
      makeRecord(['1.5', '100.0']),
      makeRecord(['10.0', '2.75']),
    ];
    const result = formatRecordGroup(records);
    // col0: maxIntLen=2, maxDecLen=2 → width=4; col1: maxIntLen=3, maxDecLen=3 → width=6
    // row0: " 1.5" + " " + "100.0 "
    // row1: "10.0" + " " + "  2.75" ... wait let me think
    // col1 tokens: "100.0" (int="100",dec=".0"), "2.75" (int="2",dec=".75")
    // maxIntLen=3, maxDecLen=3 (".75"→3? no ".75" has 3 chars), effectiveWidth=6
    // Wait: ".0" has 2 chars, ".75" has 3 chars → maxDecLen=3
    // "100.0" → intPart="100", decPart=".0", formatDecimalToken → "100.0 " padEnd(6)
    // "2.75"  → intPart="2", decPart=".75", padStart(3)→"  2", "  2"+".75"→"  2.75", padEnd(6)→"  2.75"
    const dot00 = result[0].indexOf('.');
    const dot10 = result[1].indexOf('.');
    expect(dot00).toBe(dot10); // col 0 dots aligned

    // col 1: extract after col0 width+1 space
    const col0Width = 4;
    const col1Start = col0Width + 1; // one space separator
    const dot01 = result[0].indexOf('.', col1Start);
    const dot11 = result[1].indexOf('.', col1Start);
    expect(dot01).toBe(dot11); // col 1 dots aligned
  });

  test('integer in a float column aligns at the decimal position', () => {
    const records = [
      makeRecord(['1.5']),
      makeRecord(['10']),
    ];
    const result = formatRecordGroup(records);
    // col: maxIntLen=2, maxDecLen=2, effectiveWidth=4
    // "1.5": " 1.5"
    // "10" (integer in float col): padStart(2)="10", padEnd(4)="10  "
    expect(result[0].indexOf('.')).toBe(2); // dot at index 2
    // "10  " — the integer ends at index 2 (same position as the dot)
    expect(result[1].substring(0, 2)).toBe('10');
  });

  test('default token 5* in float column is right-aligned', () => {
    const records = [
      makeRecord(['1.5']),
      makeRecord(['5*']),
    ];
    const result = formatRecordGroup(records);
    // "5*" contains '*' so treated as right-align (padStart)
    // effectiveWidth = max(3, 2+2) = 4 but "5*" width=2; padStart(4) = "  5*"
    // Wait: effectiveWidth = max(maxWidth, maxIntLen+maxDecLen)
    // maxWidth = max(3, 2) = 3; maxIntLen=1 ("1"), maxDecLen=2 (".5") → 1+2=3
    // effectiveWidth = max(3, 3) = 3
    // "1.5" → " 1.5" no wait: maxIntLen=1, maxDecLen=2 → effectiveWidth=3
    // "1.5": intPart="1"(len=1), padStart(1)="1", decPart=".5", "1.5", padEnd(3)="1.5"
    // "5*": padStart(3) = " 5*" (right-aligned to col width 3)
    expect(result[0]).toBe('1.5');
    expect(result[1]).toBe(' 5*');
  });

  test('negative float values align at decimal point', () => {
    const records = [
      makeRecord(['-1.5']),
      makeRecord(['10.0']),
    ];
    const result = formatRecordGroup(records);
    // col: tokens "-1.5" and "10.0"
    // "-1.5": dotIdx=2, intPart="-1"(len=2), decPart=".5"(len=2)
    // "10.0": dotIdx=2, intPart="10"(len=2), decPart=".0"(len=2)
    // maxIntLen=2, maxDecLen=2, effectiveWidth=4
    const dot0 = result[0].indexOf('.');
    const dot1 = result[1].indexOf('.');
    expect(dot0).toBe(dot1);
  });
});

// ---------------------------------------------------------------------------
// formatRecordGroup — non-numeric (string) columns left-aligned
// ---------------------------------------------------------------------------

describe('formatRecordGroup — string columns', () => {
  function makeRecord(tokens: string[]): RecordLine {
    return { indent: '', tokens, trailComment: '', hasTerminator: false };
  }

  test('string column is left-aligned', () => {
    const records = [
      makeRecord(["'WELL-A'", '1.0']),
      makeRecord(["'W'", '10.0']),
    ];
    const result = formatRecordGroup(records);
    // col0 is string (left-aligned), col1 is float (decimal-aligned)
    expect(result[0].startsWith("'WELL-A'")).toBe(true);
    expect(result[1].startsWith("'W'")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseHeadingPositions
// ---------------------------------------------------------------------------

describe('parseHeadingPositions', () => {
  test('standard heading comment', () => {
    const positions = parseHeadingPositions('-- Well Name Depth');
    expect(positions).not.toBeNull();
    expect(positions!.length).toBe(3);
  });

  test('two-word heading', () => {
    const positions = parseHeadingPositions('-- A B');
    expect(positions).not.toBeNull();
    expect(positions).toHaveLength(2);
  });

  test('single word returns null (need at least 2)', () => {
    expect(parseHeadingPositions('-- OnlyOne')).toBeNull();
  });

  test('non-comment line returns null', () => {
    expect(parseHeadingPositions('1.0 2.0 3.0')).toBeNull();
  });

  test('empty comment returns null', () => {
    expect(parseHeadingPositions('--')).toBeNull();
    expect(parseHeadingPositions('--   ')).toBeNull();
  });

  test('positions are absolute character indices', () => {
    const line = '--  ColA ColB';
    // '--  ' prefix = 4 chars, ColA at 4, ColB at 9
    const positions = parseHeadingPositions(line);
    expect(positions).not.toBeNull();
    expect(line[positions![0]]).toBe('C');
    expect(line[positions![1]]).toBe('C');
    expect(positions![0]).toBe(4);
    expect(positions![1]).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// formatRecordGroupWithHeading
// ---------------------------------------------------------------------------

describe('formatRecordGroupWithHeading', () => {
  function makeRecord(tokens: string[]): RecordLine {
    return { indent: '', tokens, trailComment: '', hasTerminator: false };
  }

  test('aligns columns to heading positions', () => {
    // heading: "--  A    B"
    // positions of A=4, B=9
    const headingPositions = [4, 9];
    const records = [
      makeRecord(['10', '20']),
      makeRecord(['1', '200']),
    ];
    const result = formatRecordGroupWithHeading(records, headingPositions);
    // col0 (int): effectiveWidth=2, colStart=4; right-align: "10" at pos 4, "1" at pos 5
    // col1 (int): effectiveWidth=3, colStart=9; right-align: "20" at pos 10, "200" at pos 9
    // row0: "    10   20"
    // row1: "     1  200"
    expect(result[0].indexOf('10')).toBe(4);
    expect(result[1].indexOf('200')).toBe(9);
  });

  test('float columns aligned at decimal point relative to heading', () => {
    const headingPositions = [3, 10];
    const records = [
      makeRecord(['1.5', '100.0']),
      makeRecord(['10.0', '2.75']),
    ];
    const result = formatRecordGroupWithHeading(records, headingPositions);
    // Both rows: col0 dot position should be the same
    const dot00 = result[0].indexOf('.');
    const dot10 = result[1].indexOf('.');
    expect(dot00).toBe(dot10);

    // col1 dot position should be the same
    const dot01 = result[0].indexOf('.', 10);
    const dot11 = result[1].indexOf('.', 10);
    expect(dot01).toBe(dot11);
  });

  test('heading positions force column spacing', () => {
    // heading positions [3, 20] — second column far right
    const headingPositions = [3, 20];
    const records = [makeRecord(['1', '2'])];
    const result = formatRecordGroupWithHeading(records, headingPositions);
    // "2" should end at position 21 (colStart=20, width=1, right-align → pos=20)
    expect(result[0].lastIndexOf('2')).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// buildHeadingAndAlignedRecords — with defaulted values
// ---------------------------------------------------------------------------

describe('buildHeadingAndAlignedRecords', () => {
  function makeRecord(tokens: string[], indent = ''): RecordLine {
    return { indent, tokens, trailComment: '', hasTerminator: false };
  }

  test('produces a heading with column names', () => {
    const records = [makeRecord(['1', '2']), makeRecord(['10', '20'])];
    const { heading } = buildHeadingAndAlignedRecords(records, ['A', 'B']);
    expect(heading).toMatch(/^--/);
    expect(heading).toContain('A');
    expect(heading).toContain('B');
  });

  test('column headers match record column count', () => {
    const records = [makeRecord(['1.0', '2.0', '3.0'])];
    const { heading } = buildHeadingAndAlignedRecords(records, ['X', 'Y', 'Z']);
    // Should have 3 column names in the heading
    const words = heading.replace(/^--\s*/, '').trim().split(/\s+/);
    expect(words).toEqual(['X', 'Y', 'Z']);
  });

  test('integer columns are right-aligned in formatted records', () => {
    const records = [
      makeRecord(['1', '200']),
      makeRecord(['100', '2']),
    ];
    const { formattedRecords } = buildHeadingAndAlignedRecords(records, ['A', 'B']);
    // col0: maxWidth=3; tokens: "1"→right-aligned, "100"→right-aligned
    // col1: maxWidth=3; tokens: "200"→right-aligned, "2"→right-aligned
    // Row 0: "  1 200" (same right edge for each col)
    // Row 1: "100   2"
    // Just verify that wider value ends at same position as narrower value in same column
    const posA0 = formattedRecords[0].indexOf('1') + 1;   // end of "1" in row 0
    const posA1 = formattedRecords[1].indexOf('100') + 3; // end of "100" in row 1
    expect(posA0).toBe(posA1);
  });

  test('float columns are decimal-aligned in formatted records', () => {
    const records = [
      makeRecord(['1.5', '3.0']),
      makeRecord(['10.0', '0.25']),
    ];
    const { formattedRecords } = buildHeadingAndAlignedRecords(records, ['Sw', 'Krw']);
    const dot0col0 = formattedRecords[0].indexOf('.');
    const dot1col0 = formattedRecords[1].indexOf('.');
    expect(dot0col0).toBe(dot1col0);
  });

  test('defaulted values N* are treated as a single token per record slot', () => {
    // A "5*" token counts as a single slot in the record (not 5 columns)
    const records = [
      makeRecord(['5*', '100.0']),
      makeRecord(['1.0', '200.0']),
    ];
    // N* in the first column makes it a float+default mix
    const { heading, formattedRecords } = buildHeadingAndAlignedRecords(
      records,
      ['DEFAULTS', 'VALUE']
    );
    expect(heading).toContain('DEFAULTS');
    expect(heading).toContain('VALUE');
    // "5*" should appear in row 0 (right-aligned or at expected position)
    expect(formattedRecords[0]).toContain('5*');
  });

  test('column header name wider than data widens the column', () => {
    const records = [makeRecord(['1', '2'])];
    const longName = 'VERY_LONG_COLUMN_NAME';
    const { heading, formattedRecords } = buildHeadingAndAlignedRecords(
      records,
      [longName, 'B']
    );
    expect(heading).toContain(longName);
    expect(heading).toContain('B');
    // Data token '1' is right-aligned to colWidths[0] = 21 chars from colStarts[0] = 0
    // so it ends at position 21 in the formatted record
    const onePos = formattedRecords[0].trimStart().startsWith('1')
      ? formattedRecords[0].indexOf('1')
      : formattedRecords[0].lastIndexOf('1', formattedRecords[0].indexOf('2') - 1);
    // The column for '1' ends at colStarts[0] + colWidths[0] = 0 + 21 = 21
    expect(onePos + 1).toBe(21);
  });

  test('indent is preserved in formatted records', () => {
    const records = [
      makeRecord(['1.0', '2.0'], '   '),
      makeRecord(['3.0', '4.0'], '   '),
    ];
    const { formattedRecords } = buildHeadingAndAlignedRecords(records, ['A', 'B']);
    expect(formattedRecords[0].startsWith('   ')).toBe(true);
    expect(formattedRecords[1].startsWith('   ')).toBe(true);
  });

  test('heading lines with floats: heading names follow the -- prefix', () => {
    // The heading always starts with '--', so the first name can't start at col 0.
    // It starts at max(colStarts[0], heading.length + 1) = max(0, 3) = 3.
    const records = [
      makeRecord(['1.0', '10.5']),
      makeRecord(['20.0', '0.5']),
    ];
    const { heading } = buildHeadingAndAlignedRecords(records, ['Sw', 'Krw']);
    expect(heading).toMatch(/^--\s+Sw\s+Krw$/);
    // Sw appears after the '--' prefix (minimum position 3)
    const swPos = heading.indexOf('Sw');
    expect(swPos).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// columnForCompletion
// ---------------------------------------------------------------------------

describe('columnForCompletion', () => {
  test('inside the first token returns 1', () => {
    const line = `'W1' 'G1' 1`;
    expect(columnForCompletion(line, 1)).toBe(1);
  });

  test('after the first token (between tokens) returns the next column', () => {
    const line = `'W1' 'G1' 1`;
    // Position right after 'W1' (index 4) should return column 2.
    expect(columnForCompletion(line, 4)).toBe(2);
  });

  test('past all tokens returns the next column', () => {
    const line = `'W1' 'G1' `;
    expect(columnForCompletion(line, line.length)).toBe(3);
  });

  test('counts N* repeats correctly', () => {
    const line = `1 3* `;
    // After "3*" (which is columns 2-4), next column is 5.
    expect(columnForCompletion(line, line.length)).toBe(5);
  });

  test('inside a partial token at the end returns its column', () => {
    const line = `'W1' 'G1' OPE`;
    // Cursor inside the OPE token (third token, column 3).
    expect(columnForCompletion(line, line.length)).toBe(3);
  });

  test('empty line returns column 1', () => {
    expect(columnForCompletion('', 0)).toBe(1);
  });
});
