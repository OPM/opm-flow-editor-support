import { classifyNameParam, collectDeckNames, compareNamesNatural } from './names';

describe('classifyNameParam', () => {
  it('classifies the common well-name items', () => {
    for (const name of ['WELL', 'WELNAME', 'WELLNAME', 'WELL_NAME', 'WELLS', 'WELNAMES']) {
      expect(classifyNameParam({ name, value_type: 'STRING' })).toBe('well');
    }
  });

  it('classifies the common group-name items', () => {
    for (const name of ['GROUP', 'GRPNAME', 'GROUP_NAME', 'GROUPS', 'GRPNAMES']) {
      expect(classifyNameParam({ name, value_type: 'STRING' })).toBe('group');
    }
  });

  it('treats a missing value_type as string-like (some items omit it)', () => {
    expect(classifyNameParam({ name: 'WELNAME' })).toBe('well');
    expect(classifyNameParam({ name: 'GRPNAME' })).toBe('group');
  });

  it('rejects non-name items that merely start with WEL / GRP', () => {
    for (const name of ['WELNETWK', 'WELOPEN', 'WELPI', 'GRPNETWK', 'GRPREIN']) {
      expect(classifyNameParam({ name, value_type: 'STRING' })).toBeNull();
    }
  });

  it('rejects numeric counts even when the name contains WEL / GRP', () => {
    expect(classifyNameParam({ name: 'MXWELS', value_type: 'INT' })).toBeNull();
    expect(classifyNameParam({ name: 'WELL_SEGMENT', value_type: 'INT' })).toBeNull();
    expect(classifyNameParam({ name: 'WELLBORE_VOL', value_type: 'DOUBLE' })).toBeNull();
  });

  it('rejects enum items (they have their own value vocabulary)', () => {
    expect(
      classifyNameParam({ name: 'GROUP', value_type: 'STRING', options: ['FIELD'] }),
    ).toBeNull();
  });

  it('returns null for unrelated items', () => {
    expect(classifyNameParam({ name: 'STATUS', value_type: 'STRING' })).toBeNull();
    expect(classifyNameParam({ name: '', value_type: 'STRING' })).toBeNull();
  });
});

// A permissive keyword recogniser for the scan: only the real OPM Flow
// keywords used in the fixtures need to be recognised.
const KNOWN = new Set([
  'WELSPECS', 'GRUPTREE', 'WCONPROD', 'COMPDAT', 'SCHEDULE', 'TSTEP', 'FIELD',
]);
const isKnown = (t: string) => KNOWN.has(t);

describe('compareNamesNatural', () => {
  it('orders names by numeric value, not lexicographically', () => {
    const sorted = ['PROD21', 'PROD2', 'PROD12'].sort(compareNamesNatural);
    expect(sorted).toEqual(['PROD2', 'PROD12', 'PROD21']);
  });

  it('groups by prefix then number', () => {
    const sorted = ['INJ1', 'PROD10', 'PROD2', 'INJ10', 'PROD1'].sort(compareNamesNatural);
    expect(sorted).toEqual(['INJ1', 'INJ10', 'PROD1', 'PROD2', 'PROD10']);
  });

  it('handles names with no digits and mixed segments', () => {
    const sorted = ['B-2H', 'B-10H', 'B-1H', 'A'].sort(compareNamesNatural);
    expect(sorted).toEqual(['A', 'B-1H', 'B-2H', 'B-10H']);
  });
});

describe('collectDeckNames', () => {
  it('returns names in natural numeric order', () => {
    const lines = [
      'WELSPECS',
      'PROD21  G  1 1 /',
      'PROD2   G  1 1 /',
      'PROD12  G  1 1 /',
      '/',
    ];
    expect(collectDeckNames(lines, isKnown).wells).toEqual(['PROD2', 'PROD12', 'PROD21']);
  });

  it('harvests bare well and group names from WELSPECS', () => {
    const lines = [
      'WELSPECS',
      'OP01     PLAT-1     3    7   1*   OIL  1* 1* SHUT /',
      'OP02     PLAT-1     3    3   1*   OIL  1* 1* SHUT /',
      'WI01     PLAT-2     1    1   1*   WAT  1* 1* SHUT /',
      '/',
    ];
    expect(collectDeckNames(lines, isKnown)).toEqual({
      wells: ['OP01', 'OP02', 'WI01'],
      groups: ['PLAT-1', 'PLAT-2'],
      quoted: new Set(),
    });
  });

  it('harvests quoted names and the GRUPTREE hierarchy', () => {
    const lines = [
      'WELSPECS',
      "  'B-1H'   'B1'   11  3  1*  OIL  /",
      '/',
      'GRUPTREE',
      "  'B1'      'PLAT'   /",
      "  'PLAT'    'FIELD'  /",
      '/',
    ];
    expect(collectDeckNames(lines, isKnown)).toEqual({
      wells: ['B-1H'],
      groups: ['B1', 'FIELD', 'PLAT'],
      quoted: new Set(['B-1H', 'B1', 'FIELD', 'PLAT']),
    });
  });

  it('records the declared quote style per name and treats mixed as quoted', () => {
    const lines = [
      'WELSPECS',
      "  'B-1H'   B1     11  3  1*  OIL  /", // well quoted, parent group bare
      '  OP01     PLAT   3   7  1*  OIL  /', // well bare
      '/',
      'GRUPTREE',
      "  'B1'      PLAT   /",                // B1 now quoted -> quoted wins
      '/',
    ];
    const { quoted } = collectDeckNames(lines, isKnown);
    expect(quoted.has('B-1H')).toBe(true);
    expect(quoted.has('B1')).toBe(true);   // bare in WELSPECS, quoted in GRUPTREE
    expect(quoted.has('OP01')).toBe(false);
    expect(quoted.has('PLAT')).toBe(false);
  });

  it('ignores default placeholders and comments', () => {
    const lines = [
      '-- wells',
      'WELSPECS',
      'OP01   PLAT-1   3 7 /',
      '1*     PLAT-1   1 1 /', // pathological: defaulted well name is skipped
      '/',
    ];
    const { wells, groups } = collectDeckNames(lines, isKnown);
    expect(wells).toEqual(['OP01']);
    expect(groups).toEqual(['PLAT-1']);
  });

  it('ends a block at the terminator, not at a following keyword body', () => {
    const lines = [
      'WELSPECS',
      'OP01   PLAT-1   3 7 /',
      '/',
      'WCONPROD',
      'NOTAWELL  OPEN  ORAT  1000 /', // must not be harvested as a well
      '/',
    ];
    expect(collectDeckNames(lines, isKnown).wells).toEqual(['OP01']);
  });

  it('treats an unquoted single-name record as data, not a new keyword', () => {
    const lines = [
      'WELSPECS',
      'OP01 /', // all later items defaulted; OP01 is a well, not a keyword
      'OP02 /',
      '/',
    ];
    expect(collectDeckNames(lines, isKnown).wells).toEqual(['OP01', 'OP02']);
  });

  it('de-duplicates names declared more than once', () => {
    const lines = [
      'WELSPECS',
      'OP01   PLAT-1   3 7 /',
      '/',
      'GRUPTREE',
      'PLAT-1   FIELD /',
      '/',
    ];
    expect(collectDeckNames(lines, isKnown).groups).toEqual(['FIELD', 'PLAT-1']);
  });

  it('returns empty sets for a deck with no WELSPECS / GRUPTREE', () => {
    expect(collectDeckNames(['RUNSPEC', 'DIMENS', '10 10 3 /'], isKnown)).toEqual({
      wells: [],
      groups: [],
      quoted: new Set(),
    });
  });
});
