import { parsePathsAliases, resolvePathAlias } from './paths';

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
