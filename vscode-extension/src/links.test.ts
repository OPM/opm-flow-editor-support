import { findFileReferences } from './links';

describe('findFileReferences — INCLUDE (existing behaviour)', () => {
  it('finds an INCLUDE path on the next line', () => {
    const refs = findFileReferences([
      'GRID',
      'INCLUDE',
      " 'grid/PERM.grdecl' /",
    ]);
    expect(refs).toEqual([
      { keyword: 'INCLUDE', line: 2, startChar: 2, endChar: 18, rawPath: 'grid/PERM.grdecl' },
    ]);
  });

  it('skips blank and comment lines between INCLUDE and the path', () => {
    const refs = findFileReferences([
      'INCLUDE',
      '',
      '-- a note',
      " 'foo.inc' /",
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].line).toBe(3);
    expect(refs[0].rawPath).toBe('foo.inc');
  });
});

// ---------------------------------------------------------------------------
// Issue #17 — extend clickable links to IMPORT, RESTART, GDFILE
// ---------------------------------------------------------------------------

describe('findFileReferences — IMPORT / RESTART / GDFILE (issue #17)', () => {
  it('finds an IMPORT file reference', () => {
    const refs = findFileReferences([
      'GRID',
      'IMPORT',
      " 'imports/CASE.FEGRID' 'FORMATTED' /",
    ]);
    expect(refs).toEqual([
      {
        keyword: 'IMPORT',
        line: 2,
        startChar: 2,
        endChar: 21,
        rawPath: 'imports/CASE.FEGRID',
      },
    ]);
  });

  it('finds a RESTART root name reference', () => {
    // RESTART's first value is a root name (no extension); we still treat
    // it as a file reference so users can jump to that location.
    const refs = findFileReferences([
      'SOLUTION',
      'RESTART',
      " 'PRIOR/MYCASE' 5 /",
    ]);
    expect(refs).toEqual([
      {
        keyword: 'RESTART',
        line: 2,
        startChar: 2,
        endChar: 14,
        rawPath: 'PRIOR/MYCASE',
      },
    ]);
  });

  it('finds a GDFILE grid file reference', () => {
    const refs = findFileReferences([
      'GRID',
      'GDFILE',
      " 'grids/CASE.EGRID' /",
    ]);
    expect(refs).toEqual([
      {
        keyword: 'GDFILE',
        line: 2,
        startChar: 2,
        endChar: 18,
        rawPath: 'grids/CASE.EGRID',
      },
    ]);
  });

  it('finds references for all four keywords in one deck', () => {
    const refs = findFileReferences([
      'GRID',
      'INCLUDE',
      " 'a.inc' /",
      'IMPORT',
      " 'b.FEGRID' 'FORMATTED' /",
      'GDFILE',
      " 'c.EGRID' /",
      'SOLUTION',
      'RESTART',
      " 'd' 1 /",
    ]);
    expect(refs.map(r => [r.keyword, r.rawPath])).toEqual([
      ['INCLUDE', 'a.inc'],
      ['IMPORT', 'b.FEGRID'],
      ['GDFILE', 'c.EGRID'],
      ['RESTART', 'd'],
    ]);
  });
});

describe('findFileReferences — non-matches', () => {
  it('returns an empty array when no link-bearing keyword is present', () => {
    expect(findFileReferences(['RUNSPEC', 'DIMENS', '10 10 10 /'])).toEqual([]);
  });

  it('does not match a keyword that is a prefix of another (e.g. INCLUDED)', () => {
    // The keyword regex anchors on a whitespace/comment/'/'/EOL after the
    // name, so an identifier that merely starts with INCLUDE must not fire.
    expect(findFileReferences(['INCLUDED', " 'foo.inc' /"])).toEqual([]);
  });

  it('does not produce a reference when no quoted path follows', () => {
    // Bare INCLUDE with the next line not starting with a quote.
    expect(findFileReferences(['INCLUDE', 'GRID'])).toEqual([]);
  });
});
