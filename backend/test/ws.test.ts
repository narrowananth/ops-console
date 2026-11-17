import { SessionState, WS_PROTOCOL, type WsEvent } from '@ops-console/shared';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { settings } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { SettingsFixtureModule } from './fixtures';
import { startTestDaemon, type TestDaemon } from './helpers';

const running: TestDaemon[] = [];
async function start() {
  const daemon = await startTestDaemon({ modules: [{ module: SettingsFixtureModule }] });
  running.push(daemon);
  return daemon;
}

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

function wsUrl(daemon: TestDaemon): string {
  return `${daemon.url.replace('http', 'ws')}/ws`;
}

/** Resolves with the events received once the socket is open; `settle` waits for stragglers. */
async function listen(daemon: TestDaemon): Promise<{ events: WsEvent[]; socket: WebSocket }> {
  const socket = new WebSocket(wsUrl(daemon), [WS_PROTOCOL, daemon.token]);
  const events: WsEvent[] = [];
  socket.on('message', (raw) => events.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { events, socket };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

function refusal(url: string, protocols: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols);
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    socket.once('open', () => reject(new Error('connection was accepted')));
    socket.once('error', () => {});
  });
}

describe('WebSocket', () => {
  it('refuses a connection without the session token', async () => {
    const daemon = await start();
    expect(await refusal(wsUrl(daemon), [WS_PROTOCOL])).toBe(401);
    expect(await refusal(wsUrl(daemon), [WS_PROTOCOL, 'wrong-token'])).toBe(401);
  });

  it('sends settings.updated after a settings change commits', async () => {
    const daemon = await start();
    const { events, socket } = await listen(daemon);

    await request(daemon.url)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${daemon.token}`)
      .send({ theme: 'dark' });
    await settle();

    expect(events).toEqual([{ event: 'settings.updated', at: expect.any(String), data: { keys: ['theme'] } }]);
    socket.close();
  });

  it('sends no event for a change that rolls back', async () => {
    const daemon = await start();
    const { events, socket } = await listen(daemon);
    const store = daemon.app.get<Store>(STORE);

    expect(() =>
      store.write((tx, emit) => {
        tx.insert(settings).values({ key: 'theme', value: '"dark"' }).run();
        emit('settings.updated', { keys: ['theme'] });
        throw new Error('later step failed');
      }),
    ).toThrow('later step failed');
    await settle();

    expect(events).toEqual([]);
    const read = await request(daemon.url).get('/api/settings').set('Authorization', `Bearer ${daemon.token}`);
    expect(read.body.data.theme).toBe('light');
    socket.close();
  });

  it('sends a client that is not reading the newest of each part and every other event', async () => {
    const daemon = await start();
    const { events, socket } = await listen(daemon);
    const store = daemon.app.get<Store>(STORE);
    const output = (text: string) =>
      store.emit('session.output', { session_id: 's', message_id: 'm', part_index: 0, part: { kind: 'text', text } });

    socket.pause();
    const sent = 400;
    for (let i = 0; i < sent; i++) output(`${i}:${'x'.repeat(64 * 1024)}`);
    store.emit('session.finished', {
      session_id: 's',
      message_id: 'm',
      status: 'done',
      state: SessionState.Idle,
      error_code: null,
      started_by: 'operator',
    });
    socket.resume();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const texts = events.flatMap((e) =>
      e.event === 'session.output' && e.data.part.kind === 'text' ? [e.data.part.text] : [],
    );
    expect(texts.length).toBeLessThan(sent);
    expect(texts.at(-1)?.startsWith(`${sent - 1}:`)).toBe(true);
    expect(events.at(-1)?.event).toBe('session.finished');
    socket.close();
  });
});
