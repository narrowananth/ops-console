import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, freePort, install, type Machine, machine, makeRelease, opsConsole } from './helpers';

let release: string;
let nextRelease: string;
const machines: Machine[] = [];

beforeAll(async () => {
  [release, nextRelease] = await Promise.all([makeRelease('1.0.0'), makeRelease('1.1.0')]);
});

afterEach(async () => {
  for (const m of machines.splice(0)) await cleanup(m);
});

async function installed(): Promise<Machine> {
  const m = await machine(release, await freePort());
  machines.push(m);
  expect((await install(m)).code).toBe(0);
  return m;
}

const uid = process.getuid?.();

describe('ops-console start', () => {
  it('writes a KeepAlive plist pointing at current, bootstraps it and returns once healthy', async () => {
    const m = await installed();
    const result = await opsConsole(m, 'start');

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/running on http:\/\/127\.0\.0\.1:\d+/);
    const plist = await readFile(path.join(m.home, 'Library/LaunchAgents/dev.ops-console.plist'), 'utf8');
    expect(plist).toContain(`<string>${path.join(m.installDir, 'current/bin/ops-console')}</string>`);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(await m.calls()).toEqual(
      expect.arrayContaining([
        `enable gui/${uid}/dev.ops-console`,
        `bootstrap gui/${uid} ${path.join(m.home, 'Library/LaunchAgents/dev.ops-console.plist')}`,
      ]),
    );
    expect((await opsConsole(m, 'status')).code).toBe(0);
  });

  it('says so and exits 0 when the daemon already runs', async () => {
    const m = await installed();
    await opsConsole(m, 'start');
    const again = await opsConsole(m, 'start');
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/already running/);
  });

  it('prints the last log lines and fails when the port is taken', async () => {
    const m = await installed();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(Number(m.env.OPS_CONSOLE_PORT), '127.0.0.1', resolve));
    m.env.OPS_CONSOLE_START_TIMEOUT_MS = '4000';

    const result = await opsConsole(m, 'start');

    blocker.close();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`port ${m.env.OPS_CONSOLE_PORT} is already in use`);
  });
});

describe('ops-console stop and status', () => {
  it('reports pid, version, port and health while running, and exits 3 once stopped', async () => {
    const m = await installed();
    await opsConsole(m, 'start');
    const runtime = JSON.parse(await readFile(path.join(m.dataDir, 'runtime.json'), 'utf8'));

    const running = await opsConsole(m, 'status');
    expect(running.code).toBe(0);
    expect(running.stdout).toMatch(/^running/);
    expect(running.stdout).toMatch(new RegExp(`pid\\s+${runtime.pid}`));
    expect(running.stdout).toMatch(/version\s+1\.0\.0/);
    expect(running.stdout).toMatch(new RegExp(`port\\s+${m.env.OPS_CONSOLE_PORT}`));
    expect(running.stdout).toMatch(/health\s+ok/);

    const stopped = await opsConsole(m, 'stop');
    expect(stopped.code).toBe(0);
    expect(await m.calls()).toEqual(
      expect.arrayContaining([`bootout gui/${uid}/dev.ops-console`, `disable gui/${uid}/dev.ops-console`]),
    );
    const after = await opsConsole(m, 'status');
    expect(after.code).toBe(3);
    expect(after.stdout.trim()).toBe('stopped');
    await expect(stat(path.join(m.dataDir, 'runtime.json'))).rejects.toThrow(/ENOENT/);
  });
});

describe('ops-console open', () => {
  it('opens the console URL with the token from the runtime file', async () => {
    const m = await installed();
    await opsConsole(m, 'start');
    const { token } = JSON.parse(await readFile(path.join(m.dataDir, 'runtime.json'), 'utf8'));

    const result = await opsConsole(m, 'open');

    expect(result.code).toBe(0);
    expect(await m.opened()).toEqual([`http://127.0.0.1:${m.env.OPS_CONSOLE_PORT}/#token=${token}`]);
    expect(result.stdout).not.toContain(token);
  });

  it('tells the operator to start the daemon when it is stopped', async () => {
    const m = await installed();
    const result = await opsConsole(m, 'open');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ops-console start');
    expect(await m.opened()).toEqual([]);
  });
});

describe('ops-console logs', () => {
  it('follows the daemon log', async () => {
    const m = await installed();
    await opsConsole(m, 'start');
    // Its own process group, so the kill below reaches `tail` the way Ctrl-C does.
    const child = spawn(path.join(m.home, '.local/bin/ops-console'), ['logs'], { env: m.env, detached: true });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const deadline = Date.now() + 5000;
    while (!output.includes('started') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(output).toContain('started 1.0.0');

    await opsConsole(m, 'stop');
    while (!output.includes('stopped') && Date.now() < deadline + 5000) await new Promise((r) => setTimeout(r, 100));
    process.kill(-(child.pid ?? 0), 'SIGINT');
    expect(output).toContain('stopped');
  });
});

describe('ops-console update', () => {
  it('installs the latest release and restarts a running daemon on it', async () => {
    const m = await installed();
    await opsConsole(m, 'start');

    m.env.OPS_CONSOLE_RELEASE_URL = `file://${nextRelease}`;
    const result = await opsConsole(m, 'update');

    expect(result.code).toBe(0);
    expect((await opsConsole(m, '--version')).stdout.trim()).toBe('1.1.0');
    expect((await opsConsole(m, 'status')).stdout).toMatch(/version\s+1\.1\.0/);
  });

  it('leaves a stopped daemon stopped', async () => {
    const m = await installed();
    m.env.OPS_CONSOLE_RELEASE_URL = `file://${nextRelease}`;
    expect((await opsConsole(m, 'update')).code).toBe(0);
    expect((await opsConsole(m, '--version')).stdout.trim()).toBe('1.1.0');
    expect((await opsConsole(m, 'status')).code).toBe(3);
  });
});

describe('ops-console uninstall', () => {
  it('stops the daemon, removes the install, plist and link, and keeps data and logs', async () => {
    const m = await installed();
    await opsConsole(m, 'start');
    const bin = path.join(m.home, '.local/bin/ops-console');

    const result = await opsConsole(m, 'uninstall');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(m.dataDir);
    expect(result.stdout).toContain(path.join(m.home, 'Library/Logs/ops-console'));
    await expect(stat(m.installDir)).rejects.toThrow(/ENOENT/);
    await expect(stat(path.join(m.home, 'Library/LaunchAgents/dev.ops-console.plist'))).rejects.toThrow(/ENOENT/);
    await expect(stat(bin)).rejects.toThrow(/ENOENT/);
    expect((await stat(path.join(m.dataDir, 'state.db'))).isFile()).toBe(true);
    expect((await stat(m.logFile)).isFile()).toBe(true);
  });
});
