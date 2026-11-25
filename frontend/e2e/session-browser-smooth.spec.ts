import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type APIRequestContext, chromium, expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';
import { type Draw, installProbe, LabServer, type ProbeData, summary } from './smooth-lab';

/**
 * Measures how the streamed page feels at a pixel ratio of 2: the time from an input to the canvas showing it, what the
 * canvas shows while the panel or a window is resized, and what it shows on first paint. `OC_SMOOTH_OUT` names a file for
 * the numbers. The asserts count frames and messages; they carry no latency bound that a slow runner would break.
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

const TRIALS = Number(process.env.OC_SMOOTH_TRIALS ?? 50);
const lab = new LabServer();
test.beforeAll(() => lab.start());
test.afterAll(() => lab.stop());

// `OC_SMOOTH_VIEWPORT=2560x1440` measures a big screen, where a frame has several times the pixels.
const [viewW = 1500, viewH = 900] = (process.env.OC_SMOOTH_VIEWPORT ?? '').split('x').map(Number);
test.use({ deviceScaleFactor: 2, viewport: { width: viewW || 1500, height: viewH || 900 } });
test.beforeEach(({ context }) => context.addInitScript(installProbe));

const made: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(api(`/sessions/${id}`), { headers: auth });
});

/** Each test adds its numbers to the file, so a failed test does not lose the others. */
const results = {
  set(key: string, value: unknown): void {
    const out = process.env.OC_SMOOTH_OUT;
    const all = out && existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>) : {};
    all[key] = value;
    if (out) writeFileSync(out, JSON.stringify(all, null, 2));
    console.log(`RESULT ${key} ${JSON.stringify(value)}`);
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function newSession(request: APIRequestContext): Promise<string> {
  const response = await request.post(api('/sessions'), { headers: auth, data: { kind: 'anonymous' } });
  const id = ((await response.json()) as { data: { id: string } }).data.id;
  made.push(id);
  return id;
}

/** Tabs made in the daemon before the console looks at them, each on the lab page under its own title. */
async function tabsOf(request: APIRequestContext, session: string, titles: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const created = await request.post(api(`/sessions/${session}/browser/tabs`), {
      headers: auth,
      data: { url: `${lab.origin}/?title=${title}` },
    });
    ids.push(((await created.json()) as { data: { id: string } }).data.id);
  }
  await expect
    .poll(
      async () => {
        const state = await request.get(api(`/sessions/${session}/browser`), { headers: auth });
        const { tabs } = ((await state.json()) as { data: { tabs: { title: string; loading: boolean }[] } }).data;
        return tabs.filter((tab) => titles.includes(tab.title) && !tab.loading).length;
      },
      { timeout: 30_000 },
    )
    .toBe(titles.length);
  return ids;
}

const browserButton = (page: Page) => page.getByRole('button', { name: /^Browser( :\d+)?$/ });

async function openConsole(page: Page, session: string) {
  await page.goto(`${daemon.url}/sessions?session=${session}#token=${daemon.token}`);
}

/** The probe's records since the last call. */
async function take(page: Page): Promise<ProbeData> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __probe: ProbeData }).__probe;
    const copy = JSON.parse(JSON.stringify(probe)) as ProbeData;
    probe.draws.length = 0;
    probe.events.length = 0;
    probe.frames.length = 0;
    probe.sent.length = 0;
    probe.ticks.length = 0;
    return copy;
  });
}

async function panelWithPage(page: Page, request: APIRequestContext, titles = ['Lab']) {
  const session = await newSession(request);
  const tabs = await tabsOf(request, session, titles);
  await openConsole(page, session);
  await browserButton(page).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  const canvas = panel.locator('canvas');
  await expect(canvas).toBeVisible();
  await settled(page);
  return { session, tabs, panel, canvas };
}

/** Waits until the canvas shows a frame of the stage's size and no frame has come for a while. */
async function settled(page: Page, quiet = 500): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((wait) => {
          const probe = (window as unknown as { __probe: ProbeData }).__probe;
          const last = probe.draws.at(-1);
          if (!last) return false;
          return last.fits && performance.now() - last.t > wait;
        }, quiet),
      { timeout: 30_000, intervals: [100] },
    )
    .toBe(true);
}

const centre = (box: { x: number; y: number; width: number; height: number }, fx = 0.5, fy = 0.5) => ({
  x: box.x + box.width * fx,
  y: box.y + box.height * fy,
});

/** Milliseconds from `from` to the first draw at or after it that `shows` accepts, or null. */
function paintedAfter(draws: Draw[], from: number, shows: (draw: Draw) => boolean): number | null {
  const hit = draws.find((draw) => draw.t >= from && shows(draw));
  return hit ? hit.t - from : null;
}

const known = (values: (number | null)[]): number[] => values.filter((value): value is number => value !== null);

/** Time the canvas showed what these ticks say, in ms: each tick counts the gap to the next. */
function durationOf(
  ticks: ProbeData['ticks'],
  from: number,
  to: number,
  when: (tick: ProbeData['ticks'][number]) => boolean,
) {
  let total = 0;
  for (let i = 0; i + 1 < ticks.length; i += 1) {
    const tick = ticks[i];
    const next = ticks[i + 1];
    if (!tick || !next || tick.t < from || tick.t > to) continue;
    if (when(tick)) total += Math.min(100, next.t - tick.t);
  }
  return Math.round(total);
}

test('hover shows on the canvas (a)', async ({ page, request }) => {
  needsChrome();
  test.setTimeout(180_000);
  const { canvas } = await panelWithPage(page, request);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('nothing is drawn');
  const on = centre(box);
  const off = centre(box, 0.1, 0.3);
  await page.mouse.move(off.x, off.y);
  await settled(page);
  await take(page);
  const latencies: (number | null)[] = [];
  for (let i = 0; i < TRIALS; i += 1) {
    const hover = i % 2 === 0;
    const target = hover ? on : off;
    await page.mouse.move(target.x, target.y);
    await page
      .waitForFunction(
        (want) => {
          const draw = (window as unknown as { __probe: ProbeData }).__probe.draws.at(-1);
          return draw !== undefined && draw.hover >= 0 && draw.hover < 100 === want;
        },
        hover,
        { polling: 'raf', timeout: 5000 },
      )
      .catch(() => {});
    await sleep(120);
    const data = await take(page);
    const moved = data.events.find((event) => event.type === 'mousemove');
    latencies.push(
      moved ? paintedAfter(data.draws, moved.t, (draw) => draw.hover >= 0 && draw.hover < 100 === hover) : null,
    );
  }
  results.set('hover', { ms: summary(known(latencies)), missed: latencies.filter((value) => value === null).length });
  // A bound a loaded runner keeps: Chrome itself answers in about 20 ms.
  expect(known(latencies).length).toBeGreaterThan(TRIALS * 0.9);
  expect(Math.max(...known(latencies))).toBeLessThan(1000);
});

test('typing shows on the canvas (b)', async ({ page, request }) => {
  needsChrome();
  test.setTimeout(180_000);
  const { canvas } = await panelWithPage(page, request);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('nothing is drawn');
  const field = centre(box, 0.5, 0.72);
  await page.mouse.click(field.x, field.y);
  await sleep(300);
  await take(page);
  const latencies: (number | null)[] = [];
  const text = 'the quick brown fox jumps over';
  for (let i = 0; i < text.length; i += 1) {
    await page.keyboard.press(text[i] === ' ' ? 'Space' : (text[i] as string));
    await page
      .waitForFunction(
        (want) => (window as unknown as { __probe: ProbeData }).__probe.draws.at(-1)?.code === want,
        i + 1,
        { polling: 'raf', timeout: 5000 },
      )
      .catch(() => {});
    await sleep(70);
  }
  const data = await take(page);
  const downs = data.events.filter((event) => event.type === 'keydown');
  for (const [i, down] of downs.entries())
    latencies.push(paintedAfter(data.draws, down.t, (draw) => draw.code === i + 1));
  results.set('typing', { ms: summary(known(latencies)), missed: latencies.filter((value) => value === null).length });
  expect(known(latencies).length).toBeGreaterThan(text.length * 0.9);
  expect(Math.max(...known(latencies))).toBeLessThan(1000);
});

test('scrolling a tall page with a wheel stream (e)', async ({ page, request }) => {
  needsChrome();
  test.setTimeout(180_000);
  const { canvas } = await panelWithPage(page, request);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('nothing is drawn');
  const at = centre(box, 0.2, 0.5);
  await page.mouse.move(at.x, at.y);
  await settled(page);
  const trials: { lastPainted: number | null; behind: number | null }[] = [];
  for (let swipe = 0; swipe < 4; swipe += 1) {
    await take(page);
    // A trackpad swipe: about 120 events, quick at first and then dying away, 8 ms apart.
    const started = Date.now();
    for (let i = 0; i < 120; i += 1) {
      await page.mouse.wheel(0, Math.round(70 * Math.exp(-i / 40) + 2) * (swipe % 2 === 0 ? 1 : -1));
      await sleep(Math.max(0, 8 - ((Date.now() - started) % 8)));
    }
    await sleep(1200);
    const data = await take(page);
    const wheels = data.events.filter((event) => event.type === 'wheel');
    const first = wheels[0];
    const last = wheels.at(-1);
    const final = data.draws.at(-1);
    if (!first || !last || !final) continue;
    trials.push({
      lastPainted: paintedAfter(data.draws, last.t, (draw) => draw.code === final.code),
      behind: paintedAfter(data.draws, first.t, (draw) => draw.code === final.code),
    });
  }
  results.set('scroll', {
    afterLastWheelMs: summary(known(trials.map((trial) => trial.lastPainted))),
    afterFirstWheelMs: summary(known(trials.map((trial) => trial.behind))),
  });
  expect(trials.length).toBeGreaterThan(2);
  expect(Math.max(...known(trials.map((trial) => trial.lastPainted)))).toBeLessThan(1500);
});

type Storm = {
  /** Resize messages the console sent, and how many of them while the drag was still going. */
  resizesSent: number;
  resizesDuring: number;
  /** Frames painted, and how many of them while the drag was still going. */
  draws: number;
  drawsDuring: number;
  /** Frames painted at a size that was not the stage's at that moment. */
  staleDraws: number;
  /** Milliseconds the canvas showed a frame that was not the stage's size, and one stretched out of its own shape. */
  staleMs: number;
  stretchedMs: number;
  /** The most the canvas was out of its frame's shape, as a fraction: 0.1 is a page 10 % too wide or too tall. */
  maxStretch: number;
  blankMs: number;
  /** Milliseconds from the end of the drag until the canvas last showed a frame that was not the stage's size. */
  rightAfterMs: number;
  finalFits: boolean;
};

/** What the canvas showed from `start` until the page held still after a resize storm that ended at `end`. */
function describeStorm(data: ProbeData, start: number, end: number): Storm {
  const during = data.draws.filter((draw) => draw.t >= start);
  const last = data.ticks.at(-1)?.t ?? end;
  const misfit = data.ticks.filter((tick) => tick.t >= start && tick.drawn && !tick.fits).at(-1);
  return {
    resizesSent: data.sent.length,
    resizesDuring: data.sent.filter((sent) => sent.t <= end).length,
    draws: during.length,
    drawsDuring: during.filter((draw) => draw.t <= end).length,
    staleDraws: during.filter((draw) => !draw.fits).length,
    staleMs: durationOf(data.ticks, start, last, (tick) => tick.drawn && !tick.fits),
    stretchedMs: durationOf(data.ticks, start, last, (tick) => tick.drawn && tick.stretch > 0.02),
    maxStretch:
      Math.round(Math.max(0, ...data.ticks.filter((tick) => tick.t >= start).map((tick) => tick.stretch)) * 1000) /
      1000,
    blankMs: durationOf(data.ticks, start, last, (tick) => tick.has && tick.blank),
    rightAfterMs: misfit ? Math.max(0, Math.round(misfit.t - end)) : 0,
    finalFits: during.at(-1)?.fits ?? false,
  };
}

/** The page follows a drag instead of waiting it out, and is never drawn far out of shape. */
function expectFollowed(storms: Storm[]): void {
  for (const storm of storms) {
    expect(storm.finalFits).toBe(true);
    // Sizes go to the daemon while the drag goes on, and its frames come back before it ends.
    expect(storm.resizesDuring).toBeGreaterThanOrEqual(3);
    expect(storm.drawsDuring).toBeGreaterThanOrEqual(2);
    // A frame that has not caught up with the stage is at most a few steps behind it, not the whole drag.
    expect(storm.maxStretch).toBeLessThan(0.2);
    expect(storm.blankMs).toBe(0);
  }
}

test('dragging the splitter of the panel (c)', async ({ page, request }) => {
  needsChrome();
  test.setTimeout(180_000);
  await panelWithPage(page, request);
  const handle = page.getByRole('separator', { name: 'Resize the browser' });
  const storms: Storm[] = [];
  // The panel starts at its widest, so it narrows first, by 200 px, and then widens by as much.
  for (const direction of [-1, 1]) {
    const box = await handle.boundingBox();
    if (!box) throw new Error('no splitter');
    const from = centre(box);
    await take(page);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    const start = await page.evaluate(() => performance.now());
    for (let step = 1; step <= 40; step += 1) {
      await page.mouse.move(from.x - direction * step * 5, from.y);
      await sleep(16);
    }
    const end = await page.evaluate(() => performance.now());
    await page.mouse.up();
    await settled(page, 700);
    storms.push(describeStorm(await take(page), start, end));
  }
  results.set('panelDrag', storms);
  expectFollowed(storms);
});

test('resizing the window of a tab (c)', async ({ page, request }) => {
  needsChrome();
  test.setTimeout(180_000);
  const { panel } = await panelWithPage(page, request);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    panel.getByRole('button', { name: 'Open in a window' }).click(),
  ]);
  await popup.setViewportSize({ width: 1280, height: 860 });
  await expect(popup.locator('canvas')).toBeVisible();
  await settled(popup, 700);
  await sleep(500);
  const storms: Storm[] = [];
  for (const [w, h] of [
    [900, 600],
    [1280, 860],
  ] as const) {
    const [w0, h0] = w === 900 ? [1280, 860] : [900, 600];
    await take(popup);
    const start = await popup.evaluate(() => performance.now());
    for (let step = 1; step <= 40; step += 1) {
      await popup.setViewportSize({
        width: Math.round(w0 + ((w - w0) * step) / 40),
        height: Math.round(h0 + ((h - h0) * step) / 40),
      });
      await sleep(16);
    }
    const end = await popup.evaluate(() => performance.now());
    await settled(popup, 700);
    const data = await take(popup);
    storms.push(describeStorm(data, start, end));
  }
  results.set('windowDrag', storms);
  expectFollowed(storms);
});

type First = { toFrameMs: number | null; toFittedMs: number | null; blankMs: number; sawBlank: boolean };

function describeFirst(data: ProbeData, from: number): First {
  const ticks = data.ticks.filter((tick) => tick.t >= from);
  const upto = ticks.at(-1)?.t ?? from;
  const toFrame = paintedAfter(data.draws, from, () => true);
  const toFitted = paintedAfter(data.draws, from, (draw) => draw.fits);
  return {
    toFrameMs: toFrame === null ? null : Math.round(toFrame),
    toFittedMs: toFitted === null ? null : Math.round(toFitted),
    blankMs: durationOf(data.ticks, from, upto, (tick) => tick.has && tick.blank),
    sawBlank: ticks.some((tick) => tick.has && tick.blank),
  };
}

test('first paint of the panel, a window and a switched tab (d)', async ({ page, request }) => {
  needsChrome();
  test.setTimeout(180_000);
  const session = await newSession(request);
  await tabsOf(request, session, ['Alpha', 'Beta']);
  await openConsole(page, session);
  await expect(browserButton(page)).toBeVisible();
  await sleep(500);
  await take(page);
  const opening: First[] = [];
  for (let i = 0; i < 5; i += 1) {
    await browserButton(page).click();
    const panel = page.getByRole('complementary', { name: 'Browser' });
    await expect(panel.locator('canvas')).toBeVisible();
    await settled(page, 300);
    const data = await take(page);
    const click = data.events.find((event) => event.type === 'click');
    opening.push(describeFirst(data, click?.t ?? 0));
    await panel.getByRole('button', { name: 'Close the browser' }).click();
    await page.getByRole('button', { name: 'Session', exact: true }).click();
    await sleep(300);
    await take(page);
  }

  await browserButton(page).click();
  const panel = page.getByRole('complementary', { name: 'Browser' });
  await expect(panel.locator('canvas')).toBeVisible();
  await settled(page, 300);
  const switching: First[] = [];
  for (let i = 0; i < 10; i += 1) {
    await take(page);
    await panel.getByRole('tab', { name: i % 2 === 0 ? 'Beta' : 'Alpha' }).click();
    await settled(page, 300);
    const data = await take(page);
    const click = data.events.find((event) => event.type === 'click');
    switching.push(describeFirst(data, click?.t ?? 0));
  }

  const windows: First[] = [];
  for (let i = 0; i < 3; i += 1) {
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      panel.getByRole('button', { name: 'Open in a window' }).click(),
    ]);
    await expect(popup.locator('canvas')).toBeVisible();
    await settled(popup, 300);
    const data = await take(popup);
    windows.push(describeFirst(data, 0));
    await popup.close();
    await expect(panel.locator('canvas')).toBeVisible({ timeout: 10_000 });
    await settled(page, 300);
    await take(page);
  }
  const part = (list: First[]) => ({
    toFrameMs: summary(known(list.map((one) => one.toFrameMs))),
    toFittedMs: summary(known(list.map((one) => one.toFittedMs))),
    blankMs: summary(list.map((one) => one.blankMs)),
    runsThatShowedBlank: list.filter((one) => one.sawBlank).length,
    runs: list.length,
  });
  results.set('firstPaint', { openPanel: part(opening), switchTab: part(switching), openWindow: part(windows) });
  // Never a blank canvas on the way in, and the first frame is already the stage's size: not a default size that the
  // daemon then redraws.
  for (const run of [...opening, ...switching, ...windows]) expect(run.sawBlank).toBe(false);
  for (const run of [...opening, ...switching]) expect(run.toFittedMs).toBe(run.toFrameMs);
});

/** What plain Chrome gives over CDP with nothing of ours in between, for the same page at the same scale. */
test('baseline: the same page in plain Chrome over CDP', async ({ browser }) => {
  test.skip(!process.env.OC_SMOOTH_BASELINE, 'a measurement for comparison: set OC_SMOOTH_BASELINE=1');
  needsChrome();
  test.setTimeout(180_000);
  const raw = await chromium.launch({ args: ['--force-device-scale-factor=2'] });
  const probePage = await (await browser.newContext()).newPage();
  try {
    const context = await raw.newContext({ viewport: { width: 640, height: 800 }, deviceScaleFactor: 2 });
    const target = await context.newPage();
    await target.goto(`${lab.origin}/`);
    const cdp = await context.newCDPSession(target);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 640,
      height: 800,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const frames: { t: number; data: string }[] = [];
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      frames.push({ t: performance.now(), data });
      void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: 1280,
      maxHeight: 1600,
      everyNthFrame: 1,
    });
    await sleep(500);

    const decode = async (list: { t: number; data: string }[]) =>
      probePage.evaluate(
        async (jpegs) => {
          const out: { code: number; hover: number }[] = [];
          for (const base64 of jpegs) {
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error('no canvas');
            ctx.drawImage(bitmap, 0, 0);
            const row = ctx.getImageData(0, Math.floor(canvas.height * 0.03), canvas.width, 1).data;
            let code = 0;
            for (let i = 0; i < 16; i += 1) {
              const x = Math.min(canvas.width - 1, Math.floor((canvas.width * (i * 3 + 1.5)) / 100));
              const luma = (row[x * 4] ?? 0) * 0.3 + (row[x * 4 + 1] ?? 0) * 0.59 + (row[x * 4 + 2] ?? 0) * 0.11;
              if (luma < 128) code |= 1 << i;
            }
            const h = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
            out.push({ code, hover: (h[0] ?? 0) * 0.3 + (h[1] ?? 0) * 0.59 + (h[2] ?? 0) * 0.11 });
          }
          return out;
        },
        list.map((frame) => frame.data),
      );

    const hover: (number | null)[] = [];
    for (let i = 0; i < TRIALS; i += 1) {
      const isOn = i % 2 === 0;
      frames.length = 0;
      const t0 = performance.now();
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: isOn ? 320 : 64, y: isOn ? 400 : 240 });
      await sleep(250);
      const decoded = await decode(frames.slice());
      const at = decoded.findIndex((one) => one.hover < 100 === isOn);
      hover.push(at < 0 ? null : (frames[at]?.t ?? t0) - t0);
    }

    await target.mouse.click(320, 576);
    await sleep(300);
    const typing: (number | null)[] = [];
    for (let i = 0; i < 30; i += 1) {
      frames.length = 0;
      const t0 = performance.now();
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        text: 'a',
        windowsVirtualKeyCode: 65,
      });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await sleep(200);
      const decoded = await decode(frames.slice());
      const at = decoded.findIndex((one) => one.code === i + 1);
      typing.push(at < 0 ? null : (frames[at]?.t ?? t0) - t0);
    }

    const scroll: (number | null)[] = [];
    for (let swipe = 0; swipe < 6; swipe += 1) {
      frames.length = 0;
      const started = performance.now();
      let lastWheel = started;
      for (let i = 0; i < 120; i += 1) {
        const sign = swipe % 2 === 0 ? 1 : -1;
        void cdp
          .send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: 128,
            y: 400,
            deltaX: 0,
            deltaY: sign * Math.round(70 * Math.exp(-i / 40) + 2),
          })
          .catch(() => {});
        lastWheel = performance.now();
        await sleep(8);
      }
      await sleep(1500);
      const decoded = await decode(frames.slice());
      const final = decoded.at(-1)?.code;
      const at = decoded.findIndex((one) => one.code === final);
      scroll.push(at < 0 ? null : Math.max(0, (frames[at]?.t ?? lastWheel) - lastWheel));
    }
    results.set('baselineCdp', {
      hoverMs: summary(known(hover)),
      typingMs: summary(known(typing)),
      scrollAfterLastWheelMs: summary(known(scroll)),
    });
  } finally {
    await raw.close();
  }
});
