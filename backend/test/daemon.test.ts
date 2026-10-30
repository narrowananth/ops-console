import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { removeDir, startTestDaemon, type TestDaemon, tempDir } from './helpers';

const running: TestDaemon[] = [];
async function start(...args: Parameters<typeof startTestDaemon>) {
  const daemon = await startTestDaemon(...args);
  running.push(daemon);
  return daemon;
}

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

describe('daemon', () => {
  it('answers health with the session token and refuses without it', async () => {
    const daemon = await start();

    const ok = await request(daemon.url).get('/api/health').set('Authorization', `Bearer ${daemon.token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'ok', version: '1.2.3-test' });

    const missing = await request(daemon.url).get('/api/health');
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });

    const wrong = await request(daemon.url).get('/api/health').set('Authorization', 'Bearer nope');
    expect(wrong.status).toBe(401);

    const unknownPath = await request(daemon.url).get('/api/nothing-here');
    expect(unknownPath.status).toBe(401);
    expect(unknownPath.body.error.code).toBe('unauthorized');
  });

  it('listens on 127.0.0.1 only', async () => {
    const daemon = await start();
    expect((daemon.app.getHttpServer().address() as net.AddressInfo).address).toBe('127.0.0.1');
  });

  it('serves the UI, falls back to index.html for client routes, and 404s unknown /api paths', async () => {
    // Installed, the UI sits under ~/.ops-console, a dot folder.
    const uiDir = path.join(await tempDir(), '.ops-console', 'public');
    await mkdir(uiDir, { recursive: true });
    await writeFile(path.join(uiDir, 'index.html'), '<html>shell</html>');
    await mkdir(path.join(uiDir, 'assets'));
    await writeFile(path.join(uiDir, 'assets', 'app.js'), 'console.log(1)');
    const daemon = await start({ uiDir });

    expect((await request(daemon.url).get('/')).text).toContain('shell');
    expect((await request(daemon.url).get('/workspace/sessions/abc')).text).toContain('shell');
    expect((await request(daemon.url).get('/assets/app.js')).text).toContain('console.log(1)');

    const unknown = await request(daemon.url).get('/api/nothing-here').set('Authorization', `Bearer ${daemon.token}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');
    await removeDir(uiDir);
  });

  it('writes a 0600 runtime file on start and removes it on a clean stop', async () => {
    const dataDir = await tempDir();
    const daemon = await startTestDaemon({ dataDir });
    const file = path.join(dataDir, 'runtime.json');

    const runtime = JSON.parse(await readFile(file, 'utf8'));
    expect(runtime).toEqual({
      pid: process.pid,
      port: daemon.port,
      version: '1.2.3-test',
      started_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      token: daemon.token,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await daemon.stop();
    await expect(stat(file)).rejects.toThrow(/ENOENT/);
  });

  it('issues a new token on every start', async () => {
    const dataDir = await tempDir();
    const first = await startTestDaemon({ dataDir });
    await first.stop();
    const second = await start({ dataDir });
    expect(second.token).not.toBe(first.token);
    expect(second.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('exits with a log line naming the port when the port is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    const log: string[] = [];

    await expect(startTestDaemon({ port, log })).rejects.toThrow(String(port));
    expect(log.join('\n')).toMatch(new RegExp(`port ${port}.*in use`));
    blocker.close();
  });

  it('refuses to start on a data folder another running daemon holds, and names it', async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir });
    const log: string[] = [];

    await expect(startTestDaemon({ dataDir, log })).rejects.toThrow(/already running/);
    expect(log.join('\n')).toContain(dataDir);
    expect(log.join('\n')).toContain(`pid ${process.pid}`);

    const stillServing = await request(first.url).get('/api/health').set('Authorization', `Bearer ${first.token}`);
    expect(stillServing.status).toBe(200);
  });

  it('takes over a lock left by a daemon that no longer runs', async () => {
    const dataDir = await tempDir();
    const deadPid = 2 ** 22 + 12345;
    await writeFile(path.join(dataDir, 'daemon.lock'), String(deadPid));

    const daemon = await start({ dataDir });
    const health = await request(daemon.url).get('/api/health').set('Authorization', `Bearer ${daemon.token}`);
    expect(health.status).toBe(200);
  });

  it('allows a fresh start on the same folder after a clean stop', async () => {
    const dataDir = await tempDir();
    const first = await startTestDaemon({ dataDir });
    await first.stop();
    await expect(stat(path.join(dataDir, 'daemon.lock'))).rejects.toThrow(/ENOENT/);
    await start({ dataDir });
  });

  it('logs start and stop but never the session token', async () => {
    const daemon = await startTestDaemon();
    await request(daemon.url).get('/api/health').set('Authorization', `Bearer ${daemon.token}`);
    await request(daemon.url).get('/api/health').set('Authorization', `Bearer ${daemon.token}x`);
    await daemon.stop();

    const text = daemon.log.join('\n');
    expect(text).toMatch(/migration/);
    expect(text).toMatch(/started/);
    expect(text).toMatch(/stopped/);
    expect(text).not.toContain(daemon.token);
  });
});
