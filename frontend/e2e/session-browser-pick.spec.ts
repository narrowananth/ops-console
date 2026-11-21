import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const auth = { Authorization: `Bearer ${daemon.token}` };
const api = (path: string) => `${daemon.url}/api${path}`;

const hasChrome = [
  process.env.OPS_CONSOLE_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].some((candidate) => candidate && existsSync(candidate));

// Set PICK_SHOTS to a folder to keep screenshots of the toolbar, pick mode and the composer chip.
const shots = process.env.PICK_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const shoot = async (target: Locator | Page, name: string) => {
  if (shots) await target.screenshot({ path: `${shots}/${name}.png` });
};

// A sign-in button that counts its clicks in the title, a field with a typed password, and a link.
const PAGE = `<!doctype html><title>Pick page</title><style>
body { margin: 0; font: 16px sans-serif; background: rgb(250, 250, 252) }
#sign-in { position: fixed; left: 20px; top: 20px; width: 260px; height: 80px; font-size: 20px; background: rgb(230, 230, 240) }
#pw { position: fixed; left: 20px; top: 140px; width: 260px }
#docs { position: fixed; left: 20px; top: 200px }
</style>
<button id="sign-in" onclick="document.title = 'clicked'">Sign in</button>
<input id="pw" type="password" value="hunter2-password" aria-label="Password">
<a id="docs" href="/docs">Read the docs</a>`;

function needsChrome(): void {
  if (hasChrome) return;
  if (process.env.CI) throw new Error('No Google Chrome found: set OPS_CONSOLE_CHROME_PATH or install it.');
  test.skip(true, 'needs Google Chrome');
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

const browserButton = (page: Page) => page.getByRole('button', { name: /^Browser( :\d+)?$/ });

async function openPanel(page: Page, request: APIRequestContext) {
  const id = await newSession(request);
  await page.goto(`${daemon.url}/workspace?session=${id}#token=${daemon.token}`);
  await browserButton(page).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  await panel.getByRole('textbox', { name: 'Address' }).fill(origin);
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(panel.getByRole('tab', { name: /Pick page/ })).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('canvas')).toBeVisible();
  return { id, panel };
}

/** A point on the drawn page, in the page's own coordinates (the Fill page is drawn 1:1). */
async function onPage(canvas: Locator, x: number, y: number) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('the page is not drawn');
  return { x: box.x + x, y: box.y + y };
}

/**
 * Turns pick mode on, moves to the point until Chrome's outline shows in the canvas (pick mode is on in the daemon by
 * then), and clicks.
 */
async function pickAt(page: Page, panel: Locator, x: number, y: number) {
  const canvas = panel.locator('canvas');
  const quiet = await canvas.screenshot();
  await panel.getByRole('button', { name: 'Pick an element' }).click();
  const at = await onPage(canvas, x, y);
  await expect(async () => {
    await page.mouse.move(at.x + 1, at.y);
    await page.mouse.move(at.x, at.y);
    expect((await canvas.screenshot()).equals(quiet)).toBe(false);
  }).toPass({ timeout: 15_000 });
  return async () => page.mouse.click(at.x, at.y);
}

test.describe('the toolbar', () => {
  test('has an icon for each action, no word, no "..." menu and no link setting (3, 13)', async ({ page, request }) => {
    needsChrome();
    // Wide enough for the panel to keep its default width.
    await page.setViewportSize({ width: 1800, height: 900 });
    const { panel } = await openPanel(page, request);

    for (const name of [
      'Back',
      'Forward',
      'Reload',
      'Open in a window',
      'Pick an element',
      'Inspect',
      'Open in your browser',
      "Clear this Session's cookies",
    ]) {
      await expect(panel.getByRole('button', { name, exact: true })).toBeVisible();
    }
    // The external button is an icon: its name is its tooltip, and no word sits beside it.
    const external = panel.getByRole('button', { name: 'Open in your browser' });
    await expect(external).toHaveAttribute('title', 'Open in your browser');
    await expect(external).toHaveText('');
    await expect(panel.getByRole('button', { name: "Clear this Session's cookies" })).toHaveText('');
    await expect(panel.getByRole('button', { name: 'Browser menu' })).toHaveCount(0);
    await expect(panel.getByText('Open links')).toHaveCount(0);
    await expect(panel.getByText('In the external browser')).toHaveCount(0);
    await expect(panel.getByText('External', { exact: true })).toHaveCount(0);

    // With the room, the address field and every button sit on one row.
    const row = async (name: string) => (await panel.getByRole('button', { name, exact: true }).boundingBox())?.y ?? -1;
    const address = (await panel.getByRole('textbox', { name: 'Address' }).boundingBox())?.y ?? -2;
    expect(Math.abs((await row('Open in your browser')) - address)).toBeLessThan(10);
    await shoot(panel.locator('div.border-b').first(), 'toolbar-panel');

    // Clearing the cookies still asks first: Cancel sends nothing, Clear does.
    const clearCall = (request: { url(): string; method(): string }) =>
      request.method() === 'POST' && request.url().endsWith('/browser/clear');
    let cleared = 0;
    page.on('request', (call) => {
      if (clearCall(call)) cleared += 1;
    });
    await panel.getByRole('button', { name: "Clear this Session's cookies" }).click();
    const confirm = page.getByRole('alertdialog', { name: "Clear this Session's cookies?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    expect(cleared).toBe(0);
    await panel.getByRole('button', { name: "Clear this Session's cookies" }).click();
    const done = page.waitForResponse((response) => clearCall(response.request()));
    await confirm.getByRole('button', { name: 'Clear' }).click();
    expect((await done).status()).toBe(204);
  });

  test('keeps every button in a narrow panel and gives the address field the room that is left (3)', async ({
    page,
    request,
  }) => {
    needsChrome();
    // The narrowest the panel goes.
    await page.addInitScript(() => localStorage.setItem('ops-console:workspace.session-browser-width', '360'));
    const { panel } = await openPanel(page, request);
    const bar = panel.getByRole('textbox', { name: 'Address' });
    const area = await panel.boundingBox();
    if (!area) throw new Error('no panel');
    expect(area.width).toBeLessThan(400);
    for (const name of [
      'Open in a window',
      'Pick an element',
      'Inspect',
      'Open in your browser',
      "Clear this Session's cookies",
    ]) {
      const box = await panel.getByRole('button', { name, exact: true }).boundingBox();
      expect(box, name).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(area.x + area.width);
    }
    expect((await bar.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(120);
    await shoot(panel.locator('div.border-b').first(), 'toolbar-panel-narrow');
  });

  test('a loopback link in the conversation opens in the panel, with no setting to say otherwise (13)', async ({
    page,
    request,
  }) => {
    needsChrome();
    await page.route(/\/api\/sessions\/[^/]+\/messages$/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const agent = {
        id: 'm1',
        role: 'agent',
        status: 'done',
        parts: [{ kind: 'text', text: `Open [the app](${origin}/) to see it.` }],
        created_at: new Date().toISOString(),
      };
      return route.fulfill({ json: { data: [agent] } });
    });
    const id = await newSession(request);
    await page.goto(`${daemon.url}/workspace?session=${id}#token=${daemon.token}`);
    await page.getByRole('link', { name: 'the app' }).click();
    await expect(
      page.getByRole('complementary', { name: 'Browser' }).getByRole('tab', { name: /Pick page/ }),
    ).toBeVisible({ timeout: 30_000 });
    expect(page.context().pages()).toHaveLength(1);
  });
});

test.describe('picking an element', () => {
  test('highlights what is under the pointer, adds a chip with the crop to the message and does not click the page (pick)', async ({
    page,
    request,
  }) => {
    needsChrome();
    const { panel } = await openPanel(page, request);
    const canvas = panel.locator('canvas');
    const pick = panel.getByRole('button', { name: 'Pick an element' });
    await expect(pick).toHaveAttribute('aria-pressed', 'false');

    // Chrome draws the outline into the page, and the frames carry it to the canvas.
    const click = await pickAt(page, panel, 100, 60);
    await expect(pick).toHaveAttribute('aria-pressed', 'true');
    await shoot(panel, 'pick-mode-highlight');

    await click();
    const chips = page.getByRole('list', { name: 'Picked elements' });
    await expect(chips.getByText('button#sign-in: Sign in')).toBeVisible({ timeout: 15_000 });
    await expect(chips.locator('img')).toBeVisible();
    // Pick mode ends with the pick, the page saw no click, and the message box has the focus.
    await expect(pick).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused();
    // The tab's title follows the page within two seconds: a click that reached the page would have shown by now.
    await page.waitForTimeout(2500);
    await expect(panel.getByRole('tab', { name: 'Pick page' })).toBeVisible();
    await shoot(
      page.getByRole('textbox', { name: 'Message' }).locator('xpath=ancestor::div[contains(@class,"rounded-3xl")]'),
      'composer-chip',
    );

    // Several picks in a row make several chips; one is taken out with its x.
    await (await pickAt(page, panel, 40, 210))();
    await expect(chips.getByText('a#docs: Read the docs')).toBeVisible({ timeout: 15_000 });
    await expect(chips.getByRole('listitem')).toHaveCount(2);
    await chips.getByRole('button', { name: 'Remove a#docs: Read the docs' }).click();
    await expect(chips.getByRole('listitem')).toHaveCount(1);

    // The page still takes clicks once pick mode is off.
    const button = await onPage(canvas, 100, 60);
    await page.mouse.click(button.x, button.y);
    await expect(panel.getByRole('tab', { name: 'clicked' })).toBeVisible({ timeout: 15_000 });
  });

  test('sends the element in a delimited block with its crop attached, and nothing the operator typed into the page (pick)', async ({
    page,
    request,
  }) => {
    needsChrome();
    const sent: string[] = [];
    await page.route(/\/api\/sessions\/[^/]+\/messages$/, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      sent.push((route.request().postDataJSON() as { text: string }).text);
      return route.fulfill({ status: 201, json: { data: { message_id: 'sent' } } });
    });
    const { panel } = await openPanel(page, request);
    await (await pickAt(page, panel, 100, 60))();
    const chips = page.getByRole('list', { name: 'Picked elements' });
    await expect(chips.getByText('button#sign-in: Sign in')).toBeVisible({ timeout: 15_000 });

    // The password field is picked too: its chip has no image, and no value is anywhere.
    await (await pickAt(page, panel, 100, 150))();
    await expect(chips.getByRole('listitem')).toHaveCount(2, { timeout: 15_000 });
    await expect(chips.getByRole('listitem').nth(1).locator('img')).toHaveCount(0);

    const message = page.getByRole('textbox', { name: 'Message' });
    await message.fill('make this button blue');
    // The crop is uploaded before Send.
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 15_000 });
    await message.press('Enter');
    await expect.poll(() => sent.length).toBe(1);

    const text = sent[0] ?? '';
    expect(text).toMatch(
      /^make this button blue\n\n<picked-element page="http:\/\/127\.0\.0\.1:\d+\/" selector="#sign-in" image="button#sign-in: Sign in\.jpg">/,
    );
    expect(text).toContain('text: Sign in');
    expect(text).toContain('<button id="sign-in"');
    expect(text).toContain('background-color: rgb(230, 230, 240)');
    expect(text).toContain('</picked-element>');
    expect(text).toContain('selector="#pw"');
    expect(text).toMatch(/Attached files \(open each with the Read tool\):\n- button#sign-in: Sign in\.jpg: \//);
    expect(text).not.toContain('hunter2');
    // Sent: the chips are gone.
    await expect(chips).toHaveCount(0);
  });

  test('Escape leaves pick mode, and the page takes clicks again (pick)', async ({ page, request }) => {
    needsChrome();
    const { panel } = await openPanel(page, request);
    const canvas = panel.locator('canvas');
    const pick = panel.getByRole('button', { name: 'Pick an element' });
    await pick.click();
    await expect(pick).toHaveAttribute('aria-pressed', 'true');
    const button = await onPage(canvas, 100, 60);
    await page.mouse.move(button.x, button.y);
    await page.keyboard.press('Escape');
    await expect(pick).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('list', { name: 'Picked elements' })).toHaveCount(0);

    await expect(async () => {
      await page.mouse.click(button.x, button.y);
      await expect(panel.getByRole('tab', { name: 'clicked' })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
  });

  test("a tab's own window picks too, and the element lands in the console's message box (pick)", async ({
    page,
    request,
  }) => {
    needsChrome();
    const { panel } = await openPanel(page, request);
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      panel.getByRole('button', { name: 'Open in a window' }).click(),
    ]);
    const canvas = popup.locator('canvas');
    await expect(canvas).toBeVisible();
    await shoot(popup.locator('div.border-b').first(), 'toolbar-window');

    const pick = popup.getByRole('button', { name: 'Pick an element' });
    await pick.click();
    await expect(pick).toHaveAttribute('aria-pressed', 'true');
    const button = await onPage(canvas, 100, 60);
    await popup.mouse.move(button.x, button.y);
    await popup.mouse.click(button.x, button.y);
    await expect(popup.getByRole('status').filter({ hasText: 'Added to the message box in the console.' })).toBeVisible(
      {
        timeout: 15_000,
      },
    );
    await expect(pick).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('list', { name: 'Picked elements' }).getByText('button#sign-in: Sign in')).toBeVisible({
      timeout: 15_000,
    });
    // The window has the icons and no menu.
    await expect(popup.getByRole('button', { name: 'Open in your browser' })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Browser menu' })).toHaveCount(0);
  });
});
