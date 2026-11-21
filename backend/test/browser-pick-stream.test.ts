import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type BrowserServerMessage,
  browserServerMessageSchema,
  readFrameHeader,
  type Tab,
  WS_PROTOCOL,
} from '@ops-console/shared';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BrowserModule } from '../src/browser/browser.module';
import { BrowserService } from '../src/browser/browser.service';
import { type AgentDaemon, api, startAgentDaemon, until } from './agent-fixtures';

const chromePath = [
  process.env.OPS_CONSOLE_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  chromium.executablePath(),
].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));

// A login page: a brand block at the top, a tall card, two inputs and a button. `#pulse` keeps frames coming.
const PAGE = `<!doctype html><title>Sign in</title><style>
body { margin: 0; font: 16px sans-serif; background: rgb(240, 250, 240); height: 2600px }
#brand { position: absolute; left: 40px; top: 20px; width: 316px; height: 95px; background: rgb(220, 30, 30) }
#card { position: absolute; left: 40px; top: 140px; width: 316px; height: 900px; background: rgb(255, 255, 255) }
#user { position: absolute; left: 60px; top: 170px; width: 260px } #pw { position: absolute; left: 60px; top: 220px; width: 260px }
#go { position: absolute; left: 60px; top: 270px; width: 260px; height: 40px }
#pulse { position: fixed; right: 4px; top: 4px; width: 20px; height: 20px; background: rgb(0, 0, 200); animation: blink 0.2s steps(2) infinite }
@keyframes blink { to { opacity: 0.4 } }
</style><div id="brand">Acme</div><div id="card"></div>
<input id="user" placeholder="Email"><input id="pw" type="password" placeholder="Password"><button id="go">Sign in</button>
<div id="pulse"></div>`;

let dev: Server;
let decoder: Browser;
const running: AgentDaemon[] = [];

beforeAll(async () => {
  decoder = await chromium.launch({ executablePath: chromePath, headless: true });
});
afterAll(async () => {
  await decoder?.close();
});
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  dev?.closeAllConnections();
  await new Promise<void>((resolve) => (dev ? dev.close(() => resolve()) : resolve()));
});

type Frame = { width: number; height: number; jpeg: Uint8Array; at: number };

async function start(dpr: number) {
  dev = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(dev.address() as AddressInfo).port}`;
  const daemon = await startAgentDaemon({ modules: [BrowserModule.forRoot({ chromePath })] });
  running.push(daemon);
  const http = api(daemon);
  const sessionId = daemon.createSession();
  const created = await http.post(`/sessions/${sessionId}/browser/tabs`, { url: base });
  const tabId = created.body.data.id as string;
  await until(
    async () =>
      ((await http.get(`/sessions/${sessionId}/browser`)).body.data.tabs as Tab[]).find((t) => t.id === tabId),
    (tab) => tab !== undefined && !tab.loading && tab.title !== '',
    'the tab to load',
  );
  const socket = new WebSocket(`${daemon.url.replace('http', 'ws')}/browser/${tabId}`, [WS_PROTOCOL, daemon.token]);
  daemon.sockets.add(socket);
  const messages: BrowserServerMessage[] = [];
  const frames: Frame[] = [];
  socket.on('message', (raw, binary) => {
    if (!binary) return void messages.push(browserServerMessageSchema.parse(JSON.parse(String(raw))));
    const frame = readFrameHeader(Uint8Array.from(raw as Buffer).buffer);
    if (frame) frames.push({ ...frame, jpeg: Uint8Array.from(frame.jpeg), at: Date.now() });
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const send = (message: object) => socket.send(JSON.stringify(message));
  send({ type: 'resize', width: 420, height: 700, dpr });
  const browser = daemon.app.get(BrowserService);
  const page = browser.tab(tabId).page;
  await until(
    async () => page.evaluate('[innerWidth, innerHeight, devicePixelRatio]') as Promise<number[]>,
    (size) => size[0] === 420 && size[1] === 700 && size[2] === dpr,
    'the page to take the viewer size',
  );
  const state = () =>
    page.evaluate('[innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY]') as Promise<number[]>;
  const pick = async (x: number, y: number) => {
    const before = messages.length;
    send({ type: 'pick', action: 'hover', x, y });
    send({ type: 'pick', action: 'click', x, y });
    await until(
      async () => messages.slice(before).find((m) => m.type === 'picked' || m.type === 'pick_failed'),
      (m) => m !== undefined,
      'the pick reply',
    );
  };
  return { send, frames, pick, state, page, dpr };
}

/** Width and height from a JPEG's first start-of-frame marker. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const view = Buffer.from(bytes);
  let at = 2;
  while (at + 9 < view.length) {
    const marker = view[at + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: view.readUInt16BE(at + 5), width: view.readUInt16BE(at + 7) };
    }
    at += 2 + view.readUInt16BE(at + 2);
  }
  throw new Error('no frame header');
}

/** Where the brand block (red) is in a frame, in the frame's own pixels: found by decoding it in a Chrome of the test's. */
async function brandBox(jpeg: Uint8Array): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const page = await decoder.newPage();
  try {
    // The backend has no DOM types, so the decoder's code is a string for the test's Chrome to run.
    const script = `(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(jpeg).toString('base64'))}), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let [x0, y0, x1, y1] = [width, height, -1, -1];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) {
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          }
        }
      }
      return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    })()`;
    return (await page.evaluate(script)) as { x: number; y: number; width: number; height: number } | null;
  } finally {
    await page.close();
  }
}

describe.runIf(chromePath)('the page stream through a run of picks', () => {
  for (const dpr of [2, 1]) {
    it(`keeps every frame at the page's size and scale across eight picks at dpr ${dpr}`, async () => {
      const h = await start(dpr);
      h.send({ type: 'pick', action: 'start' });
      const frameAfter = async (from: number, count: number) => {
        await until(
          async () => h.frames.length - from,
          (n) => n >= count,
          `${count} frames`,
        );
        return h.frames.slice(from, from + count);
      };
      // A baseline of the page before the first pick: where the brand block is.
      const firstFrames = await frameAfter(h.frames.length, 5);
      const baseline = await brandBox(firstFrames.at(-1)?.jpeg ?? new Uint8Array());
      expect(baseline).not.toBeNull();
      const before = await h.state();

      // The brand, the tall card, the inputs, the button, the brand again, and a point scrolled half out of view.
      const points: [number, number][] = [
        [100, 60],
        [200, 400],
        [150, 180],
        [150, 232],
        [150, 290],
        [100, 60],
        [200, 400],
        [150, 180],
      ];
      let index = 0;
      for (const [x, y] of points) {
        index += 1;
        if (index === 7) await h.page.evaluate('window.scrollTo(0, 60)');
        const from = h.frames.length;
        await h.pick(x, y);
        const seen = await frameAfter(from, 10);
        const now = await h.state();
        // The page is as it was (a scroll the test made stays).
        expect(now.slice(0, 3), `pick ${index}: size and pixel ratio`).toEqual(before.slice(0, 3));
        for (const frame of seen) {
          expect({ w: frame.width, h: frame.height }, `pick ${index}: the header says the page's CSS size`).toEqual({
            w: before[0],
            h: before[1],
          });
          const pixels = jpegSize(frame.jpeg);
          expect(pixels, `pick ${index}: the JPEG has the CSS size times the device scale`).toEqual({
            width: (before[0] as number) * dpr,
            height: (before[1] as number) * dpr,
          });
        }
        // No zoom: the brand block sits where it did, in this frame's pixels.
        if (index < 7) {
          const box = await brandBox(seen.at(-1)?.jpeg ?? new Uint8Array());
          expect(box, `pick ${index}: the brand block is in view`).not.toBeNull();
          expect(Math.abs((box?.x ?? 0) - (baseline?.x ?? 0)), `pick ${index}: x`).toBeLessThanOrEqual(3);
          expect(Math.abs((box?.y ?? 0) - (baseline?.y ?? 0)), `pick ${index}: y`).toBeLessThanOrEqual(3);
          expect(Math.abs((box?.width ?? 0) - (baseline?.width ?? 0)), `pick ${index}: width`).toBeLessThanOrEqual(3);
        }
      }
    }, 120_000);
  }
});
