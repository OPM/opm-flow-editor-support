import * as path from 'path';
import { parsePathsAliases, resolvePathAlias, prtCandidatePaths, collectDeckIncludeFiles } from './paths';

// ---------------------------------------------------------------------------
// parsePathsAliases
// ---------------------------------------------------------------------------

describe('parsePathsAliases', () => {
  it('extracts a single alias from a PATHS block', () => {
    const lines = [
      'RUNSPEC',
      'PATHS',
      " 'INCLUDEPATH' '../include' /",
      '/',
    ];
    const aliases = parsePathsAliases(lines);
    expect(aliases.get('INCLUDEPATH')).toBe('../include');
    expect(aliases.size).toBe(1);
  });

  it('extracts multiple aliases from one PATHS block', () => {
    const lines = [
      'PATHS',
      " 'GRID' '/disk1/norne/2017/GRID-INCLUDES' /",
      " 'SCHD' '/disk1/norne/2017/SCHD-INCLUDES' /",
      '/',
    ];
    const aliases = parsePathsAliases(lines);
    expect(aliases.get('GRID')).toBe('/disk1/norne/2017/GRID-INCLUDES');
    expect(aliases.get('SCHD')).toBe('/disk1/norne/2017/SCHD-INCLUDES');
  });

  it('ignores comment and blank lines inside the PATHS block', () => {
    const lines = [
      'PATHS',
      '-- this is a comment',
      '',
      " 'A' 'dirA' /",
      '/',
    ];
    expect(parsePathsAliases(lines).get('A')).toBe('dirA');
  });

  it('lets a later definition override an earlier one', () => {
    const lines = [
      'PATHS',
      " 'A' 'first' /",
      '/',
      'PATHS',
      " 'A' 'second' /",
      '/',
    ];
    expect(parsePathsAliases(lines).get('A')).toBe('second');
  });

  it('does not pick up records once the PATHS block is closed', () => {
    const lines = [
      'PATHS',
      " 'A' 'dirA' /",
      '/',
      // Stray record-shaped line in another keyword's body — must be ignored.
      " 'B' 'dirB' /",
    ];
    const aliases = parsePathsAliases(lines);
    expect(aliases.has('A')).toBe(true);
    expect(aliases.has('B')).toBe(false);
  });

  it('returns an empty map when no PATHS block is present', () => {
    const lines = ['RUNSPEC', 'INCLUDE', "'foo.inc' /"];
    expect(parsePathsAliases(lines).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolvePathAlias
// ---------------------------------------------------------------------------

describe('resolvePathAlias', () => {
  it('substitutes a $ALIAS prefix', () => {
    const aliases = new Map([['INCLUDEPATH', '../include']]);
    expect(resolvePathAlias('$INCLUDEPATH/grid/PERM.grdecl', aliases))
      .toBe('../include/grid/PERM.grdecl');
  });

  it('supports the braced $(ALIAS) form', () => {
    const aliases = new Map([['G', '/data/grid']]);
    expect(resolvePathAlias('$(G)/PORO.INC', aliases)).toBe('/data/grid/PORO.INC');
  });

  it('returns the path unchanged when no $-prefix is present', () => {
    const aliases = new Map([['G', '/data/grid']]);
    expect(resolvePathAlias('grid/PORO.INC', aliases)).toBe('grid/PORO.INC');
  });

  it('returns the path unchanged when the alias is undefined', () => {
    // Leaving the unresolved $ALIAS in place causes the link to fail to
    // open, which is the right signal that the alias is missing.
    const aliases = new Map<string, string>();
    expect(resolvePathAlias('$MISSING/foo.inc', aliases)).toBe('$MISSING/foo.inc');
  });

  it('only substitutes the prefix — embedded $ later in the path is left alone', () => {
    const aliases = new Map([['A', 'expA']]);
    expect(resolvePathAlias('foo/$A/bar', aliases)).toBe('foo/$A/bar');
  });
});

// ---------------------------------------------------------------------------
// prtCandidatePaths
// ---------------------------------------------------------------------------

describe('prtCandidatePaths', () => {
  it('offers the uppercase .PRT first, then the lowercase fallback', () => {
    const deck = path.join('proj', 'CASE.DATA');
    expect(prtCandidatePaths(deck)).toEqual([
      path.join('proj', 'CASE.PRT'),
      path.join('proj', 'CASE.prt'),
    ]);
  });

  it('preserves the basename casing and the directory', () => {
    const deck = path.join('a', 'b', 'NoRnE_2020.DATA');
    expect(prtCandidatePaths(deck)).toEqual([
      path.join('a', 'b', 'NoRnE_2020.PRT'),
      path.join('a', 'b', 'NoRnE_2020.prt'),
    ]);
  });

  it('works for a lowercase .data deck extension', () => {
    expect(prtCandidatePaths('case.data')).toEqual(['case.PRT', 'case.prt']);
  });

  it('handles a deck path with no extension', () => {
    expect(prtCandidatePaths('CASE')).toEqual(['CASE.PRT', 'CASE.prt']);
  });

  it('returns an empty array for an empty input', () => {
    expect(prtCandidatePaths('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Issue #14 — the exact scenario from the bug report
// ---------------------------------------------------------------------------

describe('issue #14 — INCLUDE path with PATHS alias', () => {
  it('resolves $INCLUDEPATH so INCLUDE links no longer break', () => {
    const deck = [
      'RUNSPEC',
      'PATHS',
      " 'INCLUDEPATH' '../include' /",
      '/',
      'GRID',
      'INCLUDE',
      " '$INCLUDEPATH/grid/PERM.grdecl' /",
    ];
    const aliases = parsePathsAliases(deck);
    // Bug: previously this returned '$INCLUDEPATH/grid/PERM.grdecl'
    // unchanged, which path.resolve then anchored under the deck dir
    // (e.g. eclipse/model/$INCLUDEPATH/grid/PERM.grdecl).
    expect(resolvePathAlias('$INCLUDEPATH/grid/PERM.grdecl', aliases))
      .toBe('../include/grid/PERM.grdecl');
  });
});

// ---------------------------------------------------------------------------
// collectDeckIncludeFiles
// ---------------------------------------------------------------------------

describe('collectDeckIncludeFiles', () => {
  // Build a mock readLines callback from a map of path -> lines
  const makeReader = (files: Record<string, string[]>) =>
    (fsPath: string): string[] | null => files[fsPath] ?? null;

  const root = path.resolve('/deck/CASE.DATA');
  const inc1 = path.resolve('/deck/include/GRID.INC');
  const inc2 = path.resolve('/deck/include/PROPS.INC');

  it('returns only the root file when it has no INCLUDE statements', () => {
    const reader = makeReader({ [root]: ['RUNSPEC', 'GRID'] });
    expect(collectDeckIncludeFiles(root, reader)).toEqual([root]);
  });

  it('returns root followed by one included file', () => {
    const reader = makeReader({
      [root]: ['GRID', 'INCLUDE', " 'include/GRID.INC' /"],
      [inc1]: ['PORO', ' 1 2 3 /'],
    });
    expect(collectDeckIncludeFiles(root, reader)).toEqual([root, inc1]);
  });

  it('returns root followed by multiple included files in order', () => {
    const reader = makeReader({
      [root]: [
        'GRID',
        'INCLUDE',
        " 'include/GRID.INC' /",
        'PROPS',
        'INCLUDE',
        " 'include/PROPS.INC' /",
      ],
      [inc1]: ['PORO', ' 1 2 3 /'],
      [inc2]: ['PVTW', ' 1 2 3 4 5 /'],
    });
    expect(collectDeckIncludeFiles(root, reader)).toEqual([root, inc1, inc2]);
  });

  it('follows nested INCLUDE chains', () => {
    const inc3 = path.resolve('/deck/include/nested/PERM.INC');
    const reader = makeReader({
      [root]: ['GRID', 'INCLUDE', " 'include/GRID.INC' /"],
      [inc1]: ['INCLUDE', " 'nested/PERM.INC' /"],
      [inc3]: ['PERMX', ' 1 2 3 /'],
    });
    expect(collectDeckIncludeFiles(root, reader)).toEqual([root, inc1, inc3]);
  });

  it('does not visit the same file twice (cycle protection)', () => {
    // inc1 includes root, which would create an infinite loop without cycle protection
    const reader = makeReader({
      [root]: ['GRID', 'INCLUDE', " 'include/GRID.INC' /"],
      [inc1]: ['INCLUDE', " '../CASE.DATA' /"],
    });
    expect(collectDeckIncludeFiles(root, reader)).toEqual([root, inc1]);
  });

  it('does not follow IMPORT or RESTART references', () => {
    const reader = makeReader({
      [root]: [
        'GRID',
        'IMPORT',
        " 'include/GRID.INC' /",
        'RESTART',
        " 'include/PROPS.INC' 1 /",
      ],
      [inc1]: ['PORO', ' 1 2 3 /'],
      [inc2]: ['PVTW', ' 1 2 3 4 5 /'],
    });
    // IMPORT and RESTART are not included
    expect(collectDeckIncludeFiles(root, reader)).toEqual([root]);
  });

  it('gracefully skips files that cannot be read', () => {
    const reader = makeReader({
      [root]: ['GRID', 'INCLUDE', " 'include/MISSING.INC' /"],
      // MISSING.INC not in the map → readLines returns null
    });
    const missing = path.resolve('/deck/include/MISSING.INC');
    // The missing file is included in the list but has no children
    expect(collectDeckIncludeFiles(root, reader)).toEqual([root, missing]);
  });

  it('resolves PATHS aliases in INCLUDE paths', () => {
    const inc4 = path.resolve('/deck/data/GRID.INC');
    const reader = makeReader({
      [root]: [
        'PATHS',
        " 'DATA' 'data' /",
        '/',
        'INCLUDE',
        " '$DATA/GRID.INC' /",
      ],
      [inc4]: ['PORO', ' 1 /'],
    });
    expect(collectDeckIncludeFiles(root, reader)).toEqual([root, inc4]);
  });
});
