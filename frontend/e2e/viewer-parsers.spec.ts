import { expect, test } from '@playwright/test';
import { parseDelimited, sortRows } from '../src/components/ui/viewer/csv';
import { asOpsResult, parseJson } from '../src/components/ui/viewer/json';
import { blockFile, viewKind } from '../src/components/ui/viewer/kinds';
import { type Block, parseMarkdown, safeHref } from '../src/components/ui/viewer/markdown';

test.describe('CSV and TSV', () => {
  test('quotes keep a comma, a line break and a doubled quote inside one cell', () => {
    const text = 'name,note\r\n"Smith, Ann","said ""hi""\nthen left"\nBo,plain\n';
    expect(parseDelimited(text, ',')).toEqual([
      ['name', 'note'],
      ['Smith, Ann', 'said "hi"\nthen left'],
      ['Bo', 'plain'],
    ]);
  });

  test('a tab file splits on tabs and leaves commas alone', () => {
    expect(parseDelimited('a\tb,c\n1\t2', '\t')).toEqual([
      ['a', 'b,c'],
      ['1', '2'],
    ]);
  });

  test('a short row is padded to the header and an empty file has no rows', () => {
    expect(parseDelimited('a,b,c\n1', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ]);
    expect(parseDelimited('', ',')).toEqual([]);
  });

  test('sorting compares numbers as numbers, text as text, and none keeps the file order', () => {
    const rows = [['10'], ['9'], ['100']];
    expect(sortRows(rows, 0, 'asc').map((row) => row[0])).toEqual(['9', '10', '100']);
    expect(sortRows(rows, 0, 'desc').map((row) => row[0])).toEqual(['100', '10', '9']);
    expect(sortRows([['b'], ['a'], ['c']], 0, 'asc').map((row) => row[0])).toEqual(['a', 'b', 'c']);
    expect(sortRows(rows, 0, null)).toEqual(rows);
  });
});

test.describe('JSON', () => {
  test('a good file gives its value, and JSON Lines gives one value per line', () => {
    expect(parseJson('{"a":[1,null]}', false)).toEqual({ ok: true, value: { a: [1, null] } });
    expect(parseJson('{"a":1}\n\n{"a":2}\n', true)).toEqual({ ok: true, value: [{ a: 1 }, { a: 2 }] });
  });

  test('a parse error names its line', () => {
    const bad = parseJson('{\n  "a": 1,\n  "b": }\n', false);
    expect(bad).toMatchObject({ ok: false, line: 3 });
  });

  test('a JSON Lines error names the line that failed, counting blank lines', () => {
    const bad = parseJson('{"a":1}\n\n{"a":\n', true);
    expect(bad).toMatchObject({ ok: false, line: 3 });
  });

  test('one ops-result object reads as a result and anything else does not', () => {
    const result = {
      connection: 'orders-db',
      query: 'select 1',
      columns: ['n'],
      rows: [[1], [{ x: 1 }]],
      total: 2,
      ms: 4,
    };
    expect(asOpsResult(result)).toEqual({
      kind: 'result',
      connection: 'orders-db',
      query: 'select 1',
      columns: ['n'],
      rows: [[1], ['{"x":1}']],
      total: 2,
      ms: 4,
    });
    expect(asOpsResult({ connection: 'orders-db' })).toBeNull();
    expect(asOpsResult([result])).toBeNull();
  });
});

test.describe('file kinds', () => {
  test('the name decides the type the daemon serves as bytes', () => {
    const kinds = Object.fromEntries(
      [
        'a.md',
        'a.markdown',
        'a.json',
        'a.jsonl',
        'a.csv',
        'a.tsv',
        'a.mmd',
        'a.mermaid',
        'a.dot',
        'a.gv',
        'a.html',
        'a.svg',
        'a.pdf',
        'a.zip',
        'a.log',
      ].map((name) => [name, viewKind('application/octet-stream', name)]),
    );
    expect(kinds).toEqual({
      'a.md': 'markdown',
      'a.markdown': 'markdown',
      'a.json': 'json',
      'a.jsonl': 'jsonl',
      'a.csv': 'csv',
      'a.tsv': 'tsv',
      'a.mmd': 'mermaid',
      'a.mermaid': 'mermaid',
      'a.dot': 'dot',
      'a.gv': 'dot',
      'a.html': 'html',
      'a.svg': 'svg',
      'a.pdf': 'other',
      'a.zip': 'other',
      'a.log': 'text',
    });
    expect(viewKind('application/pdf', 'a.bin')).toBe('pdf');
    expect(viewKind('image/png', 'a.png')).toBe('image');
  });

  test('a code block of a drawable language gets a file name, any other does not', () => {
    expect(blockFile('json')).toBe('block.json');
    expect(blockFile('JSONL')).toBe('block.jsonl');
    expect(blockFile('markdown')).toBe('block.md');
    expect(blockFile('mermaid')).toBe('block.mmd');
    expect(blockFile('ops-result')).toBe('block.json');
    expect(blockFile('dot')).toBe('block.dot');
    expect(blockFile('ts')).toBeNull();
    expect(blockFile('')).toBeNull();
  });
});

test.describe('Markdown', () => {
  test('only http, https and mailto links are links', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('mailto:ops@example.com')).toBe('mailto:ops@example.com');
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      '/relative',
      '//example.com',
    ])
      expect(safeHref(bad)).toBeNull();
  });
});

test.describe('Markdown limits', () => {
  const SIZE = 2 * 1024 * 1024;
  const backtickRuns = (() => {
    let text = '';
    for (let size = 1; text.length < SIZE; size++) text += `${'`'.repeat(size)}a`;
    return text;
  })();
  // What a 2 MB file the Viewer accepts could hold to stall the page: each is a loop with no end to find.
  const hostile: Record<string, string> = {
    'a line of quote marks': '>'.repeat(SIZE),
    'a line of list markers': `${'- '.repeat(SIZE / 2)}x`,
    'emphasis that never closes': '*a '.repeat(SIZE / 3),
    'bold that never closes': '**a '.repeat(SIZE / 4),
    'underscores that never close': '_a '.repeat(SIZE / 3),
    'strike that never closes': '~~a '.repeat(SIZE / 4),
    'backtick runs of every length': backtickRuns,
    'one run of backticks': '`'.repeat(SIZE),
    'brackets with no link': `${'[a '.repeat(SIZE / 3)}]`,
    'images with no link': `${'![a '.repeat(SIZE / 4)}]`,
    'addresses that are not links': 'http://['.repeat(SIZE / 8),
    'an address ending in a long run of punctuation': `http://a${'.'.repeat(SIZE)}x`,
    'a heading with a long run of spaces': `# a${' '.repeat(SIZE)}b`,
    'a table rule line of spaces': `a|b\n${' '.repeat(SIZE)}x`,
    'half a million list items': '- a\n'.repeat(SIZE / 4),
  };
  for (const [name, source] of Object.entries(hostile))
    test(`${name} parses in under a second`, () => {
      const started = performance.now();
      parseMarkdown(source);
      expect(performance.now() - started).toBeLessThan(1000);
    });

  test('quotes nested deeper than 8 levels keep the rest as text', () => {
    const levels = (blocks: Block[]): number =>
      blocks.reduce((deepest, block) => Math.max(deepest, block.t === 'quote' ? 1 + levels(block.children) : 0), 0);
    expect(levels(parseMarkdown(`${'>'.repeat(30)} deep`))).toBe(8);
    expect(levels(parseMarkdown('> > two'))).toBe(2);
  });
});
