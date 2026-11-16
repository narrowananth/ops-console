import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const auth = { Authorization: `Bearer ${daemon.token}` };
const api = (path: string) => `${daemon.url}/api${path}`;

const hasChrome = [
  process.env.OPS_CONSOLE_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].some((candidate) => candidate && existsSync(candidate));

// A page with CSS and script that calls a host outside this Mac, and writes its click count into its own title.
const PAGE = `<!doctype html><title>Dev shop</title><link rel="stylesheet" href="/app.css">
<body><h1>Dev shop</h1><button id="add" style="position:fixed;left:20px;top:20px;width:260px;height:120px">Add</button>
<script src="/app.js"></script></body>`;
const JS = `let n = 0;
document.getElementById('add').addEventListener('click', () => { n += 1; document.title = 'clicks: ' + n; });
fetch('https://assets.example.invalid/font.css').catch(() => {});`;

// CI runs on macOS runners that have Google Chrome; a missing one fails there instead of skipping.
function needsChrome(): void {
  if (hasChrome) return;
  if (process.env.CI) throw new Error('No Google Chrome found: set OPS_CONSOLE_CHROME_PATH or install it.');
  test.skip(true, 'needs Google Chrome');
}

let dev: Server;
let origin: string;
test.beforeAll(async () => {
  dev = createServer((req, res) => {
    const routes: Record<string, [string, string]> = {
      '/': ['text/html', PAGE],
      '/app.css': ['text/css', 'body { background: rgb(255, 247, 237); }'],
      '/app.js': ['text/javascript', JS],
      '/upload': [
        'text/html',
        `<!doctype html><title>Upload</title><input id="f" type="file" style="display:none">
<button id="pick" style="position:fixed;left:20px;top:20px;width:260px;height:120px" onclick="document.getElementById('f').click()">Pick</button>
<script>document.getElementById('f').addEventListener('change', (e) => { document.title = 'got ' + e.target.files[0].name; });</script>`,
      ],
    };
    const [type, body] = routes[req.url ?? ''] ?? ['text/plain', 'not found'];
    res.writeHead(200, { 'content-type': type }).end(body);
  });
  await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(dev.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  dev.closeAllConnections();
  await new Promise((resolve) => dev.close(resolve));
});

// Other specs count the daemon's Sessions, so each Session made here is deleted, which also ends its Chrome and processes.
const made: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(api(`/sessions/${id}`), { headers: auth });
});

async function newSession(request: APIRequestContext): Promise<string> {
  const response = await request.post(api('/sessions'), { headers: auth, data: { kind: 'anonymous' } });
  const id = ((await response.json()) as { data: { id: string } }).data.id;
  made.push(id);
  return id;
}

const openSession = async (page: Page, id: string) => {
  await page.goto(`${daemon.url}/workspace?session=${id}#token=${daemon.token}`);
  await page.getByRole('button', { name: 'Browser', exact: true }).waitFor();
};

test('a Session shows the page the operator opens, takes input on it, and lists what it called (2, 3, 4, 6, 10)', async ({
  page,
  request,
}) => {
  needsChrome();
  await openSession(page, await newSession(request));
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  await expect(panel.getByText('Local servers', { exact: false })).toBeVisible();

  await panel.getByRole('textbox', { name: 'Address' }).fill(origin);
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(panel.getByRole('tab', { name: /Dev shop/ })).toBeVisible();

  // A click on the drawn page reaches the page's own script.
  const canvas = panel.locator('canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('the page is not drawn');
  // The page may still be loading its script, so click until it answers.
  await expect(async () => {
    await page.mouse.click(box.x + 80, box.y + 50);
    await expect(panel.getByRole('tab', { name: /clicks: \d/ })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });

  // Nothing is blocked: the host the page called is listed.
  await expect(panel.getByText(/Called:.*assets\.example\.invalid/)).toBeVisible();
});

test('a port with no server says so (8)', async ({ page, request }) => {
  needsChrome();
  await openSession(page, await newSession(request));
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  const unused = (await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  })) as number;
  await panel.getByRole('textbox', { name: 'Address' }).fill(String(unused));
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(panel.getByText(`Nothing is listening on :${unused}`)).toBeVisible();
});

test('the Terminals dock runs a shell the operator types in, and stops it (15, 16, 17)', async ({ page, request }) => {
  const id = await newSession(request);
  await openSession(page, id);
  await page.getByRole('button', { name: 'Terminals' }).click();
  const dock = page.getByRole('region', { name: 'Terminals' });
  await expect(dock.getByText('No process. Run a script or open a terminal.')).toBeVisible();

  await dock.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('menuitem', { name: /New terminal/ }).click();
  await expect(dock.getByRole('tab', { name: /shell/ })).toBeVisible();
  await dock.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo dock-says-$((20 + 22))\n');
  await expect(dock.locator('.xterm-rows')).toContainText('dock-says-42');

  await dock.getByRole('button', { name: 'Stop' }).click();
  await expect(dock.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
  const listed = await request.get(api(`/sessions/${id}/processes`), { headers: auth });
  expect(((await listed.json()) as { data: { state: string }[] }).data[0]?.state).toBe('stopped');
});

test('a file the page asks for is chosen in the panel and handed to the page by its name (6)', async ({
  page,
  request,
}) => {
  needsChrome();
  await openSession(page, await newSession(request));
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  await panel.getByRole('textbox', { name: 'Address' }).fill(`${origin}/upload`);
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(panel.getByRole('tab', { name: /Upload/ })).toBeVisible();
  const box = await panel.locator('canvas').boundingBox();
  if (!box) throw new Error('the page is not drawn');
  await expect(async () => {
    await page.mouse.click(box.x + 80, box.y + 50);
    await expect(page.getByRole('dialog', { name: 'The page asks for a file' })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });

  await page.getByLabel('Choose from this computer').setInputFiles({
    name: 'report.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('a,b\n1,2\n'),
  });
  await expect(panel.getByRole('tab', { name: /got report\.csv/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('dialog', { name: 'The page asks for a file' })).toHaveCount(0);
});

test("the dock warns when a process's folder names a PROD Connection (5)", async ({ page, request }) => {
  const id = await newSession(request);
  const process = {
    id: 'p1',
    session_id: id,
    name: 'api',
    command: 'pnpm dev',
    folder: '/work/shop',
    state: 'running',
    exit_code: null,
    started_at: '2026-11-16T09:00:00.000Z',
    started_by: 'operator',
    prod_connections: ['orders-prod', 'billing-prod'],
  };
  await page.route(`**/api/sessions/${id}/processes`, (route) => route.fulfill({ json: { data: [process] } }));
  await openSession(page, id);
  await page.getByRole('button', { name: 'Terminals' }).click();
  await expect(
    page.getByRole('region', { name: 'Terminals' }).getByText(/names the PROD Connections orders-prod, billing-prod/),
  ).toBeVisible();
});
