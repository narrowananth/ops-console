import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const auth = { Authorization: `Bearer ${daemon.token}` };
const api = (path: string) => `${daemon.url}/api${path}`;

const hasChrome = [
  process.env.OPS_CONSOLE_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].some((candidate) => candidate && existsSync(candidate));

const PAGE = `<!doctype html><title>Inspect me</title><style>body { font: 16px sans-serif; margin: 24px }</style>
<h1 id="heading">Hello from the page</h1><ul><li>First</li><li>Second</li></ul>
<script>console.log('the page says hello');</script>`;

function needsChrome(): void {
  if (hasChrome) return;
  if (process.env.CI) throw new Error('No Google Chrome found: set OPS_CONSOLE_CHROME_PATH or install it.');
  test.skip(true, 'needs Google Chrome');
}

/** CI builds DevTools; elsewhere `pnpm devtools-frontend` does. */
function needsDevtools(): void {
  if (existsSync(path.join(import.meta.dirname, '../public/devtools-frontend/PIN'))) return;
  if (process.env.CI) throw new Error('DevTools are not built: run pnpm devtools-frontend.');
  test.skip(true, 'needs pnpm devtools-frontend');
}

let dev: Server;
let origin: string;
test.beforeAll(async () => {
  dev = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(dev.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  dev.closeAllConnections();
  await new Promise((resolve) => dev.close(resolve));
});

// Other specs count the daemon's Sessions, so each one made here is deleted, which also ends its Chrome.
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

async function openPanelOn(page: Page, request: APIRequestContext, address: string) {
  const id = await newSession(request);
  await page.goto(`${daemon.url}/workspace?session=${id}#token=${daemon.token}`);
  await page.getByRole('button', { name: /^Browser( :\d+)?$/ }).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  await panel.getByRole('textbox', { name: 'Address' }).fill(address);
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(panel.getByRole('tab', { name: /Inspect me/ })).toBeVisible({ timeout: 30_000 });
  return { id, panel };
}

test('Inspect opens Chrome DevTools on the tab, with the page in Elements and a working Console (39, 40, 43)', async ({
  page,
  request,
}) => {
  needsChrome();
  needsDevtools();
  test.setTimeout(120_000);
  const { panel } = await openPanelOn(page, request, `${origin}/`);
  await page.setViewportSize({ width: 1500, height: 800 });

  // DevTools asks no other host for anything (43): every request it makes goes to the daemon.
  const hosts = new Set<string>();
  page.context().on('request', (request) => {
    if (/^(https?|wss?):/.test(request.url())) hosts.add(new URL(request.url()).host);
  });
  const [devtools] = await Promise.all([
    page.waitForEvent('popup'),
    panel.getByRole('button', { name: 'Inspect', exact: true }).click(),
  ]);
  await devtools.setViewportSize({ width: 1200, height: 800 });

  // The address names the tab's socket, never the token.
  expect(devtools.url()).toMatch(
    /\/devtools-frontend\/devtools_app\.html\?ws=127\.0\.0\.1:\d+\/browser\/[^/?#]+\/devtools$/,
  );
  expect(devtools.url()).not.toContain(daemon.token);

  // Elements shows the page's own DOM.
  await devtools.getByRole('tab', { name: 'Elements' }).click();
  await expect(devtools.getByText('Hello from the page').first()).toBeVisible({ timeout: 60_000 });

  // Console: an expression runs in the page, and the page's own log line is there.
  await devtools.getByRole('tab', { name: 'Console' }).click();
  await expect(devtools.getByText('the page says hello').first()).toBeVisible({ timeout: 30_000 });
  await devtools.locator('.console-prompt-editor-container .cm-content').click();
  await devtools.keyboard.type('1+1');
  await devtools.keyboard.press('Enter');
  await expect(devtools.locator('.console-user-command-result').getByText('2', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await devtools.keyboard.type("document.getElementById('heading').textContent");
  await devtools.keyboard.press('Enter');
  await expect(devtools.locator('.console-user-command-result').getByText('Hello from the page')).toBeVisible();

  expect([...hosts].filter((host) => !host.startsWith('127.0.0.1:'))).toEqual([]);

  // A second click brings the window forward and does not open another.
  let more = 0;
  page.on('popup', () => {
    more += 1;
  });
  await panel.getByRole('button', { name: 'Inspect', exact: true }).click();
  await page.waitForTimeout(500);
  expect(more).toBe(0);

  // The panel keeps drawing the page while DevTools is open.
  await expect(panel.locator('canvas')).toBeVisible();
  await devtools.close();
});

test('Inspect waits for a page, and a blocked popup says so (39)', async ({ page, request }) => {
  needsChrome();
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const id = await newSession(request);
  await page.goto(`${daemon.url}/workspace?session=${id}#token=${daemon.token}`);
  await page.getByRole('button', { name: /^Browser( :\d+)?$/ }).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  await expect(panel.getByRole('button', { name: 'Inspect', exact: true })).toBeDisabled();

  await panel.getByRole('textbox', { name: 'Address' }).fill(`${origin}/`);
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(panel.getByRole('tab', { name: /Inspect me/ })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('button', { name: 'Inspect', exact: true }).click();
  await expect(panel.getByText('The browser blocked the window. Allow pop-ups for this page.')).toBeVisible();
});

test('a tab in a window of its own has Inspect too (39)', async ({ page, request }) => {
  needsChrome();
  const { panel } = await openPanelOn(page, request, `${origin}/`);
  const [window] = await Promise.all([
    page.waitForEvent('popup'),
    panel.getByRole('button', { name: 'Open in a window' }).click(),
  ]);
  const [devtools] = await Promise.all([
    window.waitForEvent('popup'),
    window.getByRole('button', { name: 'Inspect', exact: true }).click(),
  ]);
  expect(devtools.url()).toContain('/devtools-frontend/devtools_app.html?ws=');
});
