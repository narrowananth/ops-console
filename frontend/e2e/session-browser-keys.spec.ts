import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

/**
 * The operator's keys, clipboard and drops in the streamed page, through the console and a real daemon and Chrome:
 * editing shortcuts, copy to the operator's clipboard, paste, a held key, and a digit that belongs to the page and not to
 * the agent's question.
 */
const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const auth = { Authorization: `Bearer ${daemon.token}` };
const api = (path: string) => `${daemon.url}/api${path}`;

const hasChrome = [
  process.env.OPS_CONSOLE_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].some((candidate) => candidate && existsSync(candidate));

function needsChrome(): void {
  if (hasChrome) return;
  if (process.env.CI) throw new Error('No Google Chrome found: set OPS_CONSOLE_CHROME_PATH or install it.');
  test.skip(true, 'needs Google Chrome');
}

/** A field that writes its value into the title (the tab strip and the canvas name show it), and a drop zone. */
const PAGE = `<!doctype html><title>start</title><style>body { margin: 0 }
#f { position: fixed; left: 20px; top: 20px; width: 360px; height: 40px; font-size: 20px }
#zone { position: fixed; left: 20px; top: 120px; width: 300px; height: 120px; background: #ccc }</style>
<input id="f" aria-label="Field"><div id="zone">drop here</div>
<script>
const f = document.getElementById('f');
const show = () => { document.title = 'v:' + f.value; };
f.addEventListener('input', show);
document.getElementById('zone').addEventListener('dragover', (e) => e.preventDefault());
document.getElementById('zone').addEventListener('drop', (e) => { e.preventDefault(); document.title = 'dropped:' + e.dataTransfer.files[0]?.name; });
</script>`;

let dev: Server;
let origin: string;
test.beforeAll(async () => {
  dev = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(dev.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  dev.closeAllConnections();
  await new Promise((resolve) => dev.close(resolve));
});

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

async function openPage(page: Page, request: APIRequestContext) {
  const session = await newSession(request);
  await request.post(api(`/sessions/${session}/browser/tabs`), { headers: auth, data: { url: origin } });
  await page.goto(`${daemon.url}/workspace?session=${session}#token=${daemon.token}`);
  await page.getByRole('button', { name: /^Browser( :\d+)?$/ }).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  const canvas = panel.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('aria-label', 'start', { timeout: 15_000 });
  return { session, canvas };
}

/** Clicks into the page's field; the stream may not be ready for the first click, so it repeats until the title shows it. */
async function focusField(page: Page, canvas: ReturnType<Page['locator']>) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('nothing is drawn');
  const at = { x: box.x + 100, y: box.y + 40 };
  await expect(async () => {
    await page.mouse.click(at.x, at.y);
    await page.keyboard.type('x');
    await expect(canvas).toHaveAttribute('aria-label', 'v:x', { timeout: 2500 });
  }).toPass({ timeout: 30_000 });
  await page.keyboard.press('Backspace');
  await expect(canvas).toHaveAttribute('aria-label', 'v:', { timeout: 10_000 });
  return at;
}

const title = (canvas: ReturnType<Page['locator']>, value: string) =>
  expect(canvas).toHaveAttribute('aria-label', `v:${value}`, { timeout: 10_000 });

test.describe('keys in the streamed page', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('Backspace, the arrows and the Mac editing shortcuts work, and copy fills the operator’s clipboard', async ({
    page,
    request,
  }) => {
    needsChrome();
    test.setTimeout(120_000);
    const { canvas } = await openPage(page, request);
    await focusField(page, canvas);

    await page.keyboard.type('hello world');
    await title(canvas, 'hello world');
    await page.keyboard.press('Backspace');
    await title(canvas, 'hello worl');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('Z');
    await title(canvas, 'hello worZl');

    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Meta+C');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('hello worZl');

    // Cut takes the selection out of the page and leaves it on the clipboard; undo brings it back.
    await page.keyboard.press('Meta+X');
    await title(canvas, '');
    await page.keyboard.press('Meta+Z');
    await title(canvas, 'hello worZl');
    await page.keyboard.press('Meta+Shift+Z');
    await title(canvas, '');
    await page.keyboard.press('Meta+Z');
    await title(canvas, 'hello worZl');

    // Option+Shift+Left selects the word before the caret; typing replaces it.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await page.keyboard.type('there');
    await title(canvas, 'hello there');
  });

  test('Command+V and Control+V paste the operator’s clipboard', async ({ page, request }) => {
    needsChrome();
    test.setTimeout(120_000);
    const { canvas } = await openPage(page, request);
    await focusField(page, canvas);
    await page.evaluate(() => navigator.clipboard.writeText('from the clipboard'));
    await page.keyboard.press('Meta+V');
    await title(canvas, 'from the clipboard');
    await page.keyboard.press('Control+V');
    await title(canvas, 'from the clipboardfrom the clipboard');
  });

  test('composed text arrives as typed', async ({ page, request }) => {
    needsChrome();
    test.setTimeout(120_000);
    const { canvas } = await openPage(page, request);
    await focusField(page, canvas);
    await page.keyboard.type('a');
    // An input method ends a composition with its text on the console's key target.
    await page.evaluate(() => {
      const target = document.querySelector<HTMLTextAreaElement>('textarea[aria-label$="(keyboard input)"]');
      if (!target) throw new Error('no key target');
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'é😀' }));
    });
    await title(canvas, 'aé😀');
  });

  test('a held key repeats', async ({ page, request }) => {
    needsChrome();
    test.setTimeout(120_000);
    const { canvas } = await openPage(page, request);
    await focusField(page, canvas);
    await page.keyboard.down('q');
    for (let i = 0; i < 4; i += 1) await page.keyboard.down('q');
    await page.keyboard.up('q');
    await expect(canvas).toHaveAttribute('aria-label', 'v:qqqqq', { timeout: 10_000 });
  });

  test('a file dropped on the page reaches its drop zone, and the console stays where it is', async ({
    page,
    request,
  }) => {
    needsChrome();
    test.setTimeout(120_000);
    const { canvas } = await openPage(page, request);
    const box = await canvas.boundingBox();
    if (!box) throw new Error('nothing is drawn');
    const before = page.url();
    const zone = { x: box.x + 150, y: box.y + 180 };
    await expect(async () => {
      await canvas.dispatchEvent('drop', {
        dataTransfer: await page.evaluateHandle(() => {
          const data = new DataTransfer();
          data.items.add(new File(['hi'], 'drop.txt', { type: 'text/plain' }));
          return data;
        }),
        clientX: zone.x,
        clientY: zone.y,
      });
      await expect(canvas).toHaveAttribute('aria-label', 'dropped:drop.txt', { timeout: 3000 });
    }).toPass({ timeout: 30_000 });
    expect(page.url()).toBe(before);
  });
});

test.describe('a number key with the agent asking a question', () => {
  const NOW = '2026-11-03T09:00:00.000Z';
  const QUESTION = {
    id: 'm-question',
    role: 'agent',
    status: 'done',
    created_at: NOW,
    parts: [
      {
        kind: 'question',
        text: 'Which one?',
        header: 'Pick',
        multi_select: false,
        options: [
          { label: 'First', description: '' },
          { label: 'Second', description: '' },
        ],
      },
    ],
  };

  test('goes to the page while it holds the focus, and answers the question once it does not', async ({
    page,
    request,
  }) => {
    needsChrome();
    test.setTimeout(120_000);
    const session = await newSession(request);
    await request.post(api(`/sessions/${session}/browser/tabs`), { headers: auth, data: { url: origin } });
    const sent: unknown[] = [];
    await page.route(new RegExp(`/api/sessions/${session}/messages(\\?.*)?$`), (route) => {
      if (route.request().method() === 'POST') {
        sent.push(route.request().postDataJSON());
        return route.fulfill({ status: 202, json: { data: { id: 'm-sent' } } });
      }
      return route.fulfill({ json: { data: [QUESTION], meta: { next_cursor: null } } });
    });
    // The question panel shows while the Session waits for the operator: the Session reads as waiting.
    type Row = { id: string; state: string };
    const waiting = (row: Row): Row => (row.id === session ? { ...row, state: 'waiting_input' } : row);
    await page.route(new RegExp(`/api/sessions(/${session})?(\\?.*)?$`), async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const body = (await (await route.fetch()).json()) as { data: Row | Row[] };
      const data = Array.isArray(body.data) ? body.data.map(waiting) : waiting(body.data);
      return route.fulfill({ json: { ...body, data } });
    });
    await page.goto(`${daemon.url}/workspace?session=${session}#token=${daemon.token}`);
    await page.getByRole('button', { name: /^Browser( :\d+)?$/ }).click();
    const canvas = page.getByRole('complementary', { name: 'Browser' }).locator('canvas');
    await expect(canvas).toHaveAttribute('aria-label', 'start', { timeout: 15_000 });
    const asks = page.getByRole('region', { name: 'The agent asks' });
    await expect(asks).toBeVisible();

    await focusField(page, canvas);
    await page.keyboard.press('1');
    await title(canvas, '1');
    await expect(asks.getByRole('radio', { name: /First/ })).not.toBeChecked();

    // With the focus off the page, the digit answers the question.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('2');
    await expect(asks.getByRole('radio', { name: /Second/ })).toBeChecked();
  });
});
