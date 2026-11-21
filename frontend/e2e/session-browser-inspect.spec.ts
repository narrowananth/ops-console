import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { type APIRequestContext, expect, type Frame, type Locator, type Page, test } from '@playwright/test';
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

const inspect = (scope: Page | Locator) => scope.getByRole('button', { name: 'Inspect', exact: true });
const devtoolsFrame = (scope: Page | Locator) => scope.locator('iframe[title="DevTools"]');

/** The DevTools document inside the iframe, found by its address: the frame locator does not see into its text. */
async function insideDevtools(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((frame) => frame.url().includes('/devtools-frontend/'))).toBe(true);
  const found = page.frames().find((frame) => frame.url().includes('/devtools-frontend/'));
  if (!found) throw new Error('DevTools are not loaded');
  return found;
}

/** The size the panel last asked the daemon to give the page: a Fill page follows the stage's own area. */
function watchResizes(page: Page) {
  const sizes: { width: number; height: number }[] = [];
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/browser/')) return;
    socket.on('framesent', (frame) => {
      const message = JSON.parse(String(frame.payload)) as { type: string; width?: number; height?: number };
      if (message.type === 'resize' && message.width && message.height) {
        sizes.push({ width: message.width, height: message.height });
      }
    });
  });
  return { last: () => sizes.at(-1) };
}

const area = async (node: Locator) => {
  const box = await node.boundingBox();
  if (!box) throw new Error('nothing is drawn there');
  return box;
};

test('Inspect docks Chrome DevTools under the page, which keeps the area that is left (39, 40, 43)', async ({
  page,
  request,
}) => {
  needsChrome();
  needsDevtools();
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1500, height: 900 });
  const resizes = watchResizes(page);
  const { panel } = await openPanelOn(page, request, `${origin}/`);
  const canvas = panel.locator('canvas');
  await expect(inspect(panel)).toHaveAttribute('aria-pressed', 'false');
  const before = await area(canvas);
  await expect.poll(() => resizes.last()?.height).toBeGreaterThan(before.height * 0.9);
  const asked = resizes.last()?.height ?? 0;

  // DevTools asks no other host for anything (43): every request it makes goes to the daemon.
  const hosts = new Set<string>();
  page.context().on('request', (request) => {
    if (/^(https?|wss?):/.test(request.url())) hosts.add(new URL(request.url()).host);
  });
  await inspect(panel).click();
  await expect(inspect(panel)).toHaveAttribute('aria-pressed', 'true');
  const frame = devtoolsFrame(panel);
  await expect(frame).toBeVisible();

  // Docked at the bottom: under the page, which has the area that is left and is asked for that size.
  const docked = await area(canvas);
  const devtoolsBox = await area(frame);
  expect(docked.height).toBeLessThan(before.height - 100);
  expect(docked.width).toBeCloseTo(before.width, 0);
  expect(devtoolsBox.y).toBeGreaterThanOrEqual(docked.y + docked.height - 1);
  await expect.poll(() => resizes.last()?.height).toBeLessThan(asked - 100);

  // The address names the tab's socket, never the token; the tab strip and the address field are as they were.
  const source = (await frame.getAttribute('src')) ?? '';
  expect(source).toMatch(/^\/devtools-frontend\/devtools_app\.html\?ws=127\.0\.0\.1:\d+\/browser\/[^/?#]+\/devtools$/);
  expect(source).not.toContain(daemon.token);
  await expect(panel.getByRole('tab', { name: /Inspect me/ })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Address' })).toBeVisible();

  // The real DevTools run inside the panel: Elements shows the page's DOM, and the Console takes keys and runs script.
  const devtools = await insideDevtools(page);
  await devtools.getByRole('tab', { name: 'Console' }).click();
  await page.waitForTimeout(4000);
  await expect(devtools.getByText('the page says hello').first()).toBeVisible({
    timeout: 30_000,
  });
  await devtools.locator('.console-prompt-editor-container .cm-content').click();
  await page.keyboard.type('1+1');
  await page.keyboard.press('Enter');
  await expect(devtools.locator('.console-user-command-result').getByText('2', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.keyboard.type("document.getElementById('heading').textContent");
  await page.keyboard.press('Enter');
  await expect(devtools.locator('.console-user-command-result').getByText('Hello from the page')).toBeVisible();
  expect([...hosts].filter((host) => !host.startsWith('127.0.0.1:'))).toEqual([]);

  // The page keeps being drawn; Inspect again closes DevTools and gives the area back.
  await expect(canvas).toBeVisible();
  await inspect(panel).click();
  await expect(frame).toHaveCount(0);
  await expect(inspect(panel)).toHaveAttribute('aria-pressed', 'false');
  expect((await area(canvas)).height).toBeCloseTo(before.height, 0);
  await expect.poll(() => resizes.last()?.height).toBeGreaterThan(asked - 20);
});

test('DevTools dock at the bottom or the right, and the side is kept, the splitter resizes and the X closes (44)', async ({
  page,
  request,
}) => {
  needsChrome();
  needsDevtools();
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1500, height: 900 });
  const resizes = watchResizes(page);
  const { panel } = await openPanelOn(page, request, `${origin}/`);
  const canvas = panel.locator('canvas');
  const before = await area(canvas);
  await expect.poll(() => resizes.last()?.width).toBeGreaterThan(before.width * 0.9);
  const asked = resizes.last()?.width ?? 0;
  await inspect(panel).click();
  const frame = devtoolsFrame(panel);
  await expect(frame).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Dock to the bottom' })).toHaveAttribute('aria-pressed', 'true');

  // Right: beside the page, which keeps its height and loses width, and is asked for the new size.
  await panel.getByRole('button', { name: 'Dock to the right' }).click();
  await expect(panel.getByRole('button', { name: 'Dock to the right' })).toHaveAttribute('aria-pressed', 'true');
  const right = await area(canvas);
  const side = await area(frame);
  expect(right.width).toBeLessThan(before.width - 100);
  expect(right.height).toBeCloseTo(before.height, 0);
  expect(side.x).toBeGreaterThanOrEqual(right.x + right.width - 1);
  await expect.poll(() => resizes.last()?.width).toBeLessThan(asked - 100);

  // Beside the page DevTools show the page's DOM in Elements.
  await expect((await insideDevtools(page)).getByText('Hello from the page').first()).toBeVisible({
    timeout: 60_000,
  });

  // The splitter takes the arrow keys, and stops at a smallest size for each part.
  const splitter = panel.getByRole('separator', { name: 'Resize DevTools' });
  await splitter.focus();
  await page.keyboard.press('ArrowRight');
  expect((await area(frame)).width).toBeCloseTo(side.width - 32, 0);
  await page.keyboard.press('ArrowLeft');
  expect((await area(frame)).width).toBeCloseTo(side.width, 0);
  for (let i = 0; i < 60; i += 1) await page.keyboard.press('ArrowRight');
  const narrowest = (await area(frame)).width;
  expect(narrowest).toBeGreaterThanOrEqual(230);
  expect(narrowest).toBeLessThan(side.width);
  for (let i = 0; i < 120; i += 1) await page.keyboard.press('ArrowLeft');
  expect((await area(canvas)).width).toBeGreaterThanOrEqual(200);
  await splitter.dblclick();
  expect((await area(frame)).width).toBeCloseTo(side.width, -1);

  // The X closes DevTools, and the page area comes back.
  await panel.getByRole('button', { name: 'Close DevTools' }).click();
  await expect(frame).toHaveCount(0);
  expect((await area(canvas)).width).toBeCloseTo(before.width, 0);

  // A reload of the console remembers the side, and Inspect docks to it.
  await page.reload();
  await expect(panel.getByRole('tab', { name: /Inspect me/ })).toBeVisible({ timeout: 30_000 });
  await inspect(panel).click();
  await expect(panel.getByRole('button', { name: 'Dock to the right' })).toHaveAttribute('aria-pressed', 'true');
  expect((await area(frame)).x).toBeGreaterThan((await area(canvas)).x + 100);

  // Back to the bottom.
  await panel.getByRole('button', { name: 'Dock to the bottom' }).click();
  expect((await area(frame)).y).toBeGreaterThan((await area(canvas)).y + 50);
});

test('Open in a window takes DevTools out of the panel, with no token in the window address (41, 44)', async ({
  page,
  request,
}) => {
  needsChrome();
  needsDevtools();
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1500, height: 900 });
  const { panel } = await openPanelOn(page, request, `${origin}/`);
  const canvas = panel.locator('canvas');
  const before = await area(canvas);
  await inspect(panel).click();
  await expect(devtoolsFrame(panel)).toBeVisible();
  const [devtools] = await Promise.all([
    page.waitForEvent('popup'),
    panel.getByRole('button', { name: 'Open DevTools in a window' }).click(),
  ]);
  expect(devtools.url()).toMatch(
    /\/devtools-frontend\/devtools_app\.html\?ws=127\.0\.0\.1:\d+\/browser\/[^/?#]+\/devtools$/,
  );
  expect(devtools.url()).not.toContain(daemon.token);
  await expect(devtools.getByRole('tab', { name: 'Elements' })).toBeVisible({ timeout: 60_000 });
  await expect(devtools.getByText('Hello from the page').first()).toBeVisible({ timeout: 60_000 });
  await expect(devtoolsFrame(panel)).toHaveCount(0);
  expect((await area(canvas)).height).toBeCloseTo(before.height, 0);

  // Inspect docks it again; the window stays until the operator closes it.
  await inspect(panel).click();
  await expect(devtoolsFrame(panel)).toBeVisible();
  expect(devtools.isClosed()).toBe(false);
});

test('Inspect waits for a page, and a blocked window says so (39, 41)', async ({ page, request }) => {
  needsChrome();
  needsDevtools();
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const id = await newSession(request);
  await page.goto(`${daemon.url}/workspace?session=${id}#token=${daemon.token}`);
  await page.getByRole('button', { name: /^Browser( :\d+)?$/ }).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  await expect(inspect(panel)).toBeDisabled();

  await panel.getByRole('textbox', { name: 'Address' }).fill(`${origin}/`);
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(panel.getByRole('tab', { name: /Inspect me/ })).toBeVisible({ timeout: 30_000 });
  await inspect(panel).click();
  await panel.getByRole('button', { name: 'Open DevTools in a window' }).click();
  await expect(panel.getByText('The browser blocked the window. Allow pop-ups for this page.')).toBeVisible();
});

test('a tab in a window of its own docks DevTools too (39)', async ({ page, request }) => {
  needsChrome();
  needsDevtools();
  test.setTimeout(120_000);
  const { panel } = await openPanelOn(page, request, `${origin}/`);
  const [window] = await Promise.all([
    page.waitForEvent('popup'),
    panel.getByRole('button', { name: 'Open in a window' }).click(),
  ]);
  await inspect(window).click();
  await expect(devtoolsFrame(window)).toBeVisible();
  await expect((await insideDevtools(window)).getByRole('tab', { name: 'Elements' })).toBeVisible({
    timeout: 60_000,
  });
  await window.getByRole('button', { name: 'Close DevTools' }).click();
  await expect(devtoolsFrame(window)).toHaveCount(0);
});
