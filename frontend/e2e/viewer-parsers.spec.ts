import { expect, test } from '@playwright/test';
import { parseDelimited, sortRows } from '../src/components/ui/viewer/csv';
import { asOpsResult, parseJson } from '../src/components/ui/viewer/json';
import { blockFile, viewKind } from '../src/components/ui/viewer/kinds';
import { parseMarkdown, safeHref } from '../src/components/ui/viewer/markdown';

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
  test('blocks: headings, lists with tasks, a table, a quote, a fence with its language and a rule', () => {
    const blocks = parseMarkdown(
      [
        '# Title',
        '',
        'Some *em* and **bold** and ~~gone~~ and `code`.',
        '',
        '- [x] done',
        '- [ ] todo',
        '  - nested',
        '',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '> quoted',
        '',
        '```ts',
        'const a = 1;',
        '```',
        '',
        '---',
      ].join('\n'),
    );
    expect(blocks.map((block) => block.t)).toEqual(['heading', 'paragraph', 'list', 'table', 'quote', 'code', 'rule']);
    const list = blocks[2];
    if (list?.t !== 'list') throw new Error('not a list');
    expect(list.items.map((item) => item.checked)).toEqual([true, false]);
    expect(list.items[1]?.children.map((child) => child.t)).toEqual(['paragraph', 'list']);
    const table = blocks[3];
    if (table?.t !== 'table') throw new Error('not a table');
    expect(table.rows).toHaveLength(1);
    const code = blocks[5];
    expect(code).toMatchObject({ t: 'code', lang: 'ts', text: 'const a = 1;' });
  });

  test('raw HTML stays text and a script tag is never a node of its own', () => {
    const [paragraph] = parseMarkdown('Hi <script>alert(1)</script> <b>x</b>');
    expect(paragraph).toEqual({
      t: 'paragraph',
      children: [{ t: 'text', text: 'Hi <script>alert(1)</script> <b>x</b>' }],
    });
  });

  test('a remote image is kept as alt text and address, never as something to load', () => {
    const [paragraph] = parseMarkdown('![a chart](https://example.com/chart.png)');
    expect(paragraph).toEqual({
      t: 'paragraph',
      children: [{ t: 'image', alt: 'a chart', src: 'https://example.com/chart.png' }],
    });
  });

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
    const [paragraph] = parseMarkdown('[bad](javascript:alert(1)) and [ok](https://example.com)');
    expect(paragraph).toMatchObject({
      t: 'paragraph',
      children: [
        { t: 'text', text: 'bad and ' },
        { t: 'link', href: 'https://example.com' },
      ],
    });
  });

  test('a snake_case word keeps its underscores', () => {
    expect(parseMarkdown('use snake_case_name here')).toEqual([
      { t: 'paragraph', children: [{ t: 'text', text: 'use snake_case_name here' }] },
    ]);
  });
});
