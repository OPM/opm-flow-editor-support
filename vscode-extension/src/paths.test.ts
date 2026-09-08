import * as path from 'path';
import {
  parsePathsAliases,
  resolvePathAlias,
  prtCandidatePaths,
  collectDeckIncludeFiles,
  resolveSymlinkSurrogate,
  SurrogateFs,
} from './paths';

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

// ---------------------------------------------------------------------------
// resolveSymlinkSurrogate
//
// The scenario throughout: a symlink made on Linux that did not survive the
// crossing to Windows, leaving an ordinary file holding the target path.
// Two shapes are covered — Minshall+French, as the Linux CIFS client writes
// onto a share mounted with mfsymlinks, and a bare flattened path.
// ---------------------------------------------------------------------------

describe('resolveSymlinkSurrogate', () => {
  // `files` maps an absolute path to its exact content; `dirs` lists paths
  // that exist as directories.
  const makeFs = (files: Record<string, string>, dirs: string[] = []): SurrogateFs => ({
    statFileSize: p => (p in files ? Buffer.byteLength(files[p]) : null),
    readText: p => (p in files ? files[p] : null),
    isDirectory: p => dirs.includes(p),
  });

  const link = path.resolve('/deck/include/PERM.grdecl');
  const target = path.resolve('/deck/shared/PERM.grdecl');

  it('follows a surrogate to the file it stands for', () => {
    const fsApi = makeFs({
      [link]: '../shared/PERM.grdecl',
      [target]: 'PERMX\n 1 2 3 /\n',
    });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(target);
  });

  it('resolves a POSIX target stored by Linux against the host path rules', () => {
    // The blob holds forward slashes whatever the checkout platform; the
    // resolved path must still come back in the host's own form.
    const nested = path.resolve('/deck/shared/grid/PERM.grdecl');
    const fsApi = makeFs({
      [link]: '../shared/grid/PERM.grdecl',
      [nested]: 'PERMX\n 1 /\n',
    });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(nested);
  });

  it('follows a chain of surrogates to the real file', () => {
    const mid = path.resolve('/deck/shared/PERM.grdecl');
    const end = path.resolve('/deck/vendor/PERM.grdecl');
    const fsApi = makeFs({
      [link]: '../shared/PERM.grdecl',
      [mid]: '../vendor/PERM.grdecl',
      [end]: 'PERMX\n 1 /\n',
    });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(end);
  });

  it('leaves an ordinary multi-line deck fragment alone', () => {
    const fsApi = makeFs({ [link]: 'PERMX\n 1 2 3 /\n' });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(link);
  });

  it('leaves a one-line fragment alone when it names nothing that exists', () => {
    // This is what keeps a short real fragment from being read as a link.
    const fsApi = makeFs({ [link]: 'PERMX' });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(link);
  });

  it('follows a bare path that carries a trailing newline', () => {
    // Whether a newline survives depends on what flattened the link, so one
    // is tolerated. Anything more than that is deck text.
    const fsApi = makeFs({
      [link]: '../shared/PERM.grdecl\n',
      [target]: 'PERMX\n 1 /\n',
    });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(target);
  });

  it('follows a bare path that carries a trailing CRLF', () => {
    const fsApi = makeFs({
      [link]: '../shared/PERM.grdecl\r\n',
      [target]: 'PERMX\n 1 /\n',
    });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(target);
  });

  it('leaves a one-line file alone when it has surrounding whitespace', () => {
    // A stored path is not indented; this is a deck record.
    const fsApi = makeFs({
      [link]: '  ../shared/PERM.grdecl',
      [target]: 'PERMX\n 1 /\n',
    });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(link);
  });

  // --- Minshall+French (mfsymlinks) ---------------------------------------

  /** A surrogate exactly as the Linux CIFS client writes one: 1067 bytes. */
  const mfSurrogate = (target: string): string => {
    const header = 'XSym\n' + String(target.length).padStart(4, '0') + '\n' + 'd'.repeat(32) + '\n';
    return (header + target).padEnd(1067, '\0');
  };

  it('follows a Minshall+French surrogate to the file it stands for', () => {
    const fsApi = makeFs({
      [link]: mfSurrogate('../shared/PERM.grdecl'),
      [target]: 'PERMX\n 1 2 3 /\n',
    });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(target);
  });

  it('follows a Minshall+French surrogate standing at a directory', () => {
    const dirLink = path.resolve('/deck/model/include');
    const realDir = path.resolve('/deck/shared');
    const realFile = path.resolve('/deck/shared/PERM.grdecl');
    const fsApi = makeFs(
      { [dirLink]: mfSurrogate('../shared'), [realFile]: 'PERMX\n 1 /\n' },
      [realDir],
    );
    expect(resolveSymlinkSurrogate(path.resolve('/deck/model/include/PERM.grdecl'), fsApi))
      .toBe(realFile);
  });

  it('ignores a Minshall+French header whose length field is corrupt', () => {
    const good = mfSurrogate('../shared/PERM.grdecl');
    const bad = 'XSym\n9999\n' + good.slice(10);
    const fsApi = makeFs({ [link]: bad, [target]: 'PERMX\n 1 /\n' });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(link);
  });

  it('ignores a deck fragment that merely starts with the magic word', () => {
    // 'XSym' without the newline and layout is not a surrogate.
    const fsApi = makeFs({ [link]: 'XSym is not a keyword', [target]: 'PERMX\n 1 /\n' });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(link);
  });

  it('leaves an empty file alone', () => {
    const fsApi = makeFs({ [link]: '' });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(link);
  });

  it('leaves a file too large to be a stored path alone', () => {
    // Guard against reading a whole grid file looking for a link.
    const fsApi = makeFs({ [link]: 'x'.repeat(5000) });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(link);
  });

  it('leaves a missing path alone', () => {
    expect(resolveSymlinkSurrogate(link, makeFs({}))).toBe(link);
  });

  it('leaves an absolute POSIX target alone when it does not exist on the host', () => {
    // '/data/decks/PERM.grdecl' from a Linux machine anchors to the current
    // drive on Windows and will not be there.
    const fsApi = makeFs({ [link]: '/data/decks/PERM.grdecl' });
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(link);
  });

  it('resolves an INCLUDE path through a symlinked directory', () => {
    // The common layout: a whole include/ directory is the symlink, so the
    // full INCLUDE path names nothing on disk until the directory is followed.
    const dirLink = path.resolve('/deck/model/include');
    const realDir = path.resolve('/deck/shared');
    const realFile = path.resolve('/deck/shared/PERM.grdecl');
    const fsApi = makeFs(
      { [dirLink]: '../shared', [realFile]: 'PERMX\n 1 /\n' },
      [realDir],
    );
    expect(resolveSymlinkSurrogate(path.resolve('/deck/model/include/PERM.grdecl'), fsApi))
      .toBe(realFile);
  });

  it('resolves a nested INCLUDE path through a symlinked directory', () => {
    const dirLink = path.resolve('/deck/model/include');
    const realDir = path.resolve('/deck/shared');
    const gridDir = path.resolve('/deck/shared/grid');
    const realFile = path.resolve('/deck/shared/grid/PERM.grdecl');
    const fsApi = makeFs(
      { [dirLink]: '../shared', [realFile]: 'PERMX\n 1 /\n' },
      [realDir, gridDir],
    );
    expect(resolveSymlinkSurrogate(path.resolve('/deck/model/include/grid/PERM.grdecl'), fsApi))
      .toBe(realFile);
  });

  it('leaves a fragment holding only a record terminator alone', () => {
    // '/' names the drive root: it exists, but a file was wanted, so this is
    // deck text rather than a link.
    const frag = path.resolve('/deck/include/TERM.INC');
    const fsApi = makeFs({ [frag]: '/' }, [path.parse(frag).root]);
    expect(resolveSymlinkSurrogate(frag, fsApi)).toBe(frag);
  });
  it('breaks a surrogate cycle instead of looping', () => {
    const other = path.resolve('/deck/shared/PERM.grdecl');
    const fsApi = makeFs({
      [link]: '../shared/PERM.grdecl',
      [other]: '../include/PERM.grdecl',
    });
    // Stops at the first repeat rather than hanging.
    expect(resolveSymlinkSurrogate(link, fsApi)).toBe(other);
  });

  it('stops after the hop limit on a long surrogate chain', () => {
    const chain = (i: number) => path.resolve(`/deck/l${i}/PERM.grdecl`);
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[chain(i)] = `../l${i + 1}/PERM.grdecl`;
    files[chain(12)] = 'PERMX\n 1 /\n';
    expect(resolveSymlinkSurrogate(chain(0), makeFs(files))).toBe(chain(8));
  });
});

// ---------------------------------------------------------------------------
// collectDeckIncludeFiles + resolveSymlinkSurrogate
// ---------------------------------------------------------------------------

describe('collectDeckIncludeFiles through symlink surrogates', () => {
  it('walks an INCLUDE through a surrogate to the file it stands for', () => {
    const root = path.resolve('/deck/CASE.DATA');
    const surrogate = path.resolve('/deck/include/GRID.INC');
    const real = path.resolve('/deck/shared/GRID.INC');

    const contents: Record<string, string> = {
      [surrogate]: '../shared/GRID.INC',
      [real]: 'PORO\n 1 2 3 /\n',
    };
    const fsApi: SurrogateFs = {
      statFileSize: p => (p in contents ? Buffer.byteLength(contents[p]) : null),
      readText: p => (p in contents ? contents[p] : null),
      isDirectory: () => false,
    };

    const lines: Record<string, string[]> = {
      [root]: ['GRID', 'INCLUDE', " 'include/GRID.INC' /"],
      [real]: ['PORO', ' 1 2 3 /'],
    };
    const reader = (fsPath: string): string[] | null => lines[fsPath] ?? null;

    // The surrogate itself never enters the deck; its target does.
    expect(collectDeckIncludeFiles(root, reader, new Set(), p => resolveSymlinkSurrogate(p, fsApi)))
      .toEqual([root, real]);
  });

  it('leaves INCLUDE paths untouched by default', () => {
    const root = path.resolve('/deck/CASE.DATA');
    const inc = path.resolve('/deck/include/GRID.INC');
    const reader = (fsPath: string): string[] | null =>
      fsPath === root ? ['GRID', 'INCLUDE', " 'include/GRID.INC' /"] : null;
    expect(collectDeckIncludeFiles(root, reader)).toEqual([root, inc]);
  });
});
