import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Tab, WS_PROTOCOL } from '@ops-console/shared';
import { chromium } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BrowserModule } from '../src/browser/browser.module';
import { type AgentDaemon, api, startAgentDaemon, until } from './agent-fixtures';

const chromePath = [
  process.env.OPS_CONSOLE_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  chromium.executablePath(),
].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));

// Without Chrome the real-browser tests would skip and pass; CI has it, so there a missing Chrome fails here.
it.runIf(!chromePath && Boolean(process.env.CI))('finds Google Chrome, so the Inspector tests run', () => {
  throw new Error('No Google Chrome found: the Inspector tests would skip. Install it or set OPS_CONSOLE_CHROME_PATH.');
});

const page = (title: string) =>
  `<!doctype html><title>${title}</title><h1 id="h">${title}</h1><input id="f" type="file">
<script>console.log('hello from ${title}'); document.cookie = 'who=${title}; Path=/';</script>`;

let dev: Server;
const running: AgentDaemon[] = [];

async function devServer(): Promise<string> {
  dev = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page((req.url ?? '/').slice(1) || 'home'));
  });
  await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(dev.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  await new Promise<void>((resolve) => {
    dev?.closeAllConnections();
    dev?.close(() => resolve());
  });
});

async function start() {
  const daemon = await startAgentDaemon({ modules: [BrowserModule.forRoot({ chromePath })] });
  running.push(daemon);
  return { daemon, http: api(daemon), base: await devServer() };
}
type Harness = Awaited<ReturnType<typeof start>>;

async function openTab(h: Harness, sessionId: string, path: string): Promise<Tab> {
  const created = await h.http.post(`/sessions/${sessionId}/browser/tabs`, { url: `${h.base}${path}` });
  expect(created.status).toBe(201);
  const id = created.body.data.id as string;
  return until(
    async () => ((await h.http.get(`/sessions/${sessionId}/browser`)).body.data.tabs as Tab[]).find((t) => t.id === id),
    (tab) => tab !== undefined && !tab.loading && tab.title !== '',
    'the tab to load',
  ) as Promise<Tab>;
}

type Reply = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  method?: string;
};

/** What DevTools is to the relay: JSON requests with ids, replies and events back. */
async function inspect(daemon: AgentDaemon, tabId: string, token = daemon.token) {
  const socket = new WebSocket(`${daemon.url.replace('http', 'ws')}/browser/${tabId}/devtools`, [WS_PROTOCOL, token]);
  daemon.sockets.add(socket);
  const received: Reply[] = [];
  socket.on('message', (raw) => received.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let next = 0;
  return {
    socket,
    received,
    async call(method: string, params: object = {}): Promise<Reply> {
      next += 1;
      const id = next;
      socket.send(JSON.stringify({ id, method, params }));
      return until(
        async () => received.find((message) => message.id === id),
        (reply) => reply !== undefined,
        `the reply to ${method}`,
      ) as Promise<Reply>;
    },
    closed: new Promise<{ code: number; reason: string }>((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason: String(reason) })),
    ),
  };
}

/** The HTTP status of an attempt to attach: 101 when it was let in. */
const attempt = (daemon: AgentDaemon, tabId: string, protocols: string[]): Promise<number> =>
  new Promise((resolve) => {
    const socket = new WebSocket(`${daemon.url.replace('http', 'ws')}/browser/${tabId}/devtools`, protocols);
    socket.on('error', () => {});
    socket.once('open', () => {
      resolve(101);
      socket.terminate();
    });
    socket.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
  });

describe.runIf(chromePath)('the Inspector window relay', () => {
  it('runs DevTools requests on the tab and sends its events back', async () => {
    const h = await start();
    const session = h.daemon.createSession();
    const tab = await openTab(h, session, '/home');
    const devtools = await inspect(h.daemon, tab.id);

    expect((await devtools.call('Runtime.evaluate', { expression: '1+1', returnByValue: true })).result).toMatchObject({
      result: { value: 2 },
    });
    const document = await devtools.call('DOM.getDocument', { depth: 1 });
    expect(document.result).toMatchObject({ root: { nodeName: '#document' } });
    await devtools.call('Runtime.enable');
    await devtools.call('Runtime.evaluate', { expression: "console.log('from the console')" });
    await until(
      async () => devtools.received.filter((m) => m.method === 'Runtime.consoleAPICalled'),
      (events) => events.length > 0,
      'a console event',
    );
    // What DevTools' other panels turn on.
    for (const method of ['Animation.enable', 'Preload.enable', 'Security.enable', 'Page.getSubApps']) {
      expect((await devtools.call(method)).error, method).toBeUndefined();
    }
    const cookies = await devtools.call('Network.getCookies', { urls: [h.base] });
    expect(JSON.stringify(cookies.result)).toContain('who');
  });

  it('refuses what drives the tab or reaches the browser, answers with an error and stays open', async () => {
    const h = await start();
    const session = h.daemon.createSession();
    const tab = await openTab(h, session, '/home');
    const devtools = await inspect(h.daemon, tab.id);

    for (const method of [
      'Browser.close',
      'Browser.getVersion',
      'Target.getTargets',
      'Target.createTarget',
      'Target.attachToTarget',
      'Fetch.enable',
      'Tracing.start',
      'Input.dispatchMouseEvent',
      'Emulation.setDeviceMetricsOverride',
      'Page.navigate',
      'Page.close',
      'Page.startScreencast',
      'Page.screencastFrameAck',
      'Page.addScriptToEvaluateOnNewDocument',
      'Security.setIgnoreCertificateErrors',
      'SystemInfo.getInfo',
      'DOM.setFileInputFiles',
      'Network.setRequestInterception',
      'NoSuchDomain.nothing',
    ]) {
      const reply = await devtools.call(method, {});
      expect(reply.error, method).toMatchObject({ code: -32601 });
      expect(reply.result, method).toBeUndefined();
    }
    // A message with a child session, and one that is not a request, are errors too.
    devtools.socket.send(JSON.stringify({ id: 900, method: 'Runtime.evaluate', params: {}, sessionId: 'abc' }));
    devtools.socket.send('not json');
    await until(
      async () => devtools.received,
      (all) => all.some((m) => m.id === 900 && m.error) && all.some((m) => m.id === undefined && m.error),
      'the errors',
    );

    // The socket is open and the tab is as it was: the same page, not navigated, not resized.
    expect(devtools.socket.readyState).toBe(WebSocket.OPEN);
    expect(
      (await devtools.call('Runtime.evaluate', { expression: 'location.pathname', returnByValue: true })).result,
    ).toMatchObject({ result: { value: '/home' } });
    const viewport = await devtools.call('Runtime.evaluate', { expression: 'innerWidth', returnByValue: true });
    expect(viewport.result).toMatchObject({ result: { value: 1280 } });
  });

  it('stays on the tab when it moves to another site', async () => {
    const h = await start();
    const session = h.daemon.createSession();
    const tab = await openTab(h, session, '/home');
    const devtools = await inspect(h.daemon, tab.id);
    await devtools.call('Runtime.enable');
    const other = h.base.replace('127.0.0.1', 'localhost');
    await h.http.patch(`/browser/tabs/${tab.id}`, { url: `${other}/moved` });
    await until(
      async () =>
        (await devtools.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result,
      (result) => JSON.stringify(result).includes('moved'),
      'the relay to see the other site',
    );
  });

  it('gives the page no way to read a file of this Mac', async () => {
    const h = await start();
    const tab = await openTab(h, h.daemon.createSession(), '/home');
    const devtools = await inspect(h.daemon, tab.id);
    const tree = await devtools.call('Page.getFrameTree');
    const frameId = (tree.result as { frameTree: { frame: { id: string } } }).frameTree.frame.id;
    const loaded = await devtools.call('Network.loadNetworkResource', {
      frameId,
      url: 'file:///etc/hosts',
      options: { disableCache: true, includeCredentials: false },
    });
    expect(loaded.error?.message).toBe('Unsupported URL scheme');
    expect(
      (await devtools.call('DOM.setFileInputFiles', { files: ['/etc/hosts'], backendNodeId: 1 })).error,
    ).toMatchObject({
      code: -32601,
    });
  });

  it('asks Chrome for a method it knows nothing of and passes the error on', async () => {
    const h = await start();
    const tab = await openTab(h, h.daemon.createSession(), '/home');
    const devtools = await inspect(h.daemon, tab.id);
    const reply = await devtools.call('DOM.noSuchMethod');
    expect(reply.error?.message).toBe("'DOM.noSuchMethod' wasn't found");
  });

  it('answers a target query for the page alone and attaches no child targets', async () => {
    const h = await start();
    const tab = await openTab(h, h.daemon.createSession(), '/home');
    const devtools = await inspect(h.daemon, tab.id);
    expect(
      (await devtools.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }))
        .result,
    ).toEqual({});
    expect((await devtools.call('Target.getTargetInfo')).result).toMatchObject({
      targetInfo: { type: 'page', url: `${h.base}/home` },
    });
  });

  it('serves only the token holder, and only a tab that exists', async () => {
    const h = await start();
    const tab = await openTab(h, h.daemon.createSession(), '/home');
    expect(await attempt(h.daemon, tab.id, [WS_PROTOCOL, 'wrong'])).toBe(401);
    expect(await attempt(h.daemon, tab.id, [])).toBe(401);
    expect(await attempt(h.daemon, 'nope', [WS_PROTOCOL, h.daemon.token])).toBe(404);
  });

  it('keeps a window to its own tab: another Session’s page is out of reach', async () => {
    const h = await start();
    const mine = await openTab(h, h.daemon.createSession(), '/mine');
    const theirs = await openTab(h, h.daemon.createSession(), '/theirs');
    const devtools = await inspect(h.daemon, mine.id);
    expect(
      (await devtools.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result,
    ).toMatchObject({ result: { value: 'mine' } });
    expect((await devtools.call('Target.getTargets')).error).toBeDefined();
    expect((await devtools.call('Target.attachToTarget', { targetId: theirs.id })).error).toBeDefined();
  });

  it('lets a few windows attach to one tab, and refuses one more', async () => {
    const h = await start();
    const tab = await openTab(h, h.daemon.createSession(), '/home');
    const windows = [];
    for (let i = 0; i < 3; i += 1) windows.push(await inspect(h.daemon, tab.id));
    expect(await attempt(h.daemon, tab.id, [WS_PROTOCOL, h.daemon.token])).toBe(429);
    windows[0]?.socket.close();
    await windows[0]?.closed;
    await until(
      () => attempt(h.daemon, tab.id, [WS_PROTOCOL, h.daemon.token]),
      (status) => status === 101,
      'the freed place',
    );
    const again = await inspect(h.daemon, tab.id);
    expect((await again.call('Runtime.evaluate', { expression: '2+2', returnByValue: true })).result).toMatchObject({
      result: { value: 4 },
    });
  });

  it('lifts a pause the window left on the page when it closes', async () => {
    const h = await start();
    const session = h.daemon.createSession();
    const tab = await openTab(h, session, '/home');
    const devtools = await inspect(h.daemon, tab.id);
    await devtools.call('Debugger.enable');
    await devtools.call('Debugger.pause');
    devtools.socket.close();
    await devtools.closed;
    const after = await inspect(h.daemon, tab.id);
    expect((await after.call('Runtime.evaluate', { expression: '3+3', returnByValue: true })).result).toMatchObject({
      result: { value: 6 },
    });
  });

  it('closes when its tab closes, when its Session is deleted and when the daemon stops', async () => {
    const h = await start();
    const session = h.daemon.createSession();
    const tab = await openTab(h, session, '/home');
    const closedTab = await inspect(h.daemon, tab.id);
    expect((await h.http.delete(`/browser/tabs/${tab.id}`)).status).toBe(204);
    expect(await closedTab.closed).toMatchObject({ reason: 'tab_closed' });

    const other = h.daemon.createSession();
    const second = await openTab(h, other, '/home');
    const deleted = await inspect(h.daemon, second.id);
    expect((await h.http.delete(`/sessions/${other}`)).status).toBe(204);
    expect(await deleted.closed).toMatchObject({ code: 1000 });

    const third = await openTab(h, h.daemon.createSession(), '/home');
    const stopped = await inspect(h.daemon, third.id);
    await h.daemon.stop();
    running.splice(0);
    expect((await stopped.closed).code).toBeGreaterThan(0);
  });
});
