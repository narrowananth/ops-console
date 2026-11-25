import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type APIRequestContext, expect, type Page, test, type WebSocketRoute } from '@playwright/test';
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
      '/corners': [
        'text/html',
        `<!doctype html><title>Corners</title><style>body { margin: 0 } button { position: fixed; width: 60px; height: 60px }
#tl { left: 0; top: 0 } #tr { right: 0; top: 0 } #bl { left: 0; bottom: 0 } #br { right: 0; bottom: 0 }
#mid { left: 50%; top: 50%; width: 80px; height: 80px; margin: -40px 0 0 -40px }</style>
<button id="tl"></button><button id="tr"></button><button id="bl"></button><button id="br"></button><button id="mid"></button>
<script>for (const b of document.querySelectorAll('button')) b.addEventListener('click', () => { document.title = 'hit-' + b.id; });</script>`,
      ],
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

// The row carries a `:port` badge while a server of the Session listens, and the badge is part of the button's name.
const browserButton = (page: Page) => page.getByRole('button', { name: /^Browser( :\d+)?$/ });

const openSession = async (page: Page, id: string) => {
  await page.goto(`${daemon.url}/sessions?session=${id}#token=${daemon.token}`);
  await browserButton(page).waitFor();
};

test('a Session shows the page the operator opens, takes input on it, and lists what it called (2, 3, 4, 6, 10)', async ({
  page,
  request,
}) => {
  needsChrome();
  await openSession(page, await newSession(request));
  await browserButton(page).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  await expect(panel.getByText('No server is running for this Session')).toBeVisible();

  await panel.getByRole('textbox', { name: 'Address' }).fill(origin);
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  // The first page waits on a cold Chrome start, slow on a CI runner.
  await expect(panel.getByRole('tab', { name: /Dev shop/ })).toBeVisible({ timeout: 30_000 });

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

test('a dropped page stream says so while the last frame stays, and the notice goes when the stream returns', async ({
  page,
  request,
}) => {
  needsChrome();
  // The viewer's socket is routed through the test, so it can be cut and refused, then let through again.
  const open: WebSocketRoute[] = [];
  let refusing = false;
  await page.routeWebSocket(/\/browser\//, (route) => {
    if (refusing) return void route.close();
    route.connectToServer();
    open.push(route);
  });
  await openSession(page, await newSession(request));
  await browserButton(page).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  await panel.getByRole('textbox', { name: 'Address' }).fill(origin);
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(panel.getByRole('tab', { name: /Dev shop/ })).toBeVisible({ timeout: 30_000 });
  const lost = panel.getByRole('status').filter({ hasText: 'Reconnecting' });
  await expect(lost).toHaveCount(0);

  // A click answered by the page shows a frame was drawn and the stream carries input.
  const box = await panel.locator('canvas').boundingBox();
  if (!box) throw new Error('the page is not drawn');
  await expect(async () => {
    await page.mouse.click(box.x + 80, box.y + 50);
    await expect(panel.getByRole('tab', { name: /clicks: \d/ })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });

  refusing = true;
  for (const route of open.splice(0)) await route.close();
  await expect(lost).toBeVisible();
  refusing = false;
  await expect(lost).toHaveCount(0, { timeout: 15_000 });
});

test.describe('on a Retina screen', () => {
  test.use({ deviceScaleFactor: 2 });

  test('the page is drawn at twice the pixels on a canvas of the stage size, and clicks at the corners and the centre land (7)', async ({
    page,
    request,
  }) => {
    needsChrome();
    await openSession(page, await newSession(request));
    await browserButton(page).click();
    const panel = page.getByRole('complementary', { name: 'Browser' });
    await panel.getByRole('textbox', { name: 'Address' }).fill(`${origin}/corners`);
    await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
    await expect(panel.getByRole('tab', { name: /Corners/ })).toBeVisible({ timeout: 30_000 });

    const canvas = panel.locator('canvas');
    const measure = () =>
      canvas.evaluate((node: HTMLCanvasElement) => ({
        pixels: { width: node.width, height: node.height },
        css: { width: node.clientWidth, height: node.clientHeight },
        stage: { width: node.parentElement?.clientWidth, height: node.parentElement?.clientHeight },
      }));
    // The frame is drawn at its own pixels, and the canvas stays the stage's CSS size.
    await expect
      .poll(
        async () => {
          const { pixels, css } = await measure();
          return pixels.width === css.width * 2 && pixels.height === css.height * 2;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const size = await measure();
    expect(size.css).toEqual(size.stage);

    const box = await canvas.boundingBox();
    if (!box) throw new Error('the page is not drawn');
    const at: [string, number, number][] = [
      ['tl', 20, 20],
      ['tr', box.width - 20, 20],
      ['bl', 20, box.height - 20],
      ['br', box.width - 20, box.height - 20],
      ['mid', box.width / 2, box.height / 2],
    ];
    // The page may still be loading its script, so the first click repeats until it answers.
    for (const [id, x, y] of at) {
      await expect(async () => {
        await page.mouse.click(box.x + x, box.y + y);
        await expect(panel.getByRole('tab', { name: `hit-${id}` })).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 20_000 });
    }
  });
});

test('a port with no server says so (8)', async ({ page, request }) => {
  needsChrome();
  await openSession(page, await newSession(request));
  await browserButton(page).click();
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

test('the Terminals dock explains itself when empty, runs a shell the operator types in, and deletes it (15, 16, 17)', async ({
  page,
  request,
}) => {
  const id = await newSession(request);
  await openSession(page, id);
  await page.getByRole('button', { name: 'Terminals' }).click();
  const dock = page.getByRole('region', { name: 'Terminals' });
  await expect(dock.getByRole('heading', { name: 'No terminals yet' })).toBeVisible();
  await expect(dock.getByText(/keeps running when you hide this panel/)).toBeVisible();
  await expect(dock.getByText(/Its page opens in the Browser panel/)).toBeVisible();
  // A folder with no scripts has no script menu to puzzle over.
  await expect(dock.getByRole('button', { name: 'Scripts and folder' })).toHaveCount(0);

  // The empty state's own button and the header's both make a terminal.
  await dock.getByRole('button', { name: 'New terminal' }).last().click();
  await expect(dock.getByText('shell', { exact: true })).toBeVisible();
  await expect(dock.getByTitle(/^Running · started/)).toBeVisible();
  // One terminal has no list beside it.
  await expect(dock.getByRole('tab')).toHaveCount(0);
  await expect(dock.getByRole('heading', { name: 'No terminals yet' })).toHaveCount(0);
  await dock.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo dock-says-$((20 + 22))\n');
  await expect(dock.locator('.xterm-rows:visible')).toContainText('dock-says-42');

  // A second terminal comes in front; the first keeps its screen, mounted behind it.
  await dock.getByRole('button', { name: 'New terminal' }).first().click();
  await expect(dock.getByRole('tab', { name: /shell-2/ })).toBeVisible();
  await expect(dock.locator('.xterm-rows:visible')).not.toContainText('dock-says-42');
  await expect(dock.locator('.xterm')).toHaveCount(2);
  await dock.getByRole('tab', { name: /shell(?!-2)/ }).click();
  await expect(dock.locator('.xterm-rows:visible')).toContainText('dock-says-42');

  // Hiding the dock ends nothing.
  await dock.getByRole('button', { name: 'Hide terminals' }).click();
  await expect(dock).toHaveCount(0);
  expect((await processesOf(request, id)).map((p) => p.state)).toEqual(['running', 'running']);
  await page.getByRole('button', { name: 'Terminals' }).click();

  // Delete is the one way to end a terminal: a running one is stopped and taken off the list in one step.
  await expect(dock.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await dock.getByRole('button', { name: 'Delete terminal' }).click();
  await expect.poll(async () => (await processesOf(request, id)).map((p) => p.name)).toEqual(['shell-2']);
  await dock.getByRole('button', { name: 'Delete terminal' }).click();
  await expect.poll(async () => (await processesOf(request, id)).length).toBe(0);
  await expect(dock.getByRole('heading', { name: 'No terminals yet' })).toBeVisible();
});

test('Split puts a new shell beside the selected one, the list joins them, and Maximize grows the dock (15)', async ({
  page,
  request,
}) => {
  const id = await newSession(request);
  await openSession(page, id);
  await page.getByRole('button', { name: 'Terminals' }).click();
  const dock = page.getByRole('region', { name: 'Terminals' });
  await dock.getByRole('button', { name: 'New terminal' }).last().click();
  await expect(dock.locator('.xterm-rows:visible')).toHaveCount(1);

  await dock.getByRole('button', { name: 'Split terminal' }).click();
  await expect(dock.locator('.xterm-rows:visible')).toHaveCount(2);
  const list = dock.getByRole('tablist', { name: 'Processes' });
  await expect(list.getByRole('tab')).toHaveCount(2);
  await expect(list.getByRole('tab', { name: /shell-2/ })).toHaveAttribute('aria-selected', 'true');

  // A terminal of its own leaves the split on the list and shows alone.
  await dock.getByRole('button', { name: 'New terminal' }).first().click();
  await expect(list.getByRole('tab')).toHaveCount(3);
  await expect(dock.locator('.xterm-rows:visible')).toHaveCount(1);
  await list.getByRole('tab', { name: /shell-2/ }).click();
  await expect(dock.locator('.xterm-rows:visible')).toHaveCount(2);

  const before = (await dock.boundingBox())?.height ?? 0;
  await dock.getByRole('button', { name: 'Maximize terminals' }).click();
  await expect.poll(async () => (await dock.boundingBox())?.height ?? 0).toBeGreaterThan(before);
  await dock.getByRole('button', { name: 'Restore terminals' }).click();
  await expect.poll(async () => (await dock.boundingBox())?.height ?? 0).toBe(before);
});

test('an exited process shows its code, can be restarted or deleted, and the empty state returns (17)', async ({
  page,
  request,
}) => {
  const id = await newSession(request);
  const failing = await request.post(api(`/sessions/${id}/processes`), {
    headers: auth,
    data: { name: 'build', command: 'echo build-failed; exit 3' },
  });
  expect(failing.status()).toBe(201);
  await expect.poll(async () => (await processesOf(request, id))[0]?.state).toBe('exited');

  await openSession(page, id);
  await page.getByRole('button', { name: 'Terminals' }).click();
  const dock = page.getByRole('region', { name: 'Terminals' });
  await expect(dock.getByTitle(/^Exited with code 3/)).toBeVisible();
  await expect(dock.getByText('exited 3')).toBeVisible();
  await expect(dock.locator('.xterm-rows:visible')).toContainText('build-failed');
  await expect(dock.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(dock.getByRole('button', { name: 'Restart' })).toBeEnabled();

  await dock.getByRole('button', { name: 'Delete terminal' }).click();
  await expect(dock.getByRole('heading', { name: 'No terminals yet' })).toBeVisible();
  await expect.poll(async () => (await processesOf(request, id)).length).toBe(0);
});

test('a file the page asks for is chosen in the panel and handed to the page by its name (6)', async ({
  page,
  request,
}) => {
  needsChrome();
  await openSession(page, await newSession(request));
  await browserButton(page).click();
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

type ProcessView = { id: string; name: string; state: string; folder: string; started_at: string };

const processesOf = async (request: APIRequestContext, id: string): Promise<ProcessView[]> =>
  ((await (await request.get(api(`/sessions/${id}/processes`), { headers: auth })).json()) as { data: ProcessView[] })
    .data;

test("Run lists the folder's package.json scripts and starts one; Restart runs it again and Delete ends it (15, 16, 17)", async ({
  page,
  request,
}) => {
  const id = await newSession(request);
  // The Session's own folder gets a package.json, written by a process the way the operator would from a shell.
  const writer = await request.post(api(`/sessions/${id}/processes`), {
    headers: auth,
    data: {
      name: 'setup',
      command: `printf '{"scripts":{"hello":"echo hello-from-script && sleep 600","quick":"echo q"}}' > package.json`,
    },
  });
  expect(writer.status()).toBe(201);
  await expect.poll(async () => (await processesOf(request, id))[0]?.state).toBe('exited');

  await openSession(page, id);
  await page.getByRole('button', { name: 'Terminals' }).click();
  const dock = page.getByRole('region', { name: 'Terminals' });
  await dock.getByRole('button', { name: 'Scripts and folder' }).click();
  await expect(page.getByRole('menuitem', { name: /hello/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /quick/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /hello/ }).click();
  await expect(dock.locator('.xterm-rows:visible')).toContainText('hello-from-script');

  const first = (await processesOf(request, id)).find((p) => p.name === 'hello');
  expect(first?.state).toBe('running');

  await dock.getByRole('button', { name: 'Restart' }).click();
  await expect
    .poll(async () => (await processesOf(request, id)).find((p) => p.name === 'hello')?.started_at)
    .not.toBe(first?.started_at);
  await expect(dock.locator('.xterm-rows:visible')).toContainText('hello-from-script');
  expect((await processesOf(request, id)).find((p) => p.name === 'hello')?.state).toBe('running');

  // Deleting a running script ends it and takes it off the list.
  await dock.getByRole('button', { name: 'Delete terminal' }).click();
  await expect.poll(async () => (await processesOf(request, id)).some((p) => p.name === 'hello')).toBe(false);
});

test("a server left running in the Session's folder shows in Local servers with a Stop that ends it (11)", async ({
  page,
  request,
}) => {
  needsChrome();
  const id = await newSession(request);
  const shell = await request.post(api(`/sessions/${id}/processes`), { headers: auth, data: { name: 'shell' } });
  const { folder } = ((await shell.json()) as { data: ProcessView }).data;
  // Not started by a Session process: a stand-in for a server that outlived its terminal.
  const leftover = spawn(
    process.execPath,
    [
      '-e',
      "const s = require('node:http').createServer((_q, r) => r.end('up')); s.listen(0, '127.0.0.1', () => console.log('port=' + s.address().port));",
    ],
    { cwd: folder },
  );
  try {
    const port = await new Promise<number>((resolve) => {
      let seen = '';
      leftover.stdout.on('data', (chunk) => {
        seen += String(chunk);
        const found = /port=(\d+)/.exec(seen);
        if (found) resolve(Number(found[1]));
      });
    });
    await openSession(page, id);
    // The badge shows once the Session's servers are read, so the click below runs with it, as it does on a slow machine.
    await expect(page.getByText(`:${port}`, { exact: true })).toBeVisible();
    await browserButton(page).click();
    const panel = page.getByRole('complementary', { name: 'Browser' });
    const row = panel.getByRole('listitem').filter({ hasText: `:${port}` });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Stop' }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => leftover.exitCode !== null || leftover.signalCode !== null).toBe(true);
  } finally {
    leftover.kill('SIGKILL');
  }
});

test("a server a process starts opens its page in the Browser panel, and the list holds only this Session's (11)", async ({
  page,
  request,
}) => {
  needsChrome();
  const id = await newSession(request);
  await openSession(page, id);
  const script =
    "require('node:http').createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<title>Auto app</title><p>up</p>'); }).listen(0, '127.0.0.1')";
  const started = await request.post(api(`/sessions/${id}/processes`), {
    headers: auth,
    data: { name: 'web', command: `node -e "${script}"` },
  });
  expect(started.ok()).toBe(true);

  const panel = page.getByRole('complementary', { name: 'Browser' });
  await expect(panel.getByRole('tab', { name: /Auto app/ })).toBeVisible({ timeout: 30_000 });
  // Another tab shows the list: only the process's server is there, not every listener on the Mac.
  await panel.getByRole('button', { name: 'New tab' }).click();
  const list = panel.getByRole('list', { name: 'Local servers' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
});

test('opening a server a tab already shows reloads that tab instead of adding one (11a, 13)', async ({
  page,
  request,
}) => {
  needsChrome();
  const id = await newSession(request);
  await openSession(page, id);
  const script =
    "require('node:http').createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<title>Reuse app</title><p>up</p>'); }).listen(0, '127.0.0.1')";
  const started = await request.post(api(`/sessions/${id}/processes`), {
    headers: auth,
    data: { name: 'web', command: `node -e "${script}"` },
  });
  expect(started.ok()).toBe(true);

  const panel = page.getByRole('complementary', { name: 'Browser' });
  await expect(panel.getByRole('tab', { name: /Reuse app/ })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('button', { name: 'New tab' }).click();
  await panel.getByRole('list', { name: 'Local servers' }).getByRole('button', { name: /Open/ }).click();
  // The page loads in the tab that already showed it; the blank tab stays blank.
  await expect(panel.getByRole('tab', { name: /Reuse app/ })).toHaveCount(1);
  await expect(panel.getByRole('tab', { name: /Reuse app/ })).toHaveAttribute('aria-selected', 'true');
});
