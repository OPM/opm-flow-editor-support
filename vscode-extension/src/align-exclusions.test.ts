import { DEFAULT_ALIGN_COLUMNS_EXCLUDED_KEYWORDS } from './align-exclusions';

describe('DEFAULT_ALIGN_COLUMNS_EXCLUDED_KEYWORDS', () => {
  const set = new Set(DEFAULT_ALIGN_COLUMNS_EXCLUDED_KEYWORDS);

  it('excludes the common per-cell grid/region/solution array keywords', () => {
    for (const kw of ['COORD', 'ZCORN', 'PORO', 'PERMX', 'PERMZ', 'NTG',
                      'SATNUM', 'FIPNUM', 'EQLNUM', 'ACTNUM', 'PRESSURE',
                      'VFPPROD', 'VFPINJ']) {
      expect(set.has(kw)).toBe(true);
    }
  });

  it('does NOT exclude genuine record-table keywords', () => {
    // These are real record tables users do want aligned.
    for (const kw of ['WELSPECS', 'COMPDAT', 'WCONPROD', 'GCONPROD',
                      'SWOF', 'SGOF', 'PVTO', 'PVTW', 'WELSEGS']) {
      expect(set.has(kw)).toBe(false);
    }
  });

  it('lists every keyword in upper case', () => {
    for (const kw of DEFAULT_ALIGN_COLUMNS_EXCLUDED_KEYWORDS) {
      expect(kw).toBe(kw.toUpperCase());
    }
  });

  it('contains no duplicates', () => {
    expect(set.size).toBe(DEFAULT_ALIGN_COLUMNS_EXCLUDED_KEYWORDS.length);
  });
});
