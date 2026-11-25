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

// Four corner buttons: a click on one lands only when the page is as big as the window that shows it.
const CORNERS = `<!doctype html><title>Corners</title><style>body { margin: 0 } button { position: fixed; width: 60px; height: 60px }
#tl { left: 0; top: 0 } #br { right: 0; bottom: 0 }</style>
<button id="tl"></button><button id="br"></button>
<script>for (const b of document.querySelectorAll('button')) b.addEventListener('click', () => { document.title = 'hit-' + b.id; });</script>`;

function needsChrome(): void {
  if (hasChrome) return;
  if (process.env.CI) throw new Error('No Google Chrome found: set OPS_CONSOLE_CHROME_PATH or install it.');
  test.skip(true, 'needs Google Chrome');
}

let dev: Server;
let origin: string;
test.beforeAll(async () => {
  dev = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end(CORNERS));
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

const browserButton = (page: Page) => page.getByRole('button', { name: /^Browser( :\d+)?$/ });

async function openPanelOn(page: Page, request: APIRequestContext, address: string) {
  const id = await newSession(request);
  await page.goto(`${daemon.url}/sessions?session=${id}#token=${daemon.token}`);
  await browserButton(page).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  await panel.getByRole('textbox', { name: 'Address' }).fill(address);
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(panel.getByRole('tab', { name: /Corners/ })).toBeVisible({ timeout: 30_000 });
  return { id, panel };
}

/** Clicks on the drawn page until the page's own script answers; it may still be loading its script. */
async function clickUntil(page: Page, canvas: ReturnType<Page['locator']>, at: 'tl' | 'br', title: RegExp) {
  await expect(async () => {
    const box = await canvas.boundingBox();
    if (!box) throw new Error('the page is not drawn');
    const x = at === 'tl' ? box.x + 20 : box.x + box.width - 20;
    const y = at === 'tl' ? box.y + 20 : box.y + box.height - 20;
    await page.mouse.click(x, y);
    await expect(page).toHaveTitle(title, { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}

test('a tab opens in a window of its own, at the window size, and the panel steps aside until it closes (35, 36, 37)', async ({
  page,
  request,
}) => {
  needsChrome();
  const { id, panel } = await openPanelOn(page, request, `${origin}/`);
  // The page changes its own title, which the tab shows; the window title follows it.
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    panel.getByRole('button', { name: 'Open in a window' }).click(),
  ]);

  // The address names the Session and tab, never the token.
  expect(popup.url()).toMatch(new RegExp(`/browser-window/${id}/[^/#?]+$`));
  expect(popup.url()).not.toContain(daemon.token);

  // The window has no tab strip and no pop-out button of its own, and draws the page.
  await expect(popup.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Open in a window' })).toHaveCount(0);
  const canvas = popup.locator('canvas');
  await expect(canvas).toBeVisible();
  // A click in the window's bottom-right corner lands on the page's own corner button: the page has the window's size.
  await clickUntil(popup, canvas, 'br', /hit-br/);
  await popup.getByRole('button', { name: 'Reload' }).click();
  await clickUntil(popup, canvas, 'tl', /hit-tl/);

  // The panel does not draw the tab it handed over, and draws it again when the window closes.
  await expect(panel.getByText('This tab is open in its own window.')).toBeVisible();
  await expect(panel.locator('canvas')).toHaveCount(0);
  await popup.close();
  await expect(panel.locator('canvas')).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByText('This tab is open in its own window.')).toHaveCount(0);
});

test('Bring it back closes the window and the panel draws the tab again (37)', async ({ page, request }) => {
  needsChrome();
  const { panel } = await openPanelOn(page, request, `${origin}/`);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    panel.getByRole('button', { name: 'Open in a window' }).click(),
  ]);
  await expect(popup.locator('canvas')).toBeVisible();
  await panel.getByRole('button', { name: 'Bring it back' }).click();
  await expect(panel.locator('canvas')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => popup.isClosed()).toBe(true);
});

test('a window says so when its tab or its Session is gone (38)', async ({ page, request }) => {
  needsChrome();
  const { id, panel } = await openPanelOn(page, request, `${origin}/`);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    panel.getByRole('button', { name: 'Open in a window' }).click(),
  ]);
  await expect(popup.locator('canvas')).toBeVisible();
  const tabId = popup.url().split('/').pop();

  // Closing the tab elsewhere ends the window's page.
  await request.delete(api(`/browser/tabs/${tabId}`), { headers: auth });
  await expect(popup.getByText('This tab was closed.')).toBeVisible({ timeout: 10_000 });

  // A link to a tab that never existed, and one to a Session deleted since.
  await popup.goto(`${daemon.url}/browser-window/${id}/no-such-tab`);
  await expect(popup.getByText('This tab was closed.')).toBeVisible();
  await request.delete(api(`/sessions/${id}`), { headers: auth });
  await popup.goto(`${daemon.url}/browser-window/${id}/no-such-tab`);
  await expect(popup.getByText('This Session was deleted.')).toBeVisible();
});

test('the window button waits for a tab, and a blocked popup says so (35)', async ({ page, request }) => {
  needsChrome();
  // A browser that blocks pop-ups answers `window.open` with nothing.
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const id = await newSession(request);
  await page.goto(`${daemon.url}/sessions?session=${id}#token=${daemon.token}`);
  await browserButton(page).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  await expect(panel.getByRole('button', { name: 'Open in a window' })).toBeDisabled();

  await panel.getByRole('textbox', { name: 'Address' }).fill(`${origin}/`);
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(panel.getByRole('tab', { name: /Corners/ })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('button', { name: 'Open in a window' }).click();
  await expect(panel.getByText('The browser blocked the window. Allow pop-ups for this page.')).toBeVisible();
  await expect(panel.locator('canvas')).toBeVisible();
});
