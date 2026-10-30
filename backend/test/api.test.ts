import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ItemsFixtureModule, SettingsFixtureModule } from './fixtures';
import { startTestDaemon, type TestDaemon, tempDir } from './helpers';

const running: TestDaemon[] = [];
async function start(dataDir?: string) {
  const daemon = await startTestDaemon({
    dataDir,
    modules: [{ module: SettingsFixtureModule }, { module: ItemsFixtureModule }],
  });
  running.push(daemon);
  return daemon;
}

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

const auth = (daemon: TestDaemon) => ({ Authorization: `Bearer ${daemon.token}` });

describe('settings', () => {
  it('returns defaults for keys never changed', async () => {
    const daemon = await start();
    const response = await request(daemon.url).get('/api/settings').set(auth(daemon));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { 'scan.interval_minutes': 15, theme: 'light' } });
  });

  it('stores a valid change and returns it across restarts', async () => {
    const dataDir = await tempDir();
    const daemon = await start(dataDir);
    const patched = await request(daemon.url).patch('/api/settings').set(auth(daemon)).send({ theme: 'dark' });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ data: { 'scan.interval_minutes': 15, theme: 'dark' } });

    await running.pop()?.stop();
    const again = await start(dataDir);
    const read = await request(again.url).get('/api/settings').set(auth(again));
    expect(read.body.data.theme).toBe('dark');
  });

  it('rejects an unknown key or a bad value by name and writes nothing', async () => {
    const daemon = await start();

    const unknown = await request(daemon.url)
      .patch('/api/settings')
      .set(auth(daemon))
      .send({ theme: 'dark', 'no.such.key': 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toEqual({ code: 'validation_failed', message: expect.stringContaining('no.such.key') });

    const bad = await request(daemon.url)
      .patch('/api/settings')
      .set(auth(daemon))
      .send({ theme: 'dark', 'scan.interval_minutes': 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toEqual({
      code: 'validation_failed',
      message: expect.stringContaining('scan.interval_minutes'),
    });

    const read = await request(daemon.url).get('/api/settings').set(auth(daemon));
    expect(read.body.data).toEqual({ 'scan.interval_minutes': 15, theme: 'light' });
  });
});

describe('errors', () => {
  it('answers a body that is not JSON with validation_failed', async () => {
    const daemon = await start();
    const response = await request(daemon.url)
      .patch('/api/settings')
      .set(auth(daemon))
      .set('Content-Type', 'application/json')
      .send('{ not json');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
  });

  it('names the failing query and param fields', async () => {
    const daemon = await start();
    const query = await request(daemon.url).get('/api/items?limit=500').set(auth(daemon));
    expect(query.status).toBe(400);
    expect(query.body).toEqual({ error: { code: 'validation_failed', message: expect.stringContaining('limit') } });

    const param = await request(daemon.url).get('/api/items/not-a-uuid').set(auth(daemon));
    expect(param.status).toBe(400);
    expect(param.body).toEqual({ error: { code: 'validation_failed', message: expect.stringContaining('id') } });
  });
});

describe('list paging', () => {
  it('pages with limit and cursor, with a null cursor on the last page', async () => {
    const daemon = await start();
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=25&cursor=${cursor}` : '?limit=25';
      const response = await request(daemon.url).get(`/api/items${query}`).set(auth(daemon));
      expect(response.status).toBe(200);
      seen.push(...response.body.data);
      sizes.push(response.body.data.length);
      cursor = response.body.meta.next_cursor;
    } while (cursor !== null);

    expect(sizes).toEqual([25, 25, 10]);
    expect(new Set(seen).size).toBe(60);
    expect(seen.at(-1)).toBe('item-60');
  });

  it('returns 50 rows when no limit is given', async () => {
    const daemon = await start();
    const response = await request(daemon.url).get('/api/items').set(auth(daemon));
    expect(response.body.data).toHaveLength(50);
    expect(response.body.meta.next_cursor).toEqual(expect.any(String));
  });
});
