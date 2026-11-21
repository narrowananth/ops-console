import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type BrowserServerMessage,
  browserServerMessageSchema,
  type ElementCapture,
  readFrameHeader,
  type Tab,
  WS_PROTOCOL,
} from '@ops-console/shared';
import { chromium } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BrowserModule } from '../src/browser/browser.module';
import { BrowserService } from '../src/browser/browser.service';
import { type AgentDaemon, api, startAgentDaemon, until } from './agent-fixtures';

const chromePath = [
  process.env.OPS_CONSOLE_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  chromium.executablePath(),
].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));

// Without Chrome the real-browser tests would skip and pass; CI has it, so there a missing Chrome fails here.
it.runIf(!chromePath && Boolean(process.env.CI))('finds Google Chrome, so the pick tests run', () => {
  throw new Error('No Google Chrome found: the pick tests would skip. Install it or set OPS_CONSOLE_CHROME_PATH.');
});

const PAGE = `<!doctype html><html><head><title>Pick me</title><style>
body { margin: 0; font: 16px sans-serif } #card { position: absolute; left: 40px; top: 60px; width: 300px; padding: 10px; background: rgb(240, 240, 250) }
#buy { display: block; width: 200px; height: 44px; color: rgb(10, 20, 30); background-color: rgb(200, 220, 255); font-size: 18px }
#login { padding: 20px }
#big { position: absolute; left: 0; top: 300px; width: 1600px; height: 1400px; background: rgb(250, 240, 230) }
</style></head><body>
<div id="card"><button id="buy" data-testid="buy-now" class="cta primary" onclick="document.title = 'clicked'">Buy now</button>
<a id="docs" href="/docs?token=abcdef1234567890abcd">Read the docs</a>
<form id="login"><input id="user" name="user" placeholder="Email" value="dave@example.com"><input id="pw" type="password" name="pw" value="hunter2-password">
<textarea id="note">a private note</textarea><div id="rich" contenteditable="true">draft in progress</div></form></div>
<div id="big">tall block</div>
<script>
document.cookie = 'session=cookie-value-9999; Path=/';
localStorage.setItem('stored', 'storage-value-8888');
document.getElementById('user').value = 'typed-in-value-7777';
document.getElementById('note').value = 'typed-note-6666';
</script></body></html>`;

let dev: Server;
const running: AgentDaemon[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  dev?.closeAllConnections();
  await new Promise<void>((resolve) => (dev ? dev.close(() => resolve()) : resolve()));
});

async function start() {
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
  const frames: { width: number; height: number }[] = [];
  socket.on('message', (raw, binary) => {
    if (!binary) return void messages.push(browserServerMessageSchema.parse(JSON.parse(String(raw))));
    const frame = readFrameHeader(Uint8Array.from(raw as Buffer).buffer);
    if (frame) frames.push(frame);
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  await until(
    async () => frames.length,
    (count) => count > 0,
    'the first frame',
  );
  const browser = daemon.app.get(BrowserService);
  const send = (message: object) => socket.send(JSON.stringify(message));
  /** The page as the agent's screenshot sees it, highlight included. */
  const shot = () => browser.tab(tabId).capture();
  /** A pick click, and what came back: the capture or the refusal. */
  const pick = async (x: number, y: number) => {
    const before = messages.length;
    send({ type: 'pick', action: 'click', x, y });
    const reply = await until(
      async () => messages.slice(before).find((m) => m.type === 'picked' || m.type === 'pick_failed'),
      (m) => m !== undefined,
      'the pick reply',
    );
    return reply as Extract<BrowserServerMessage, { type: 'picked' | 'pick_failed' }>;
  };
  const evaluate = async (script: string) => {
    const [value] = await browser
      .tab(tabId)
      .page.evaluate(`[${script}]`)
      .then((v) => v as unknown[]);
    return value;
  };
  const taken = async (x: number, y: number): Promise<ElementCapture> => {
    send({ type: 'pick', action: 'start' });
    const reply = await pick(x, y);
    if (reply.type !== 'picked') throw new Error(`no capture: ${reply.message}`);
    return reply.capture;
  };
  const centre = async (id: string) => {
    const box = (await evaluate(`document.getElementById('${id}').getBoundingClientRect().toJSON()`)) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
  };
  return { daemon, send, shot, pick, taken, centre, evaluate, messages, base };
}

/** Width and height from a JPEG's first start-of-frame marker. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) throw new Error('not a JPEG marker');
    const marker = bytes[at + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  throw new Error('no frame header');
}

describe.runIf(chromePath)('element pick over the page stream', () => {
  it('highlights the element under the pointer while picking, and hides it when pick mode ends', async () => {
    const h = await start();
    const plain = await h.shot();
    const { x, y } = await h.centre('buy');

    h.send({ type: 'pick', action: 'start' });
    h.send({ type: 'pick', action: 'hover', x, y });
    const lit = await until(
      () => h.shot(),
      (now) => now !== plain,
      'the highlight to show in the page',
    );
    expect(lit).not.toBe(plain);

    h.send({ type: 'pick', action: 'end' });
    await until(
      () => h.shot(),
      (now) => now === plain,
      'the highlight to go',
    );
  });

  it('captures the element under a click and does not click the page', async () => {
    const h = await start();
    const { x, y, box } = await h.centre('buy');
    const plain = await h.shot();
    const capture = await h.taken(x, y);

    expect(capture).toMatchObject({
      page_url: h.base.concat('/'),
      page_title: 'Pick me',
      tag: 'button',
      id: 'buy',
      classes: ['cta', 'primary'],
      role: 'button',
      name: 'Buy now',
      text: 'Buy now',
      selector: '#buy',
    });
    expect(capture.attributes['data-testid']).toBe('buy-now');
    expect(capture.html).toContain('<button');
    expect(capture.html).toContain('Buy now');
    expect(capture.box).toEqual({ x: box.x, y: box.y, width: box.width, height: box.height });
    expect(capture.styles).toMatchObject({
      color: 'rgb(10, 20, 30)',
      'background-color': 'rgb(200, 220, 255)',
      'font-size': '18px',
      display: 'block',
      position: 'static',
    });

    // The crop is a JPEG of the element, no larger than its box.
    const crop = Buffer.from(capture.crop ?? '', 'base64');
    expect(crop.subarray(0, 2).toString('hex')).toBe('ffd8');
    const size = jpegSize(crop);
    expect(size.width).toBeGreaterThan(0);
    expect(size.width).toBeLessThanOrEqual(Math.ceil(box.width));
    expect(size.height).toBeLessThanOrEqual(Math.ceil(box.height));

    // The page saw no click, and the highlight is gone from it.
    expect(await h.evaluate('document.title')).toBe('Pick me');
    expect(await h.shot()).toBe(plain);

    // Pick mode ended with the pick: another click is not a pick.
    const before = h.messages.length;
    h.send({ type: 'pick', action: 'click', x, y });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.messages.slice(before).some((m) => m.type === 'picked')).toBe(false);
  });

  it('names a selector that finds the element when it has no id', async () => {
    const h = await start();
    const { x, y } = await h.centre('docs');
    const capture = await h.taken(x, y);
    expect(capture.selector).toBe('#docs');

    const form = await h.centre('login');
    const inner = await h.taken(form.box.x + 2, form.box.y + 2);
    expect(inner.tag).toBe('form');
    expect(await h.evaluate(`document.querySelectorAll(${JSON.stringify(inner.selector)}).length`)).toBe(1);
  });

  it('never carries typed values, a password, cookies or storage, and redacts secrets', async () => {
    const h = await start();
    const docs = await h.centre('docs');
    const link = await h.taken(docs.x, docs.y);
    expect(link.attributes.href).not.toContain('abcdef1234567890abcd');
    expect(link.attributes.href).toContain('[redacted]');

    const form = await h.centre('login');
    const capture = await h.taken(form.box.x + 2, form.box.y + 2);
    const everything = JSON.stringify(capture);
    for (const secret of [
      'dave@example.com',
      'typed-in-value-7777',
      'hunter2-password',
      'a private note',
      'typed-note-6666',
      'draft in progress',
      'cookie-value-9999',
      'storage-value-8888',
    ]) {
      expect(everything).not.toContain(secret);
    }
    // The form itself is there, the fields' own markup too, with their values left out.
    expect(capture.html).toContain('name="user"');
    expect(capture.html).toContain('type="password"');
    // A crop would show what was typed.
    expect(capture.crop).toBeNull();

    const password = await h.centre('pw');
    const field = await h.taken(password.x, password.y);
    expect(field.tag).toBe('input');
    expect(field.text).toBe('');
    expect(JSON.stringify(field)).not.toContain('hunter2');
    expect(field.crop).toBeNull();
  });

  it('cuts text and HTML, and crops a tall element to what is in view', async () => {
    const h = await start();
    await h.evaluate(
      `(document.getElementById('big').textContent = 'word '.repeat(500), document.getElementById('big').dataset.pad = 'x'.repeat(5000))`,
    );
    const capture = await h.taken(100, 400);
    expect(capture.id).toBe('big');
    expect(capture.text.length).toBeLessThanOrEqual(400);
    expect(capture.html.length).toBeLessThanOrEqual(2100);
    const size = jpegSize(Buffer.from(capture.crop ?? '', 'base64'));
    expect(size.width).toBeLessThanOrEqual(1280);
    expect(size.height).toBeLessThanOrEqual(800);
    expect(size.width).toBeGreaterThan(100);
  });

  it('picks and crops the element under the pointer on a scrolled page', async () => {
    const h = await start();
    await h.evaluate('window.scrollTo(0, 30)');
    await until(
      () => h.evaluate('window.scrollY'),
      (y) => y === 30,
      'the page to scroll',
    );
    const { x, y, box } = await h.centre('buy');
    const capture = await h.taken(x, y);
    expect(capture.id).toBe('buy');
    expect(capture.box.y).toBe(box.y);
    const size = jpegSize(Buffer.from(capture.crop ?? '', 'base64'));
    expect(size).toEqual({ width: Math.round(box.width), height: Math.round(box.height) });
  });

  it('ignores a click on the page body and a pick from a viewer that is not in pick mode', async () => {
    const h = await start();
    const before = h.messages.length;
    h.send({ type: 'pick', action: 'click', x: 5, y: 5 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.messages.slice(before)).toEqual([]);

    h.send({ type: 'pick', action: 'start' });
    h.send({ type: 'pick', action: 'click', x: 5, y: 5 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.messages.slice(before)).toEqual([]);
  });
});
