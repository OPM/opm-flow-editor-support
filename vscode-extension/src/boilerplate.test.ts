import { buildKeywordSnippet, SnippetKeyword } from './boilerplate';

describe('buildKeywordSnippet', () => {
  it('emits keyword + a terminated record with defaults for a fixed keyword', () => {
    const entry: SnippetKeyword = {
      name: 'EQLDIMS',
      size_kind: 'fixed',
      parameters: [
        { index: 1, value_type: 'INT', default: '1' },
        { index: 2, value_type: 'INT', default: '100' },
      ],
    };
    expect(buildKeywordSnippet(entry)).toBe('EQLDIMS\n    ${1:1} ${2:100} /\n$0');
  });

  it('falls back to typed dummies when a parameter has no default', () => {
    const entry: SnippetKeyword = {
      name: 'FOO',
      size_kind: 'fixed',
      parameters: [
        { index: 1, value_type: 'INT', default: 'None' },
        { index: 2, value_type: 'DOUBLE' },
        { index: 3, value_type: 'STRING', default: 'None' },
      ],
    };
    expect(buildKeywordSnippet(entry)).toBe("FOO\n    ${1:1} ${2:0.0} ${3:'STRING'} /\n$0");
  });

  it('honours the unquoted string style for STRING dummies', () => {
    const entry: SnippetKeyword = {
      name: 'FOO',
      size_kind: 'fixed',
      parameters: [{ index: 1, value_type: 'STRING' }],
    };
    expect(buildKeywordSnippet(entry, 'unquoted')).toBe('FOO\n    ${1:STRING} /\n$0');
  });

  it('adds a standalone terminator line for a list keyword', () => {
    const entry: SnippetKeyword = {
      name: 'WELSPECS',
      size_kind: 'list',
      parameters: [{ index: 1, value_type: 'STRING', default: 'None' }],
    };
    expect(buildKeywordSnippet(entry)).toBe("WELSPECS\n    ${1:'STRING'} /\n/\n$0");
  });

  it('emits a single value line for an array keyword', () => {
    const entry: SnippetKeyword = {
      name: 'PERMX',
      size_kind: 'array',
      parameters: [{ index: 1 }],
    };
    expect(buildKeywordSnippet(entry)).toBe('PERMX\n    ${1:1*} /\n$0');
  });

  it('emits the bare keyword for an activation (none) keyword', () => {
    const entry: SnippetKeyword = { name: 'UNIFOUT', size_kind: 'none', parameters: [] };
    expect(buildKeywordSnippet(entry)).toBe('UNIFOUT\n$0');
  });

  it('emits the bare keyword when no parameter data is available', () => {
    const entry: SnippetKeyword = { name: 'BARE', size_kind: 'fixed' };
    expect(buildKeywordSnippet(entry)).toBe('BARE\n$0');
  });

  it('only emits the first record for a multi-record keyword', () => {
    const entry: SnippetKeyword = {
      name: 'MULTI',
      size_kind: 'list',
      parameters: [
        { index: 1, value_type: 'INT', default: '1', record: 1 },
        { index: 2, value_type: 'INT', default: '2', record: 2 },
      ],
    };
    expect(buildKeywordSnippet(entry)).toBe('MULTI\n    ${1:1} /\n/\n$0');
  });
});
