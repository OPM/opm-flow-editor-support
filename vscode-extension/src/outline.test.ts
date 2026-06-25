import { buildOutline } from './outline';

const lines = (s: string): string[] => s.split('\n');

describe('buildOutline', () => {
  it('nests keywords under their section', () => {
    const roots = buildOutline(lines(
      'RUNSPEC\n' +
      'DIMENS\n' +
      '10 10 3 /\n' +
      'OIL\n' +
      'GRID\n' +
      'PERMX\n' +
      '300*100 /\n',
    ));
    expect(roots.map(r => r.name)).toEqual(['RUNSPEC', 'GRID']);
    expect(roots[0].kind).toBe('section');
    expect(roots[0].children.map(c => c.name)).toEqual(['DIMENS', 'OIL']);
    expect(roots[1].children.map(c => c.name)).toEqual(['PERMX']);
  });

  it('records the zero-based line of each node', () => {
    const roots = buildOutline(lines('RUNSPEC\nDIMENS\n10 10 3 /\n'));
    expect(roots[0].line).toBe(0);
    expect(roots[0].children[0].line).toBe(1);
  });

  it('skips comment lines and record/value lines', () => {
    const roots = buildOutline(lines(
      '-- a comment\n' +
      'RUNSPEC\n' +
      '-- another\n' +
      'DIMENS\n' +
      '10 10 3 /\n',
    ));
    expect(roots[0].children.map(c => c.name)).toEqual(['DIMENS']);
  });

  it('does not treat indented uppercase tokens as keywords', () => {
    const roots = buildOutline(lines(
      'RUNSPEC\n' +
      'EQLOPTS\n' +
      ' THPRES /\n',
    ));
    expect(roots[0].children.map(c => c.name)).toEqual(['EQLOPTS']);
  });

  it('attaches pre-section keywords to the root', () => {
    const roots = buildOutline(lines('INCLUDE\n  \'grid.inc\' /\nGRID\nPERMX\n'));
    expect(roots[0]).toMatchObject({ name: 'INCLUDE', kind: 'keyword' });
    expect(roots[1].name).toBe('GRID');
  });

  it('closes the active section on END', () => {
    const roots = buildOutline(lines('SCHEDULE\nTSTEP\n10 /\nEND\nFOO\n'));
    expect(roots[0].children.map(c => c.name)).toEqual(['TSTEP']);
    // FOO after END falls back to a root-level keyword node.
    expect(roots.map(r => r.name)).toEqual(['SCHEDULE', 'FOO']);
  });
});
