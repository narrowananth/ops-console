import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, freePort, install, linuxMachine, type Machine, makeRelease, opsConsole, run } from './helpers';

// The CLI runs with `process.platform` set to linux and fake systemctl and xdg-open first on PATH: the unit file, the
// calls to systemctl and the paths are real, systemd and the desktop are not.

let release: string;
let nextRelease: string;
const machines: Machine[] = [];

beforeAll(async () => {
  [release, nextRelease] = await Promise.all([
    makeRelease('1.0.0', 'x64', 'linux'),
    makeRelease('1.1.0', 'x64', 'linux'),
  ]);
});

afterEach(async () => {
  for (const m of machines.splice(0)) await cleanup(m);
});

async function installed(): Promise<Machine> {
  const m = await linuxMachine(release, await freePort());
  machines.push(m);
  expect((await install(m)).code).toBe(0);
  return m;
}

const unitFile = (m: Machine) => path.join(m.home, '.config/systemd/user/ops-console.service');

describe('ops-console start on Linux', () => {
  it('writes a restarting user service on the bundled node, enables it and returns once healthy', async () => {
    const m = await installed();
    const result = await opsConsole(m, 'start');

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/running on http:\/\/127\.0\.0\.1:\d+/);
    const unit = await readFile(unitFile(m), 'utf8');
    expect(unit).toContain(
      `ExecStart="${path.join(m.installDir, 'current/node/bin/node')}" "${path.join(m.installDir, 'current/app/main.js')}"`,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('Environment="UV_THREADPOOL_SIZE=16"');
    expect(unit).toContain(`Environment="OPS_CONSOLE_DATA_DIR=${m.dataDir}"`);
    expect(await m.calls()).toEqual(
      expect.arrayContaining(['--user daemon-reload', '--user enable --now ops-console.service']),
    );
    // The daemon wrote where the CLI reads: the XDG data folder, and its output reached the XDG state folder.
    expect((await stat(path.join(m.dataDir, 'runtime.json'))).isFile()).toBe(true);
    expect(await readFile(m.logFile, 'utf8')).toContain('started 1.0.0');
    expect((await opsConsole(m, 'status')).code).toBe(0);
  });

  it('says there is no systemd user manager, exits non-zero and starts no daemon', async () => {
    const m = await installed();
    m.env.FAKE_SYSTEMD = 'none';

    const result = await opsConsole(m, 'start');

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('no systemd user manager');
    expect(result.stderr).toContain('No medium found');
    expect(await m.calls()).not.toContain('--user enable --now ops-console.service');
    await expect(stat(path.join(m.dataDir, 'runtime.json'))).rejects.toThrow(/ENOENT/);
    expect((await opsConsole(m, 'status')).code).toBe(3);
  });
});

describe('ops-console stop on Linux', () => {
  it('disables the service so it stays stopped, and status exits 3', async () => {
    const m = await installed();
    await opsConsole(m, 'start');

    expect((await opsConsole(m, 'stop')).code).toBe(0);

    expect(await m.calls()).toContain('--user disable --now ops-console.service');
    const after = await opsConsole(m, 'status');
    expect(after.code).toBe(3);
    expect(after.stdout.trim()).toBe('stopped');
  });
});

describe('ops-console update on Linux', () => {
  it('restarts the running daemon on the new version without enabling the unit again', async () => {
    const m = await installed();
    await opsConsole(m, 'start');
    const enables = (await m.calls()).filter((call) => call.includes('enable --now')).length;

    m.env.OPS_CONSOLE_RELEASE_URL = `file://${nextRelease}`;
    const result = await opsConsole(m, 'update');

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect((await opsConsole(m, 'status')).stdout).toMatch(/version\s+1\.1\.0/);
    const calls = await m.calls();
    expect(calls.filter((call) => call === '--user restart ops-console.service')).toHaveLength(1);
    expect(calls.filter((call) => call.includes('enable --now'))).toHaveLength(enables);
  });

  it('leaves a stopped daemon stopped', async () => {
    const m = await installed();
    m.env.OPS_CONSOLE_RELEASE_URL = `file://${nextRelease}`;
    expect((await opsConsole(m, 'update')).code).toBe(0);
    expect((await opsConsole(m, 'status')).code).toBe(3);
  });
});

describe('ops-console uninstall on Linux', () => {
  it('stops the daemon, removes the unit, install and link, and keeps data and logs', async () => {
    const m = await installed();
    await opsConsole(m, 'start');

    const result = await opsConsole(m, 'uninstall');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(m.dataDir);
    expect(result.stdout).toContain(path.dirname(m.logFile));
    await expect(stat(unitFile(m))).rejects.toThrow(/ENOENT/);
    await expect(stat(m.installDir)).rejects.toThrow(/ENOENT/);
    await expect(stat(path.join(m.home, '.local/bin/ops-console'))).rejects.toThrow(/ENOENT/);
    expect((await stat(m.dataDir)).isDirectory()).toBe(true);
    expect((await stat(m.logFile)).isFile()).toBe(true);
  });
});

describe('ops-console open on Linux', () => {
  it('opens the URL with the token through xdg-open on a desktop', async () => {
    const m = await installed();
    await opsConsole(m, 'start');
    const { token } = JSON.parse(await readFile(path.join(m.dataDir, 'runtime.json'), 'utf8'));
    m.env.DISPLAY = ':0';

    const result = await opsConsole(m, 'open');

    expect(result.code).toBe(0);
    expect(await m.opened()).toEqual([`http://127.0.0.1:${m.env.OPS_CONSOLE_PORT}/#token=${token}`]);
    expect(result.stdout).not.toContain(token);
  });

  it.each([
    ['no desktop session', {}, undefined],
    ['no xdg-open', { DISPLAY: ':0' }, ['/usr/bin', '/bin']],
  ] as [string, NodeJS.ProcessEnv, string[] | undefined][])(
    'prints the address and exits 0 with %s, and never prints the token',
    async (_name, extra, bins) => {
      const m = await installed();
      await opsConsole(m, 'start');
      const { token } = JSON.parse(await readFile(path.join(m.dataDir, 'runtime.json'), 'utf8'));
      const env = { ...m.env, ...extra };
      if (bins) env.PATH = [path.join(m.home, '.local/bin'), path.dirname(process.execPath), ...bins].join(':');

      const result = await run(path.join(m.home, '.local/bin/ops-console'), ['open'], env);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`http://127.0.0.1:${m.env.OPS_CONSOLE_PORT}`);
      expect(result.stdout).not.toContain(token);
      expect(await m.opened()).toEqual([]);
    },
  );

  it('tells the operator to start the daemon when it is stopped', async () => {
    const m = await installed();
    const result = await opsConsole(m, 'open');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ops-console start');
  });
});
