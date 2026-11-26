import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const T0 = '2026-11-06T10:00:00.000Z';
const T1 = '2026-11-06T10:05:00.000Z';
const T2 = '2026-11-06T10:10:00.000Z';
const SHOTS = process.env.VIEWER_SHOTS;
const UI_SHOTS = process.env.UI_FIXES_SHOTS;

type Served = { body: string; modified_at?: string };

const REPORT = [
  '# Weekly report',
  '',
  'Totals went **up**, *slightly*, and ~~one~~ item is [documented](https://example.com/docs) or [unsafe](javascript:alert(1)). Names like snake_case_name stay as written.',
  '',
  '- [x] ship the viewer',
  '- [ ] write the docs',
  '',
  '| route | p95 |',
  '| --- | --- |',
  '| /orders | 120ms |',
  '',
  '> a quoted line',
  '',
  '![chart](https://example.com/chart.png)',
  '',
  '<script>window.__ran = 1</script>',
  '',
  '```ts',
  'const total = 1;',
  '```',
].join('\n');

const RESULT = JSON.stringify({
  connection: 'orders-db',
  query: 'select id, status from orders limit 2',
  columns: ['id', 'status'],
  rows: [
    [1, 'paid'],
    [2, 'refunded'],
  ],
  total: 120,
  ms: 14,
});

const rows = (count: number) =>
  ['n,label', ...Array.from({ length: count }, (_, at) => `${at + 1},row ${at + 1}`)].join('\n');

const FILES: Record<string, Served> = {
  'report.md': { body: REPORT, modified_at: T1 },
  'data.json': {
    body: JSON.stringify({ name: 'orders', count: 2, ok: true, none: null, items: [{ id: 1 }, { id: 2 }] }),
    modified_at: T1,
  },
  'broken.json': { body: '{\n  "a": 1,\n  "b": }\n', modified_at: T1 },
  'events.jsonl': { body: '{"id":1}\n{"id":2}\n', modified_at: T1 },
  'result.json': { body: RESULT, modified_at: T1 },
  'sales.csv': { body: 'region,total\n"North, East",10\nWest,9\nSouth,100\n', modified_at: T1 },
  'big.csv': { body: rows(1500), modified_at: T1 },
  'flow.mmd': {
    body: 'flowchart LR\n  A[Alert] --> B{Verified?}\n  B -->|yes| C[Fix]\n  B -->|no| D[Close]',
    modified_at: T1,
  },
  'bad.mmd': { body: 'flowchart LR\n  A --> -->', modified_at: T1 },
  'graph.dot': { body: 'digraph G { api -> db; api -> cache; cache -> db }', modified_at: T1 },
  'bad.dot': { body: 'digraph G { api -> }', modified_at: T1 },
  'page.html': { body: '<h1>Page</h1><script>window.parent.__ran = 1</script>', modified_at: T1 },
  'huge.log': { body: `${'x'.repeat(300 * 1024)}END`, modified_at: T1 },
  'huge.json': { body: JSON.stringify({ pad: 'y'.repeat(2 * 1024 * 1024 + 10) }), modified_at: T1 },
  'huge.html': { body: `<h1>Big page</h1><!-- ${'z'.repeat(2 * 1024 * 1024 + 10)} -->`, modified_at: T1 },
  'later.txt': { body: 'later', modified_at: T2 },
};

async function open(page: Page, extraMessageText = '') {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/repos', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'r1',
            name: 'apis',
            path: '/work/apis',
            host: 'github',
            remote_slug: 'example/apis',
            origin_slug: null,
            default_branch: 'main',
            created_at: T0,
            branch: 'main',
            dirty: false,
            missing: false,
            session_count: 1,
          },
        ],
        meta: { next_cursor: null },
      },
    }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 's1',
            kind: 'repo',
            title: 'flow',
            model: 'claude-opus-5-5',
            effort: 'medium',
            access_mode: 'auto',
            account_id: null,
            repo_id: 'r1',
            branch: 'main',
            pr_number: null,
            pr_action: null,
            connection_ids: null,
            extra_repo_ids: [],
            pull_request: null,
            pull_requests: [],
            alert_id: null,
            state: 'idle',
            last_message_preview: null,
            last_error: null,
            created_at: T0,
            last_active_at: T0,
            playbook: null,
            queued_message: null,
            spawned_by: null,
            spawned: [],
            subagents: [],
          },
        ],
      },
    }),
  );
  const text = [
    'Here you go.',
    '',
    '```json',
    '{"a": [1, 2]}',
    '```',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '```mermaid',
    'flowchart LR\n  X --> Y',
    '```',
    '',
    '```ops-result',
    RESULT,
    '```',
    extraMessageText,
  ].join('\n');
  await page.route('**/api/sessions/s1/messages', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'm1',
            role: 'agent',
            status: 'done',
            created_at: T0,
            parts: [
              { kind: 'text', text: 'Here you go.' },
              { kind: 'code', lang: 'json', text: '{"a": [1, 2]}' },
              { kind: 'code', lang: 'ts', text: 'const a = 1;' },
              { kind: 'code', lang: 'mermaid', text: 'flowchart LR\n  X --> Y' },
              {
                kind: 'result',
                connection: 'orders-db',
                query: 'select 1',
                columns: ['n'],
                rows: [[1]],
                total: 1,
                ms: 3,
              },
            ],
          },
        ],
      },
    }),
  );
  void text;
  await page.route('**/api/sessions/s1/outputs', (route) =>
    route.fulfill({
      json: {
        data: Object.entries(FILES).map(([name, file]) => ({
          name,
          size: file.body.length,
          modified_at: file.modified_at ?? T1,
        })),
      },
    }),
  );
  await page.route(/\/api\/sessions\/s1\/outputs\/[^/]+$/, (route) => {
    const name = decodeURIComponent(route.request().url().split('/').pop() ?? '');
    const file = FILES[name];
    return file
      ? route.fulfill({ status: 200, contentType: 'application/octet-stream', body: file.body })
      : route.fulfill({
          status: 404,
          json: { error: { code: 'not_found', message: `No file ${name} in the output folder` } },
        });
  });
  await page.route('**/api/sessions/s1/diff', (route) =>
    route.fulfill({ json: { data: { branch: 'main', base: 'origin/main', additions: 0, deletions: 0, files: [] } } }),
  );
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);
}

const chip = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Output files' }).getByRole('button', { name });

async function shot(page: Page, name: string) {
  if (SHOTS) await page.getByRole('dialog').screenshot({ path: `${SHOTS}/${name}.png` });
}

test('Markdown draws as elements, shows raw HTML as text, loads no image and drops a javascript link', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await open(page);
  await chip(page, 'report.md').click();
  const viewer = page.getByRole('dialog', { name: 'report.md' });
  await expect(viewer.getByRole('heading', { name: 'Weekly report' })).toBeVisible();
  await expect(viewer.getByRole('strong')).toHaveText('up');
  await expect(viewer.locator('em')).toHaveText('slightly');
  await expect(viewer).toContainText('snake_case_name');
  await expect(viewer.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  await expect(viewer.getByRole('checkbox', { name: 'Not done' })).not.toBeChecked();
  await expect(viewer.getByRole('cell', { name: '/orders' })).toBeVisible();
  await expect(viewer.locator('blockquote')).toHaveText('a quoted line');
  // Raw HTML is text, and nothing ran.
  await expect(viewer).toContainText('<script>window.__ran = 1</script>');
  expect(await page.evaluate(() => (window as unknown as { __ran?: number }).__ran)).toBeUndefined();
  // The remote image shows as alt text and address and is never requested.
  await expect(viewer).toContainText('[image: chart]');
  await expect(viewer).toContainText('https://example.com/chart.png');
  await expect(viewer.locator('img')).toHaveCount(0);
  expect(requests.filter((url) => url.includes('example.com'))).toEqual([]);
  // A good link opens a new tab with no referrer; the javascript one is plain text.
  const link = viewer.getByRole('link', { name: 'documented' });
  await expect(link).toHaveAttribute('href', 'https://example.com/docs');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(viewer.getByRole('link', { name: 'unsafe' })).toHaveCount(0);
  await expect(viewer).toContainText('unsafe');
  await shot(page, 'markdown');

  await viewer.getByRole('button', { name: 'Source' }).click();
  await expect(viewer.locator('pre')).toContainText('# Weekly report');
  await viewer.getByRole('button', { name: 'Copy', exact: true }).first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(REPORT);
  await expect(viewer.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'report.md');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});

test('JSON is a tree with the first level open, Expand all and Collapse all, and a bad file shows its line', async ({
  page,
}) => {
  await open(page);
  await chip(page, 'data.json').click();
  const viewer = page.getByRole('dialog', { name: 'data.json' });
  await expect(viewer.getByText('"orders"')).toBeVisible();
  // The array under `items` starts folded, so its objects are not there yet.
  await expect(viewer.getByText('items', { exact: true })).toBeVisible();
  await expect(viewer.getByText('"id"')).toHaveCount(0);
  await shot(page, 'json-first-level');
  await viewer.getByRole('button', { name: 'Expand all' }).click();
  await expect(viewer.getByText('id', { exact: true })).toHaveCount(2);
  await shot(page, 'json');
  await viewer.getByRole('button', { name: 'Collapse all' }).click();
  await expect(viewer.getByText('"orders"')).toHaveCount(0);
  await viewer.getByRole('button', { name: 'Source' }).click();
  await expect(viewer.locator('pre')).toContainText('"name":"orders"');
  await page.keyboard.press('Escape');

  await chip(page, 'broken.json').click();
  const broken = page.getByRole('dialog', { name: 'broken.json' });
  await expect(broken.getByRole('alert')).toContainText('line 3');
  await expect(broken.locator('pre')).toContainText('"b": }');
  await page.keyboard.press('Escape');

  await chip(page, 'events.jsonl').click();
  const lines = page.getByRole('dialog', { name: 'events.jsonl' });
  await lines.getByRole('button', { name: 'Expand all' }).click();
  await expect(lines.getByText('line 1')).toBeVisible();
  await expect(lines.getByText('line 2')).toBeVisible();
});

test('a JSON file holding one ops-result object shows as the Result table', async ({ page }) => {
  await open(page);
  await chip(page, 'result.json').click();
  const viewer = page.getByRole('dialog', { name: 'result.json' });
  const table = viewer.getByRole('region', { name: 'Result from orders-db' });
  await expect(table).toContainText('select id, status from orders limit 2');
  await expect(table.getByRole('cell', { name: 'refunded' })).toBeVisible();
  await expect(table).toContainText('120 rows');
  await expect(table).toContainText('14ms');
  await shot(page, 'ops-result');
});

test('CSV is a table that sorts on a header click, and a long one shows the first 1000 rows with the total', async ({
  page,
}) => {
  await open(page);
  await chip(page, 'sales.csv').click();
  const viewer = page.getByRole('dialog', { name: 'sales.csv' });
  await expect(viewer.getByRole('cell', { name: 'North, East' })).toBeVisible();
  const first = () => viewer.locator('tbody tr').first();
  await expect(first()).toContainText('North, East');
  await viewer.getByRole('button', { name: 'total', exact: false }).click();
  await expect(first()).toContainText('West');
  await viewer.getByRole('button', { name: 'total', exact: false }).click();
  await expect(first()).toContainText('South');
  await shot(page, 'csv');
  await page.keyboard.press('Escape');

  await chip(page, 'big.csv').click();
  const big = page.getByRole('dialog', { name: 'big.csv' });
  await expect(big.locator('tbody tr')).toHaveCount(1000);
  await expect(big).toContainText('1500 rows');
  await expect(big).toContainText('showing the first 1000');
  await expect(big.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'big.csv');
});

test('Mermaid and Graphviz draw as an image, with zoom, and a bad source shows the message and the source', async ({
  page,
}) => {
  await open(page);
  await chip(page, 'flow.mmd').click();
  const viewer = page.getByRole('dialog', { name: 'flow.mmd' });
  const image = viewer.getByRole('img', { name: 'flow.mmd' });
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(50);
  // The drawing is an `<img>`: no SVG sits in the page.
  await expect(viewer.locator('svg')).toHaveCount(0);
  const before = await image.evaluate((img: HTMLImageElement) => img.clientWidth);
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.clientWidth)).toBeGreaterThan(before);
  await viewer.getByRole('button', { name: 'Fit' }).click();
  await shot(page, 'mermaid');
  await viewer.getByRole('button', { name: 'Source' }).click();
  await expect(viewer.locator('pre')).toContainText('flowchart LR');
  await page.keyboard.press('Escape');

  await chip(page, 'bad.mmd').click();
  const bad = page.getByRole('dialog', { name: 'bad.mmd' });
  await expect(bad.getByRole('alert')).toContainText('Could not draw it');
  await expect(bad.locator('pre')).toContainText('A --> -->');
  await page.keyboard.press('Escape');

  await chip(page, 'graph.dot').click();
  const graph = page.getByRole('dialog', { name: 'graph.dot' });
  const drawn = graph.getByRole('img', { name: 'graph.dot' });
  await expect.poll(() => drawn.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(50);
  await expect(graph.locator('svg')).toHaveCount(0);
  await shot(page, 'dot');
  await page.keyboard.press('Escape');

  await chip(page, 'bad.dot').click();
  const badDot = page.getByRole('dialog', { name: 'bad.dot' });
  await expect(badDot.getByRole('alert')).toContainText('Could not draw it');
  await expect(badDot.locator('pre')).toContainText('digraph G { api -> }');
});

test('the drawing code loads only when a Mermaid or Graphviz file opens, each with its own', async ({ page }) => {
  const loaded: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script' || request.url().endsWith('.wasm')) loaded.push(request.url());
  });
  await open(page);
  await page.waitForLoadState('networkidle');
  const initial = loaded.length;
  // A Markdown, JSON and CSV file open with no code beyond the page's own.
  for (const name of ['report.md', 'data.json', 'sales.csv']) {
    await chip(page, name).click();
    await expect(page.getByRole('dialog', { name })).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await page.waitForLoadState('networkidle');
  expect(loaded.slice(initial)).toEqual([]);
  await chip(page, 'flow.mmd').click();
  await expect(page.getByRole('dialog', { name: 'flow.mmd' }).getByRole('img', { name: 'flow.mmd' })).toBeVisible();
  const afterMermaid = loaded.length;
  expect(afterMermaid).toBeGreaterThan(initial);
  await page.keyboard.press('Escape');
  // Graphviz's code was not in Mermaid's: it comes in when its file opens.
  await chip(page, 'graph.dot').click();
  await expect(page.getByRole('dialog', { name: 'graph.dot' }).getByRole('img', { name: 'graph.dot' })).toBeVisible();
  expect(loaded.length).toBeGreaterThan(afterMermaid);
});

test('HTML stays in a frame with no allow token and runs no script', async ({ page }) => {
  await open(page);
  await chip(page, 'page.html').click();
  const viewer = page.getByRole('dialog', { name: 'page.html' });
  const frame = viewer.locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame).toHaveAttribute('csp', /default-src 'none'/);
  expect(await page.evaluate(() => (window as unknown as { __ran?: number }).__ran)).toBeUndefined();
  await viewer.getByRole('button', { name: 'Source' }).click();
  await expect(viewer.locator('iframe')).toHaveCount(0);
  await expect(viewer.locator('pre')).toContainText('<h1>Page</h1>');
});

test('a file over 2 MB, and other text over 256 KB, show their first 256 KB as source with a note', async ({
  page,
}) => {
  await open(page);
  await chip(page, 'huge.json').click();
  const json = page.getByRole('dialog', { name: 'huge.json' });
  await expect(json.locator('pre')).toContainText('the rest is cut here');
  await expect(json.getByRole('button', { name: 'Source' })).toHaveCount(0);
  await expect(json.getByRole('button', { name: 'Expand all' })).toHaveCount(0);
  expect((await json.locator('pre').textContent())?.length).toBeLessThan(300 * 1024);
  await page.keyboard.press('Escape');
  await chip(page, 'huge.log').click();
  const log = page.getByRole('dialog', { name: 'huge.log' });
  await expect(log.locator('pre')).toContainText('the rest is cut here');
  await expect(log.locator('pre')).not.toContainText('END');
});

test('an HTML file over 2 MB still draws in its frame, and its source is cut', async ({ page }) => {
  await open(page);
  await chip(page, 'huge.html').click();
  const viewer = page.getByRole('dialog', { name: 'huge.html' });
  await expect(viewer.locator('iframe')).toHaveAttribute('sandbox', '');
  await expect(viewer.frameLocator('iframe').getByRole('heading', { name: 'Big page' })).toBeVisible();
  await viewer.getByRole('button', { name: 'Source' }).click();
  await expect(viewer.locator('pre')).toContainText('the rest is cut here');
});

test('a file that is gone shows the error line', async ({ page }) => {
  await open(page);
  await page.unroute(/\/api\/sessions\/s1\/outputs\/[^/]+$/);
  await page.route(/\/api\/sessions\/s1\/outputs\/[^/]+$/, (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'No file in the output folder' } } }),
  );
  await chip(page, 'report.md').click();
  await expect(page.getByRole('dialog', { name: 'report.md' }).getByRole('alert')).toContainText(
    'Could not open the file',
  );
});

test('a code block of a drawn language has Expand beside Copy and opens the Viewer on its text', async ({ page }) => {
  await open(page);
  const json = page.locator('pre', { hasText: '{"a": [1, 2]}' });
  await json.hover();
  await expect(json.locator('xpath=..').getByRole('button', { name: 'Expand' })).toBeVisible();
  await expect(json.locator('xpath=..').getByRole('button', { name: 'Copy' })).toBeVisible();
  // A language the Viewer does not draw gets no Expand.
  const ts = page.locator('pre', { hasText: 'const a = 1;' });
  await expect(ts.locator('xpath=..').getByRole('button', { name: 'Expand' })).toHaveCount(0);
  await json.locator('xpath=..').getByRole('button', { name: 'Expand' }).click();
  const viewer = page.getByRole('dialog', { name: 'block.json' });
  await expect(viewer.getByText('a', { exact: true })).toBeVisible();
  await viewer.getByRole('button', { name: 'Source' }).click();
  await expect(viewer.locator('pre')).toHaveText('{"a": [1, 2]}');
  // Download saves the text with the language's extension.
  await expect(viewer.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'block.json');
  await page.keyboard.press('Escape');

  const diagram = page.locator('pre', { hasText: 'flowchart LR' });
  await diagram.locator('xpath=..').getByRole('button', { name: 'Expand' }).click();
  await expect(page.getByRole('dialog', { name: 'block.mmd' }).getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');

  // The ops-result block shows as the Result table, and its Expand opens the same table in the Viewer.
  await page.getByRole('region', { name: 'Result from orders-db' }).getByRole('button', { name: 'Expand' }).click();
  await expect(
    page.getByRole('dialog', { name: 'block.json' }).getByRole('region', { name: 'Result from orders-db' }),
  ).toBeVisible();
});

test('the Session panel lists the five newest Output files with their size, and a click opens the Viewer', async ({
  page,
}) => {
  await open(page);
  const list = page
    .getByRole('complementary', { name: 'Session' })
    .getByRole('list', { name: 'Files the agent wrote' });
  const items = list.getByRole('listitem');
  await expect(items).toHaveCount(5);
  await expect(items.first()).toContainText('later.txt');
  await expect(items.first()).toContainText('5 B');
  await list.getByRole('button', { name: /report\.md/ }).click();
  await expect(page.getByRole('dialog', { name: 'report.md' })).toBeVisible();
  // The list holds the same five after a reload.
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(items).toHaveCount(5);
});

test('the Session panel shows five Output files, then Show N more reveals the rest and Show less folds back', async ({
  page,
}) => {
  await open(page);
  const names = Array.from({ length: 12 }, (_, at) => `out-${String(at + 1).padStart(2, '0')}.txt`);
  await page.unroute('**/api/sessions/s1/outputs');
  await page.route('**/api/sessions/s1/outputs', (route) =>
    route.fulfill({
      json: {
        data: names.map((name, at) => ({
          name,
          size: 3,
          modified_at: `2026-11-06T11:${String(at).padStart(2, '0')}:00.000Z`,
        })),
      },
    }),
  );
  await page.reload();
  const panel = page.getByRole('complementary', { name: 'Session' });
  const items = panel.getByRole('list', { name: 'Files the agent wrote' }).getByRole('listitem');
  const more = panel.getByRole('button', { name: 'Show 7 more' });
  await expect(items).toHaveCount(5);
  await expect(items.first()).toContainText('out-12.txt');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.scrollIntoViewIfNeeded();
  if (UI_SHOTS) await panel.screenshot({ path: `${UI_SHOTS}/output-files-collapsed.png` });

  await more.click();
  await expect(items).toHaveCount(12);
  await expect(items.last()).toContainText('out-01.txt');
  const less = panel.getByRole('button', { name: 'Show less' });
  await expect(less).toHaveAttribute('aria-expanded', 'true');
  await less.scrollIntoViewIfNeeded();
  if (UI_SHOTS) await panel.screenshot({ path: `${UI_SHOTS}/output-files-expanded.png` });

  await less.click();
  await expect(items).toHaveCount(5);
  await expect(panel.getByRole('button', { name: 'Show 7 more' })).toBeVisible();
});

test('the Session panel has no Show more button for exactly five Output files', async ({ page }) => {
  await open(page);
  await page.unroute('**/api/sessions/s1/outputs');
  await page.route('**/api/sessions/s1/outputs', (route) =>
    route.fulfill({
      json: {
        data: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name: `${name}.txt`, size: 1, modified_at: T1 })),
      },
    }),
  );
  await page.reload();
  const panel = page.getByRole('complementary', { name: 'Session' });
  await expect(panel.getByRole('list', { name: 'Files the agent wrote' }).getByRole('listitem')).toHaveCount(5);
  await expect(panel.getByRole('button', { name: /^Show (\d+ more|less)/ })).toHaveCount(0);
});

test('the Session panel has no Output files section when the Session has none', async ({ page }) => {
  await open(page);
  await page.unroute('**/api/sessions/s1/outputs');
  await page.route('**/api/sessions/s1/outputs', (route) => route.fulfill({ json: { data: [] } }));
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Session' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Files the agent wrote' })).toHaveCount(0);
});
