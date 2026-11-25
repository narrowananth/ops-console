import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  type BrowserServerMessage,
  browserServerMessageSchema,
  ErrorCode,
  readFrameHeader,
  SessionKind,
  type Tab,
  WS_PROTOCOL,
} from '@ops-console/shared';
import { type CDPSession, chromium } from 'playwright-core';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { sessionTools } from '../src/agent/session-tools';
import { BrowserModule } from '../src/browser/browser.module';
import { BrowserService } from '../src/browser/browser.service';
import { BrowserToolsService } from '../src/browser/browser-tools.service';
import { ApiError } from '../src/common/errors';
import { type AgentDaemon, api, startAgentDaemon, until } from './agent-fixtures';
import { freePort } from './helpers';

const chromePath = [
  process.env.OPS_CONSOLE_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  chromium.executablePath(),
].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));

// CI runs on macOS runners that have Google Chrome. Without it the real-browser tests would skip and pass, so it fails here.
it.runIf(!chromePath && Boolean(process.env.CI))('finds Google Chrome, so the browser tests run', () => {
  throw new Error('No Google Chrome found: the browser tests would skip. Install it or set OPS_CONSOLE_CHROME_PATH.');
});

const PAGE = `<!doctype html><html><head><title>Dev app</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/icon.png"><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>
<body><h1 id="js">pending</h1><p id="fetch"></p><a id="link" href="/other">Other page</a>
<button id="btn" style="width:200px;height:50px">Press me</button><p id="out"></p>
<input id="field" aria-label="Name"><div style="height:3000px"></div></body></html>`;

const APP_JS = `
document.getElementById('js').textContent = 'ran';
document.getElementById('btn').addEventListener('click', () => { document.getElementById('out').textContent = 'clicked'; });
console.log('hello token=abc123secretvalue');
fetch('http://example.invalid/data').then(() => {}, () => { document.getElementById('fetch').textContent = 'handled'; });`;

/** Two columns that sit at percentages of the window, so a window of another width puts them elsewhere. */
const COLUMNS = `<!doctype html><title>Columns</title><style>
body { margin: 0 } div { position: fixed; top: 0; height: 100vh } #a { left: 10%; width: 30% } #b { left: 60%; width: 30% }
</style><div id="a"></div><div id="b"></div><p id="hit" style="position:fixed;bottom:0"></p>
<script>document.addEventListener('click', (event) => { document.getElementById('hit').textContent = event.target.id || event.target.tagName; });</script>`;

/** A text field, a text area, a paragraph to select, a file field and a drop zone, laid out apart so a drop lands on one. */
const EDITING = `<!doctype html><title>Editing</title><style>
body { margin: 0 } #zone { position: fixed; left: 300px; top: 300px; width: 200px; height: 100px; background: #ccc }
#file { position: fixed; left: 300px; top: 100px; width: 200px; height: 60px }
</style><input id="field"><textarea id="area"></textarea><p id="para">plain page text</p>
<input id="file" type="file"><div id="zone"></div><p id="out"></p>
<script>
const out = document.getElementById('out');
const zone = document.getElementById('zone');
zone.addEventListener('dragover', (e) => e.preventDefault());
zone.addEventListener('drop', (e) => { e.preventDefault(); out.textContent = 'dropped ' + e.dataTransfer.files[0]?.name; });
document.getElementById('file').addEventListener('change', (e) => { out.textContent = 'file ' + e.target.files[0]?.name; });
document.getElementById('field').addEventListener('keydown', (e) => { if (e.repeat) out.textContent = 'repeat ' + e.key; });
</script>`;

/** A page that never stops changing, so the stream sends screencast frames and not only the still of a settled page. */
const SPIN = `<!doctype html><title>Spin</title><style>
div { width: 120px; height: 120px; background: #36c; animation: turn 1s linear infinite } @keyframes turn { to { transform: rotate(360deg) } }
</style><div></div>`;

/** A dev server on a loopback port: a page with CSS and script that calls an outside host, and a few odd routes. */
class DevServer {
  readonly hits: string[] = [];
  private readonly server: Server = createServer((req, res) => {
    this.hits.push(req.url ?? '');
    const send = (type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'content-type': type, ...headers });
      res.end(body);
    };
    switch (req.url) {
      case '/':
        return send('text/html', PAGE);
      case '/app.js':
        return send('text/javascript', APP_JS);
      case '/app.css':
        return send('text/css', 'body { background: rgb(1, 2, 3); }');
      case '/icon.png':
        return send('image/png', 'x');
      case '/other':
        return send('text/html', '<title>Other</title><p>other</p>');
      case '/set':
        return send('text/html', '<title>Cookie set</title>', { 'set-cookie': 'sid=abc; Path=/; Max-Age=3600' });
      case '/redirect':
        res.writeHead(302, { location: 'http://example.invalid/' });
        return res.end();
      case '/upload':
        return send(
          'text/html',
          '<title>Upload</title><input id="f" type="file" multiple><button id="pick" onclick="document.getElementById(\'f\').click()">Pick</button>',
        );
      case '/blank':
        return send('text/html', '<title>Blank</title>');
      case '/columns':
        return send('text/html', COLUMNS);
      case '/spin':
        return send('text/html', SPIN);
      case '/editing':
        return send('text/html', EDITING);
      case '/dialogs':
        return send(
          'text/html',
          '<title>start</title><script>alert("hi"); document.title = confirm("sure?") ? "yes" : "no";</script>',
        );
      case '/download':
        return send('text/html', '<title>Download</title><script>location = "/file.bin";</script>');
      case '/file.bin':
        return send('application/octet-stream', 'bytes', { 'content-disposition': 'attachment; filename="file.bin"' });
      default:
        res.writeHead(404).end();
    }
  });
  port = 0;

  async start(port = 0): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const running: AgentDaemon[] = [];
const servers: DevServer[] = [];

async function devServer(port = 0): Promise<DevServer> {
  const server = await new DevServer().start(port);
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const server of servers.splice(0)) await server.stop();
});

async function start(options: { idleMs?: number; chromePath?: string } = {}) {
  const opened: string[] = [];
  const daemon = await startAgentDaemon({
    modules: [
      BrowserModule.forRoot({
        chromePath: options.chromePath ?? chromePath,
        openExternal: async (url) => {
          opened.push(url);
        },
        ...(options.idleMs ? { idleMs: options.idleMs } : {}),
      }),
    ],
  });
  running.push(daemon);
  return {
    daemon,
    opened,
    http: api(daemon),
    browser: daemon.app.get(BrowserService),
    tools: daemon.app.get(BrowserToolsService),
  };
}

type Harness = Awaited<ReturnType<typeof start>>;

const state = async ({ http }: Harness, sessionId: string): Promise<{ chrome: string; tabs: Tab[] }> =>
  (await http.get(`/sessions/${sessionId}/browser`)).body.data;

async function openTab(h: Harness, sessionId: string, url?: string): Promise<Tab> {
  const created = await h.http.post(`/sessions/${sessionId}/browser/tabs`, url === undefined ? {} : { url });
  expect(created.status).toBe(201);
  return created.body.data;
}

/** The tab once its page has loaded or failed. */
async function settled(
  h: Harness,
  sessionId: string,
  tabId: string,
  done: (tab: Tab) => boolean = () => true,
): Promise<Tab> {
  const tab = await until(
    async () => (await state(h, sessionId)).tabs.find((t) => t.id === tabId),
    (t) => t !== undefined && !t.loading && (t.title !== '' || t.error !== null) && done(t),
    'the tab to settle',
  );
  return tab as Tab;
}

/** Reads a value from the page with the agent's evaluate, as JSON. */
async function read<T>(h: Harness, sessionId: string, tabId: string, script: string): Promise<T> {
  return JSON.parse(
    await h.tools.evaluate(sessionId, `JSON.stringify(${script})`, tabId).then((text) => JSON.parse(text)),
  );
}

async function watch(daemon: AgentDaemon, tabId: string, query = '') {
  const socket = new WebSocket(`${daemon.url.replace('http', 'ws')}/browser/${tabId}${query}`, [
    WS_PROTOCOL,
    daemon.token,
  ]);
  daemon.sockets.add(socket);
  const messages: BrowserServerMessage[] = [];
  const frames: { width: number; height: number; jpeg: Uint8Array }[] = [];
  socket.on('message', (raw, binary) => {
    if (!binary) return void messages.push(browserServerMessageSchema.parse(JSON.parse(String(raw))));
    const bytes = raw as Buffer;
    const frame = readFrameHeader(Uint8Array.from(bytes).buffer);
    if (frame) frames.push(frame);
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, messages, frames, send: (message: object) => socket.send(JSON.stringify(message)) };
}

/** Width and height from a JPEG's first start-of-frame marker. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const view = Buffer.from(bytes);
  let at = 2;
  while (at + 9 < view.length) {
    if (view[at] !== 0xff) throw new Error('not a JPEG marker');
    const marker = view[at + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: view.readUInt16BE(at + 5), width: view.readUInt16BE(at + 7) };
    }
    at += 2 + view.readUInt16BE(at + 2);
  }
  throw new Error('no frame header');
}

/** Counts the commands the daemon sends a tab's Chrome with this name, from now on. */
function countCommands(h: Harness, tabId: string, method: string): () => number {
  const tab = (h.browser as unknown as { byId: Map<string, { cdp: CDPSession }> }).byId.get(tabId);
  if (!tab) throw new Error('no such tab');
  let count = 0;
  const send = tab.cdp.send.bind(tab.cdp) as (name: string, params?: object) => Promise<unknown>;
  (tab.cdp as unknown as { send: typeof send }).send = (name, params) => {
    if (name === method) count += 1;
    return send(name, params);
  };
  return () => count;
}

const chromeRunning = (profile: string): Promise<boolean> =>
  new Promise((resolve) => execFile('pgrep', ['-f', profile], (error) => resolve(!error)));

const rejection = async (work: Promise<unknown>): Promise<ApiError> => {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
};

describe('Session browser without Chrome', () => {
  it('says so and does not offer the agent tools', async () => {
    const h = await start({ chromePath: '/nonexistent' });
    const session = h.daemon.createSession();
    expect((await state(h, session)).chrome).toBe('missing');
    const refused = await h.http.post(`/sessions/${session}/browser/tabs`, {});
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe(ErrorCode.ChromeMissing);
    expect(h.tools.offers(session)).toBe(false);
  });
});

describe('Session browser kinds', () => {
  it('serves repo and anonymous Sessions, and refuses the rest', async () => {
    const h = await start({ chromePath: chromePath ?? '/nonexistent' });
    const review = h.daemon.createSession({ kind: SessionKind.PrReview });
    const refused = await h.http.get(`/sessions/${review}/browser`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe(ErrorCode.BrowserNotAvailable);
    expect((await h.http.get('/sessions/nope/browser')).status).toBe(404);
    expect((await h.http.delete('/browser/tabs/nope')).status).toBe(404);
    expect((await state(h, h.daemon.createSession({ kind: SessionKind.Anonymous }))).tabs).toEqual([]);
    expect(h.tools.offers(review)).toBe(false);
    expect(h.tools.offers(h.daemon.createSession())).toBe(chromePath !== undefined);
  });
});

describe.skipIf(!chromePath)('Session browser in a real Chrome', () => {
  let h: Harness;
  let dev: DevServer;
  let session: string;

  beforeEach(async () => {
    h = await start();
    dev = await devServer();
    session = h.daemon.createSession();
  });

  it('runs the page, settles its state and lists the outside hosts it called', async () => {
    const created = await openTab(h, session, dev.url);
    expect(created.opened_by).toBe('operator');
    const tab = await settled(h, session, created.id, (t) => t.called_hosts.length > 0);
    expect(tab).toMatchObject({ url: `${dev.url}/`, title: 'Dev app', favicon: `${dev.url}/icon.png`, error: null });
    expect(tab.called_hosts).toEqual(['example.invalid']);
    const page = await read<Record<string, string>>(
      h,
      session,
      tab.id,
      `({ js: document.getElementById('js').textContent, bg: getComputedStyle(document.body).backgroundColor })`,
    );
    expect(page).toEqual({ js: 'ran', bg: 'rgb(1, 2, 3)' });
    // The call to the outside host failed on the network, and the page's own handler ran: nothing was blocked or broken.
    await until(
      () => read<string>(h, session, tab.id, `document.getElementById('fetch').textContent`),
      (text) => text === 'handled',
    );
  });

  it('reads a bare port as localhost and refuses other schemes', async () => {
    const created = await openTab(h, session, String(dev.port));
    expect(created.url).toBe(`http://localhost:${dev.port}/`);
    await settled(h, session, created.id);
    const refused = await h.http.post(`/sessions/${session}/browser/tabs`, { url: 'javascript:alert(1)' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe(ErrorCode.UrlNotAllowed);
    expect((await state(h, session)).tabs).toHaveLength(1);
  });

  it('opens any host the operator types', async () => {
    const created = await openTab(h, session, 'https://example.invalid/path');
    expect(created.url).toBe('https://example.invalid/path');
  });

  it('shows a closed port as nothing listening, and loads once something listens', async () => {
    const port = await freePort();
    const created = await openTab(h, session, `127.0.0.1:${port}`);
    const failed = await settled(h, session, created.id);
    expect(failed).toMatchObject({ url: `http://127.0.0.1:${port}/`, error: `Nothing is listening on :${port}` });
    await devServer(port);
    await h.http.patch(`/browser/tabs/${created.id}`, { action: 'reload' });
    expect(await settled(h, session, created.id, (t) => t.error === null)).toMatchObject({ title: 'Dev app' });
  });

  it('goes back, forward and reloads', async () => {
    const created = await openTab(h, session, dev.url);
    await settled(h, session, created.id);
    await h.http.patch(`/browser/tabs/${created.id}`, { url: `${dev.url}/other` });
    const other = await settled(h, session, created.id, (t) => t.title === 'Other');
    expect(other).toMatchObject({ can_back: true, can_forward: false });
    await h.http.patch(`/browser/tabs/${created.id}`, { action: 'back' });
    expect(await settled(h, session, created.id, (t) => t.title === 'Dev app')).toMatchObject({
      url: `${dev.url}/`,
      can_back: false,
      can_forward: true,
    });
    await h.http.patch(`/browser/tabs/${created.id}`, { action: 'forward' });
    await settled(h, session, created.id, (t) => t.title === 'Other');
    const before = dev.hits.filter((hit) => hit === '/other').length;
    await h.http.patch(`/browser/tabs/${created.id}`, { action: 'reload' });
    await until(
      () => dev.hits.filter((hit) => hit === '/other').length,
      (count) => count > before,
      'the reload to reach the server',
    );
  });

  it('gives a window the page opens its own tab', async () => {
    const created = await openTab(h, session, dev.url);
    await settled(h, session, created.id);
    await h.tools.evaluate(session, `window.open('/other') && 1`, created.id);
    const { tabs } = await until(
      () => state(h, session),
      (s) => s.tabs.length === 2 && s.tabs.every((t) => t.title !== ''),
      'the popup tab',
    );
    expect(tabs.map((t) => t.title).sort()).toEqual(['Dev app', 'Other']);
  });

  it('sizes the page to a preset, a custom size and a rotation', async () => {
    const created = await openTab(h, session, dev.url);
    await settled(h, session, created.id);
    const size = () => read<number[]>(h, session, created.id, '[innerWidth, innerHeight, devicePixelRatio]');
    const set = (viewport: object) => h.http.patch(`/browser/tabs/${created.id}`, { viewport });
    const preset = { preset: 'ipad-mini', width: null, height: null, scale: 2, rotated: false };
    expect((await set(preset)).body.data.viewport.preset).toBe('ipad-mini');
    expect(await size()).toEqual([768, 1024, 2]);
    await set({ ...preset, preset: 'iphone-se', scale: 2, rotated: true });
    expect(await size()).toEqual([667, 375, 2]);
    await set({ preset: null, width: 500, height: 400, scale: 1, rotated: false });
    expect(await size()).toEqual([500, 400, 1]);
    const unknown = await set({ ...preset, preset: 'toaster' });
    expect(unknown.status).toBe(400);
  });

  describe("the page's file picker", () => {
    const pick = async (names: Record<string, string>, ids = true) => {
      const { tab_id: tabId } = await h.tools.open(session, `${dev.url}/upload`);
      const { snapshot } = await h.tools.snapshot(session, tabId);
      const ref = /button "Pick"[^\n]*\[ref=(\w+)\]/.exec(snapshot)?.[1] as string;
      await h.tools.click(session, ref, tabId);
      const tab = await settled(h, session, tabId, (t) => t.file_chooser !== null);
      const staged: string[] = [];
      for (const [name, body] of Object.entries(names)) {
        const saved = await request(h.daemon.url)
          .post(`/api/browser/tabs/${tabId}/files?name=${encodeURIComponent(name)}`)
          .set(h.daemon.auth)
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from(body));
        expect(saved.status).toBe(201);
        staged.push(saved.body.data.id);
      }
      return { tabId, tab, staged: ids ? staged : [] };
    };

    it('shows the operator a picker, hands the page the chosen files by their names, and clears the request', async () => {
      const { tabId, tab, staged } = await pick({ 'notes.txt': 'hello', 'a b.csv': 'x,y' });
      expect(tab.file_chooser).toEqual({ multiple: true });
      const chosen = await h.http.post(`/browser/tabs/${tabId}/files/choose`, { ids: staged });
      expect(chosen.status).toBe(204);
      expect(
        await read<string[]>(h, session, tabId, `[...document.getElementById('f').files].map((f) => f.name)`),
      ).toEqual(['notes.txt', 'a b.csv']);
      expect(await read<string>(h, session, tabId, `document.getElementById('f').files[0].size + ''`)).toBe('5');
      expect((await settled(h, session, tabId)).file_chooser).toBeNull();
    });

    it('gives the page no file when the operator cancels, and refuses files nobody asked for', async () => {
      const { tabId } = await pick({});
      expect((await h.http.post(`/browser/tabs/${tabId}/files/choose`, { ids: [] })).status).toBe(204);
      expect(await read<number>(h, session, tabId, `document.getElementById('f').files.length`)).toBe(0);
      const none = await request(h.daemon.url)
        .post(`/api/browser/tabs/${tabId}/files?name=late.txt`)
        .set(h.daemon.auth)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('x'));
      expect(none.status).toBe(409);
    });
  });

  describe('through the stream', () => {
    it('ends on a frame whose declared size is the size it was drawn at, for a still page the viewer resized at once', async () => {
      const created = await openTab(h, session, dev.url);
      await settled(h, session, created.id);
      const viewer = await watch(h.daemon, created.id);
      viewer.send({ type: 'resize', width: 360, height: 514 });
      await until(
        () => read<number[]>(h, session, created.id, '[innerWidth, innerHeight]'),
        (size) => size[0] === 360 && size[1] === 514,
        'the page to take the viewer size',
      );
      // The page is still, so the last frame is the one the panel keeps showing.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const last = viewer.frames.at(-1);
      if (!last) throw new Error('no frame arrived');
      expect({ width: last.width, height: last.height }).toEqual({ width: 360, height: 514 });
      expect(jpegSize(last.jpeg)).toEqual({ width: 360, height: 514 });
    });

    it('takes the first frame at the size its viewer names in the address', async () => {
      const created = await openTab(h, session, dev.url);
      await settled(h, session, created.id);
      const viewer = await watch(h.daemon, created.id, '?w=700&h=500&dpr=2');
      const first = await until(
        () => viewer.frames[0],
        (frame) => frame !== undefined,
        'a frame',
      );
      expect({ page: [first?.width, first?.height], pixels: jpegSize(first?.jpeg ?? new Uint8Array()) }).toEqual({
        page: [700, 500],
        pixels: { width: 1400, height: 1000 },
      });
    });

    it('turns a burst of sizes into a few size changes, and ends at the last size', async () => {
      const created = await openTab(h, session, dev.url);
      await settled(h, session, created.id);
      const viewer = await watch(h.daemon, created.id);
      viewer.send({ type: 'resize', width: 500, height: 400, dpr: 2 });
      await until(
        () => viewer.frames.at(-1),
        (frame) => frame?.width === 500,
        'a frame at the first size',
      );
      const before = viewer.frames.length;
      const sized = countCommands(h, created.id, 'Emulation.setDeviceMetricsOverride');
      // A drag: forty sizes in a row, as fast as the socket takes them.
      for (let step = 1; step <= 40; step += 1) {
        viewer.send({ type: 'resize', width: 500 + step * 8, height: 400 + step * 4, dpr: 2 });
      }
      const last = await until(
        () => viewer.frames.at(-1),
        (frame) => frame?.width === 820 && frame.height === 560,
        'a frame at the last size',
      );
      expect(jpegSize(last?.jpeg ?? new Uint8Array())).toEqual({ width: 1640, height: 1120 });
      // Each size Chrome took waits for the frame it draws, so sizes that came meanwhile count once.
      expect(sized()).toBeLessThan(15);
      // Every frame on the way says the size it was taken at.
      for (const frame of viewer.frames.slice(before)) {
        const pixels = jpegSize(frame.jpeg);
        expect(Math.abs(pixels.width - frame.width * 2)).toBeLessThanOrEqual(Math.max(2, frame.width * 0.04));
      }
    });

    it('draws the page at the pixel ratio its viewer reports, and at 1 when it reports none', async () => {
      const created = await openTab(h, session, `${dev.url}/spin`);
      await settled(h, session, created.id);
      const viewer = await watch(h.daemon, created.id);
      const look = () => read<number[]>(h, session, created.id, '[innerWidth, innerHeight, devicePixelRatio]');
      // The page moves, so what arrives is a run of screencast frames: ten in a row with the expected pixels.
      const frames = (width: number, height: number) =>
        until(
          () =>
            viewer.frames
              .slice(-10)
              .map((frame) => ({ pixels: jpegSize(frame.jpeg), page: [frame.width, frame.height] })),
          (run) => run.length === 10 && run.every(({ pixels }) => pixels.width === width && pixels.height === height),
          `frames of ${width}x${height} pixels`,
        );

      viewer.send({ type: 'resize', width: 780, height: 900 });
      await until(look, (now) => now[0] === 780 && now[1] === 900, 'the page to take the viewer size');
      expect(await look()).toEqual([780, 900, 1]);
      await frames(780, 900);

      // The page keeps its CSS size; its frames carry twice the pixels and say what size the page is.
      viewer.send({ type: 'resize', width: 780, height: 900, dpr: 2 });
      await until(look, (now) => now[2] === 2, 'the page to take the viewer pixel ratio');
      expect(await look()).toEqual([780, 900, 2]);
      const sharp = await frames(1560, 1800);
      expect(sharp.map(({ page }) => page)).toEqual(Array(10).fill([780, 900]));
      // The agent's screenshot stays at the page's CSS size whatever the viewer's screen.
      const shot = await h.tools.screenshot(session, created.id);
      expect(jpegSize(Buffer.from(shot.base64, 'base64'))).toEqual({ width: 780, height: 900 });
    });

    it('sends frames, takes a resize and sends the page its mouse, keys and paste', async () => {
      const created = await openTab(h, session, dev.url);
      await settled(h, session, created.id);
      const viewer = await watch(h.daemon, created.id);
      const [first] = await until(
        () => viewer.frames,
        (frames) => frames.length > 0,
        'a frame',
      );
      expect(
        Buffer.from(first?.jpeg ?? [])
          .subarray(0, 2)
          .toString('hex'),
      ).toBe('ffd8');

      viewer.send({ type: 'resize', width: 900, height: 700 });
      await until(
        () => read<number[]>(h, session, created.id, '[innerWidth, innerHeight]'),
        (size) => size[0] === 900 && size[1] === 700,
        'the page to take the viewer size',
      );
      // A person clicks after seeing the page at its new size. Chrome drops a click that comes before the page's first
      // frame at that size.
      await until(
        () => viewer.frames.at(-1),
        (frame) => frame?.width === 900 && frame.height === 700,
        'a frame at the viewer size',
      );

      const at = async (id: string) => {
        const box = await read<{ x: number; y: number; width: number; height: number }>(
          h,
          session,
          created.id,
          `document.getElementById('${id}').getBoundingClientRect().toJSON()`,
        );
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      const click = (point: { x: number; y: number }) => {
        viewer.send({ type: 'mouse', action: 'move', ...point });
        viewer.send({ type: 'mouse', action: 'down', button: 'left', click_count: 1, ...point });
        viewer.send({ type: 'mouse', action: 'up', button: 'left', click_count: 1, ...point });
      };
      click(await at('btn'));
      await until(
        () => read<string>(h, session, created.id, `document.getElementById('out').textContent`),
        (text) => text === 'clicked',
        'the click to reach the button',
      );

      click(await at('field'));
      for (const key of ['a', 'b']) {
        viewer.send({ type: 'key', action: 'down', key, code: `Key${key.toUpperCase()}`, text: key });
        viewer.send({ type: 'key', action: 'up', key, code: `Key${key.toUpperCase()}` });
      }
      viewer.send({ type: 'text', text: 'cd' });
      viewer.send({ not: 'a message' });
      await until(
        () => read<string>(h, session, created.id, `document.getElementById('field').value`),
        (value) => value === 'abcd',
        'the typing to reach the field',
      );
    });

    describe('editing keys, clipboard, composition and drops', () => {
      const META = 4;
      const SHIFT = 8;
      const ALT = 1;

      async function editing() {
        const created = await openTab(h, session, `${dev.url}/editing`);
        await settled(h, session, created.id);
        const viewer = await watch(h.daemon, created.id);
        const page = <T>(script: string) => read<T>(h, session, created.id, script);
        const focus = (id: string) => h.tools.evaluate(session, `document.getElementById('${id}').focus()`, created.id);
        const press = (key: string, modifiers: number, commands: string[], extra: object = {}) => {
          const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
          viewer.send({ type: 'key', action: 'down', key, code, modifiers, commands, ...extra });
          viewer.send({ type: 'key', action: 'up', key, code, modifiers });
        };
        const field = () =>
          page<[string, number, number]>(
            `(() => { const f = document.getElementById('field'); return [f.value, f.selectionStart, f.selectionEnd]; })()`,
          );
        const clipboards = () =>
          viewer.messages.flatMap((message) => (message.type === 'clipboard' ? [message.text] : []));
        const out = () => page<string>(`document.getElementById('out').textContent`);
        return { created, viewer, page, focus, press, field, clipboards, out };
      }

      it('selects all and copies the selection to the viewer, from a field and from the page', async () => {
        const t = await editing();
        await t.focus('field');
        t.viewer.send({ type: 'text', text: 'hello brave world' });
        await until(t.field, ([value]) => value === 'hello brave world', 'the text to reach the field');
        t.press('a', META, ['selectAll']);
        await until(t.field, ([, from, to]) => from === 0 && to === 17, 'the field to be selected');
        t.press('c', META, ['copy']);
        await until(t.clipboards, (copied) => copied.length > 0, 'the copy to reach the viewer');
        expect(t.clipboards()).toEqual(['hello brave world']);

        // With no field focused the page's own selection is what Copy takes.
        await t.page(`(document.activeElement.blur(), getSelection().removeAllRanges(), true)`);
        t.press('a', META, ['selectAll']);
        t.press('c', META, ['copy']);
        await until(t.clipboards, (copied) => copied.length > 1, 'the page copy to reach the viewer');
        expect(t.clipboards()[1]).toContain('plain page text');
      });

      it('cuts to the viewer, undoes the cut and redoes it', async () => {
        const t = await editing();
        await t.focus('field');
        t.viewer.send({ type: 'text', text: 'one two' });
        await until(t.field, ([value]) => value === 'one two', 'the text to reach the field');
        t.press('a', META, ['selectAll']);
        t.press('x', META, ['cut']);
        await until(t.field, ([value]) => value === '', 'the cut to empty the field');
        await until(t.clipboards, (copied) => copied.length > 0, 'the cut text to reach the viewer');
        expect(t.clipboards()).toEqual(['one two']);
        t.press('z', META, ['undo']);
        await until(t.field, ([value]) => value === 'one two', 'undo to restore the text');
        t.press('z', META | SHIFT, ['redo']);
        await until(t.field, ([value]) => value === '', 'redo to cut again');
      });

      it('moves by word and by line, and selects with Shift', async () => {
        const t = await editing();
        await t.focus('field');
        t.viewer.send({ type: 'text', text: 'hello brave world' });
        await until(t.field, ([value]) => value === 'hello brave world', 'the text to reach the field');
        t.press('ArrowLeft', ALT | SHIFT, ['moveWordLeftAndModifySelection']);
        await until(t.field, ([, from, to]) => from === 12 && to === 17, 'Option+Shift+Left to select a word');
        t.press('ArrowLeft', META, ['moveToLeftEndOfLine']);
        await until(t.field, ([, from, to]) => from === 0 && to === 0, 'Command+Left to reach the start');
        t.press('ArrowRight', ALT, ['moveWordRight']);
        await until(t.field, ([, from]) => from === 5, 'Option+Right to move a word');
        t.press('ArrowRight', META | SHIFT, ['moveToRightEndOfLineAndModifySelection']);
        await until(t.field, ([, from, to]) => from === 5 && to === 17, 'Command+Shift+Right to select to the end');
        t.press('Backspace', ALT, ['deleteWordBackward']);
        await until(t.field, ([value]) => value === 'hello', 'Option+Backspace to delete the selection');
      });

      it('repeats a held key', async () => {
        const t = await editing();
        await t.focus('field');
        t.viewer.send({ type: 'key', action: 'down', key: 'q', code: 'KeyQ', text: 'q', modifiers: 0 });
        t.viewer.send({ type: 'key', action: 'down', key: 'q', code: 'KeyQ', text: 'q', modifiers: 0, repeat: true });
        t.viewer.send({ type: 'key', action: 'down', key: 'q', code: 'KeyQ', text: 'q', modifiers: 0, repeat: true });
        t.viewer.send({ type: 'key', action: 'up', key: 'q', code: 'KeyQ', modifiers: 0 });
        await until(t.field, ([value]) => value === 'qqq', 'three presses');
        expect(await t.out()).toBe('repeat q');
      });

      it('pastes text, takes composed text, and keeps the old text and key messages valid', async () => {
        const t = await editing();
        await t.focus('field');
        t.viewer.send({ type: 'paste', text: 'pasted ' });
        t.viewer.send({ type: 'compose', text: 'é' });
        t.viewer.send({ type: 'compose', text: '😀' });
        t.viewer.send({ type: 'text', text: ' plain' });
        t.viewer.send({ type: 'key', action: 'down', key: 'Shift', code: 'ShiftLeft', modifiers: 8 });
        await until(t.field, ([value]) => value === 'pasted é😀 plain', 'the text to arrive in order');
        t.viewer.send({ type: 'compose', text: 'x'.repeat(2000) });
        t.viewer.send({ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: 0, commands: ['bad name!'] });
        t.viewer.send({ type: 'text', text: '.' });
        await until(
          t.field,
          ([value]) => value === 'pasted é😀 plain.',
          'a bad message to be dropped and the next one taken',
        );
      });

      it('gives a pasted file to the focused file field and ignores it otherwise', async () => {
        const t = await editing();
        const file = { name: 'note.txt', type: 'text/plain', data: Buffer.from('hi').toString('base64') };
        await t.focus('field');
        t.viewer.send({ type: 'paste', files: [file] });
        await t.focus('file');
        t.viewer.send({ type: 'paste', files: [file] });
        await until(t.out, (text) => text === 'file note.txt', 'the file to reach the file field');
        expect(await t.page(`document.getElementById('field').value`)).toBe('');
        expect(await t.page(`document.getElementById('file').files.length`)).toBe(1);
      });

      it('takes a file dropped on a zone or a file field, and the page does not navigate', async () => {
        const t = await editing();
        const file = { name: 'drop.txt', type: 'text/plain', data: Buffer.from('hi').toString('base64') };
        t.viewer.send({ type: 'resize', width: 800, height: 600 });
        await until(
          () => t.page<number[]>('[innerWidth, innerHeight]'),
          (size) => size[0] === 800 && size[1] === 600,
          'the page to take the viewer size',
        );
        t.viewer.send({ type: 'paste', files: [file], x: 400, y: 350 });
        await until(t.out, (text) => text === 'dropped drop.txt', 'the drop to reach the zone');
        t.viewer.send({ type: 'paste', files: [file], x: 400, y: 130 });
        await until(t.out, (text) => text === 'file drop.txt', 'the drop to fill the file field');
        // A drop on nothing is the page's: it stays where it was.
        t.viewer.send({ type: 'paste', files: [file], x: 20, y: 550 });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect((await settled(h, session, t.created.id)).url).toBe(`${dev.url}/editing`);
      });
    });

    it('sends the first click of a viewer that takes over to the page it was shown, then gives the page its size', async () => {
      const created = await openTab(h, session, `${dev.url}/columns`);
      await settled(h, session, created.id);
      const size = () => read<number[]>(h, session, created.id, '[innerWidth, innerHeight]');
      const first = await watch(h.daemon, created.id);
      first.send({ type: 'resize', width: 900, height: 700 });
      await until(size, (now) => now[0] === 900 && now[1] === 700, 'the page to take the first viewer size');
      // The second viewer is shown the 900 px page, so its click on the right column is aimed at x = 675.
      const second = await watch(h.daemon, created.id);
      second.send({ type: 'resize', width: 600, height: 600 });
      const at = { x: 675, y: 350 };
      second.send({ type: 'mouse', action: 'move', ...at });
      // A hand takes a moment to go from hovering to pressing.
      await new Promise((resolve) => setTimeout(resolve, 400));
      second.send({ type: 'mouse', action: 'down', button: 'left', click_count: 1, ...at });
      second.send({ type: 'mouse', action: 'up', button: 'left', click_count: 1, ...at });
      await until(
        () => read<string>(h, session, created.id, `document.getElementById('hit').textContent`),
        (hit) => hit !== '',
        'the click to reach the page',
      );
      expect(await read<string>(h, session, created.id, `document.getElementById('hit').textContent`)).toBe('b');
      await until(size, (now) => now[0] === 600 && now[1] === 600, 'the page to take the second viewer size');
    });

    it('scrolls at once under a swipe of 150 wheel events, and a click after them still lands', async () => {
      const created = await openTab(h, session, dev.url);
      await settled(h, session, created.id);
      const viewer = await watch(h.daemon, created.id);
      viewer.send({ type: 'resize', width: 900, height: 700 });
      await until(
        () => read<number[]>(h, session, created.id, '[innerWidth, innerHeight]'),
        (size) => size[0] === 900 && size[1] === 700,
        'the page to take the viewer size',
      );
      const point = { x: 450, y: 300 };
      const started = Date.now();
      for (let i = 0; i < 150; i++) {
        viewer.send({ type: 'mouse', action: 'wheel', ...point, delta_x: 0, delta_y: 10 });
      }
      // The swipe adds up to 1,500 px. Each wheel waiting for a frame took about 17 ms, so this took over 2.5 s.
      await until(
        () => read<number>(h, session, created.id, 'Math.round(scrollY)'),
        (y) => y >= 1500,
        'the page to scroll to the end of the swipe',
      );
      expect(Date.now() - started).toBeLessThan(2000);
      // The press and release are sent after the wheel events and wait for each other.
      const box = await read<{ x: number; y: number; width: number; height: number }>(
        h,
        session,
        created.id,
        `(() => { window.scrollTo(0, 0); return document.getElementById('btn').getBoundingClientRect().toJSON(); })()`,
      );
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      viewer.send({ type: 'mouse', action: 'down', button: 'left', click_count: 1, ...at });
      viewer.send({ type: 'mouse', action: 'up', button: 'left', click_count: 1, ...at });
      await until(
        () => read<string>(h, session, created.id, `document.getElementById('out').textContent`),
        (text) => text === 'clicked',
        'the click to reach the button',
      );
    });

    it('closes the stream when the tab closes, and refuses an unknown tab', async () => {
      const created = await openTab(h, session, dev.url);
      await settled(h, session, created.id);
      const viewer = await watch(h.daemon, created.id);
      await h.http.delete(`/browser/tabs/${created.id}`);
      await until(
        () => viewer.messages,
        (messages) => messages.some((m) => m.type === 'closed'),
        'the closed message',
      );
      const rejected = new WebSocket(`${h.daemon.url.replace('http', 'ws')}/browser/nope`, [
        WS_PROTOCOL,
        h.daemon.token,
      ]);
      rejected.on('error', () => {});
      const status = await new Promise((resolve) =>
        rejected.once('unexpected-response', (_req, res) => resolve(res.statusCode)),
      );
      rejected.terminate();
      expect(status).toBe(404);
    });

    it('reports a dialog, declines a confirm and refuses a download', async () => {
      const created = await openTab(h, session);
      const viewer = await watch(h.daemon, created.id);
      await h.http.patch(`/browser/tabs/${created.id}`, { url: `${dev.url}/dialogs` });
      await settled(h, session, created.id, (t) => t.title === 'no');
      const kinds = () => viewer.messages.flatMap((m) => (m.type === 'dialog' ? [m.kind] : []));
      expect(kinds()).toEqual(['alert', 'confirm']);
      await h.http.patch(`/browser/tabs/${created.id}`, { url: `${dev.url}/download` });
      await until(kinds, (all) => all.includes('download'), 'the download notice');
      const notice = viewer.messages.find((m) => m.type === 'dialog' && m.kind === 'download');
      expect(notice).toMatchObject({ message: 'Download refused: file.bin' });
      expect(await settled(h, session, created.id)).toMatchObject({ error: null });
    });
  });

  describe('cookies and the Chrome behind a Session', () => {
    const profile = (id: string) => path.join(h.daemon.dataDir, 'browser', id);
    const cookie = async (id: string, tab: Tab) => read<string>(h, id, tab.id, 'document.cookie');

    it('keeps each Session its own, and keeps its Chrome for the next tab when the last one closes', async () => {
      const other = h.daemon.createSession();
      const a = await openTab(h, session, `${dev.url}/set`);
      const b = await openTab(h, other, `${dev.url}/blank`);
      await settled(h, session, a.id);
      await settled(h, other, b.id);
      expect(await cookie(session, a)).toBe('sid=abc');
      expect(await cookie(other, b)).toBe('');
      expect(await chromeRunning(profile(session))).toBe(true);

      expect((await h.http.delete(`/browser/tabs/${a.id}`)).status).toBe(204);
      await until(
        async () => (await state(h, session)).tabs,
        (tabs) => tabs.length === 0,
        'the tab to close',
      );
      expect(await chromeRunning(profile(session))).toBe(true);

      const again = await openTab(h, session, `${dev.url}/blank`);
      await settled(h, session, again.id);
      expect(await cookie(session, again)).toBe('sid=abc');
      expect(await chromeRunning(profile(other))).toBe(true);
    });

    it('keeps the cookies through the idle exit of Chrome', async () => {
      const idle = await start({ idleMs: 1500 });
      const sessionId = idle.daemon.createSession();
      const first = await openTab(idle, sessionId, `${dev.url}/set`);
      await settled(idle, sessionId, first.id);
      expect((await idle.http.delete(`/browser/tabs/${first.id}`)).status).toBe(204);
      const folder = path.join(idle.daemon.dataDir, 'browser', sessionId);
      await until(
        () => chromeRunning(folder),
        (running) => !running,
        'Chrome to exit',
      );
      const again = await openTab(idle, sessionId, `${dev.url}/blank`);
      await settled(idle, sessionId, again.id);
      expect(await read<string>(idle, sessionId, again.id, 'document.cookie')).toBe('sid=abc');
    });

    it('wipes them on clear, and with the Session', async () => {
      const a = await openTab(h, session, `${dev.url}/set`);
      await settled(h, session, a.id);
      expect((await h.http.post(`/sessions/${session}/browser/clear`)).status).toBe(204);
      expect((await state(h, session)).tabs).toEqual([]);
      expect(existsSync(profile(session))).toBe(false);
      const again = await openTab(h, session, `${dev.url}/blank`);
      await settled(h, session, again.id);
      expect(await cookie(session, again)).toBe('');

      expect((await h.http.delete(`/sessions/${session}`)).status).toBe(204);
      await until(
        () => existsSync(profile(session)),
        (exists) => !exists,
        'the profile folder to go',
      );
      expect(h.browser.known(again.id)).toBe(false);
      expect(await chromeRunning(profile(session))).toBe(false);
    });

    it('marks tabs when Chrome dies, and starts a new Chrome for the next tab', async () => {
      const created = await openTab(h, session, dev.url);
      await settled(h, session, created.id);
      await new Promise((resolve) => execFile('pkill', ['-f', profile(session)], resolve));
      const dead = await until(
        async () => (await state(h, session)).tabs,
        (tabs) => tabs.length === 1 && /Chrome stopped/.test(tabs[0]?.error ?? ''),
        'the tab to show Chrome stopped',
      );
      expect(dead[0]?.error).toMatch(/Chrome stopped/);
      expect((await h.http.patch(`/browser/tabs/${created.id}`, { action: 'reload' })).status).toBe(409);
      const next = await openTab(h, session, dev.url);
      expect(await settled(h, session, next.id)).toMatchObject({ title: 'Dev app' });
    });
  });

  it('opens the tab address in the operator browser, and refuses a blank tab', async () => {
    const blank = await openTab(h, session);
    const refused = await h.http.post(`/browser/tabs/${blank.id}/external`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe(ErrorCode.NothingLoaded);
    const loaded = await openTab(h, session, dev.url);
    await settled(h, session, loaded.id);
    expect((await h.http.post(`/browser/tabs/${loaded.id}/external`)).status).toBe(204);
    expect(h.opened).toEqual([`${dev.url}/`]);
  });

  describe('the agent tools', () => {
    it('open loopback pages only, in a tab tagged agent', async () => {
      for (const url of [
        'https://example.com/',
        'file:///etc/passwd',
        'http://localhost:4545/',
        'http://[::1]:4556/',
      ]) {
        const refused = await rejection(h.tools.open(session, url));
        expect([refused.status, refused.code]).toEqual([422, ErrorCode.UrlNotAllowed]);
      }
      expect((await state(h, session)).tabs).toEqual([]);

      const opened = await h.tools.open(session, `${dev.url}/`);
      expect(opened).toMatchObject({ url: `${dev.url}/`, title: 'Dev app', error: null });
      const again = await h.tools.open(session, `${dev.url}/other`);
      expect(again.tab_id).toBe(opened.tab_id);
      const { tabs } = await state(h, session);
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({ opened_by: 'agent', title: 'Other' });

      const port = await freePort();
      expect(await h.tools.open(session, `http://127.0.0.1:${port}/`)).toMatchObject({
        error: `Nothing is listening on :${port}`,
      });
    });

    it('refuse a tab the operator moved off loopback', async () => {
      const opened = await h.tools.open(session, `${dev.url}/`);
      await h.http.patch(`/browser/tabs/${opened.tab_id}`, { url: 'https://example.invalid/' });
      for (const call of [
        h.tools.snapshot(session, opened.tab_id),
        h.tools.evaluate(session, '1', opened.tab_id),
        h.tools.open(session, `${dev.url}/`, opened.tab_id),
      ]) {
        const refused = await rejection(call);
        expect([refused.status, refused.code]).toEqual([422, ErrorCode.UrlNotAllowed]);
        expect(refused.message).toBe('This tab is on example.invalid. Agent tools work on loopback pages.');
      }
      const fresh = await h.tools.open(session, `${dev.url}/`);
      expect(fresh.tab_id).not.toBe(opened.tab_id);
    });

    it('read the page as a tree with refs, and click, type and press by ref', async () => {
      const { tab_id: tabId } = await h.tools.open(session, `${dev.url}/`);
      const { snapshot } = await h.tools.snapshot(session, tabId);
      const ref = (role: string, name: string) =>
        new RegExp(`${role} "${name}"[^\\n]*\\[ref=(\\w+)\\]`).exec(snapshot)?.[1] as string;
      expect(ref('button', 'Press me')).toBeTruthy();

      await h.tools.click(session, ref('button', 'Press me'), tabId);
      expect(await read(h, session, tabId, `document.getElementById('out').textContent`)).toBe('clicked');
      await h.tools.type(session, ref('textbox', 'Name'), 'hello', false, tabId);
      expect(await read(h, session, tabId, `document.getElementById('field').value`)).toBe('hello');
      await h.tools.press(session, 'Tab', tabId);
      await h.tools.scroll(session, 0, 400, tabId);
      await until(
        () => read<number>(h, session, tabId, 'window.scrollY'),
        (y) => y > 0,
        'the page to scroll',
      );
      await h.tools.click(session, ref('link', 'Other page'), tabId);
      await until(
        async () => (await state(h, session)).tabs[0]?.title,
        (title) => title === 'Other',
        'the link to load',
      );
      const bad = await rejection(h.tools.click(session, 'not a ref!', tabId));
      expect(bad.status).toBe(400);
    });

    it('take a screenshot, cap a script result and keep redacted console and network logs', async () => {
      const { tab_id: tabId } = await h.tools.open(session, `${dev.url}/`);
      const shot = await h.tools.screenshot(session, tabId);
      expect(shot.mimeType).toBe('image/jpeg');
      expect(Buffer.from(shot.base64, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');

      const long = await h.tools.evaluate(session, '"x".repeat(200000)', tabId);
      expect(long.length).toBeLessThan(100_100);
      expect(long.endsWith('[truncated]')).toBe(true);

      const logs = await until(
        () => h.tools.consoleEntries(session, 50, tabId),
        (entries) => entries.length > 0,
        'the console entry',
      );
      expect(logs).toContainEqual({ type: 'log', text: 'hello token=[redacted]' });
      const network = await until(
        () => h.tools.networkEntries(session, 50, tabId),
        (entries) => entries.some((e) => e.url.includes('example.invalid')),
        'the outside request',
      );
      expect(network).toContainEqual({ method: 'GET', url: `${dev.url}/app.js`, status: 200 });
      expect(network).toContainEqual({ method: 'GET', url: 'http://example.invalid/data', status: null });
      expect(await h.tools.consoleEntries(session, 1, tabId)).toHaveLength(1);
    });

    it('show the operator the tab is in use while a call runs', async () => {
      const { tab_id: tabId } = await h.tools.open(session, `${dev.url}/`);
      const call = h.tools.evaluate(session, 'new Promise((resolve) => setTimeout(() => resolve(1), 1500))', tabId);
      await until(
        async () => (await state(h, session)).tabs[0]?.agent_active,
        (active) => active === true,
        'the tab to show the agent',
      );
      expect(await call).toBe('1');
      expect((await state(h, session)).tabs[0]?.agent_active).toBe(false);
    });

    it('describe an evaluate for the Approval', () => {
      expect(h.tools.describeEvaluate('document.title')).toContain('document.title');
    });
  });
});

describe.skipIf(!chromePath)('Session browser idle', () => {
  it('closes a Chrome nobody watches, and keeps one a viewer holds open', async () => {
    const h = await start({ idleMs: 1500 });
    const dev = await devServer();
    const session = h.daemon.createSession();
    const profile = path.join(h.daemon.dataDir, 'browser', session);
    const watched = await openTab(h, session, `${dev.url}/blank`);
    const viewer = await watch(h.daemon, watched.id);
    await settled(h, session, watched.id);
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect((await state(h, session)).tabs).toHaveLength(1);
    expect(await chromeRunning(profile)).toBe(true);

    viewer.socket.close();
    await until(
      async () => (await state(h, session)).tabs,
      (tabs) => tabs.length === 0,
      'the idle close',
    );
    await until(
      () => chromeRunning(profile),
      (running) => !running,
      'Chrome to exit',
    );
    expect(existsSync(profile)).toBe(true);
  });
});

describe.skipIf(!chromePath)('the browser tools as the agent calls them (21, 22, 24)', () => {
  it('opens a loopback page, reads it, clicks by ref, and refuses an outside address in the tool result', async () => {
    const dev = await devServer();
    const h = await start();
    const sessionId = h.daemon.createSession();
    type Handler = (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<{
      content: { type: string; text?: string; data?: string }[];
      isError?: boolean;
    }>;
    const byName = new Map(
      sessionTools(h.tools, null, sessionId).map((entry) => [entry.name, entry.handler as unknown as Handler]),
    );
    const call = (name: string, args: Record<string, unknown> = {}) => {
      const handler = byName.get(name);
      if (!handler) throw new Error(`no tool ${name}`);
      return handler(args, {});
    };

    const opened = await call('browser_open', { url: `${dev.url}/` });
    expect(opened.isError).toBeUndefined();
    expect(opened.content[0]?.text).toContain('Dev app');

    const snapshot = await call('browser_snapshot');
    const { snapshot: tree } = JSON.parse(snapshot.content[0]?.text ?? '{}') as { snapshot: string };
    const ref = /button "Press me"[^\n]*\[ref=(\w+)\]/.exec(tree)?.[1];
    expect(ref).toBeDefined();
    await call('browser_click', { ref });
    expect(
      JSON.parse(
        String(
          (await call('browser_evaluate', { script: "document.getElementById('out').textContent" })).content[0]?.text,
        ),
      ),
    ).toBe('clicked');

    const shot = await call('browser_screenshot');
    expect(shot.content[0]).toMatchObject({ type: 'image' });

    // A loopback page that sends the tab off loopback is refused, and the tab is left blank.
    const redirected = await call('browser_open', { url: `${dev.url}/redirect` });
    expect(redirected.isError).toBe(true);
    expect(redirected.content[0]?.text).toContain('This tab is on example.invalid');
    await until(
      async () => (await state(h, sessionId)).tabs[0]?.url,
      (url) => url === '',
      'the refused tab to go blank',
    );

    const refused = await call('browser_open', { url: 'https://example.com/' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/only http or https pages on localhost/);
  });
});
