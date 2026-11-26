import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { discardBroken, isModuleMissing, NpmPackages } from '../src/mcp/npm-packages';
import { fakeNpm } from './fakes/npm';
import { tempDir } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const PKG = '@bytebase/dbhub';
const root = (base: string) => path.join(base, '@bytebase_dbhub');
const dirs = async (base: string) =>
  (await readdir(root(base)).catch(() => [])).filter((name) => !name.startsWith('.') && name !== 'current.json').sort();

describe('npm package installs', () => {
  it('installs on the first start and reuses the install, with no npm call, on later starts', async () => {
    const base = await tempDir();
    const fake = fakeNpm();
    const packages = new NpmPackages(base, { npm: fake.npm });

    const first = await packages.prepare('npx', ['-y', `${PKG}@latest`, '--transport', 'stdio']);
    expect(first.command).toBe(path.join(root(base), '1.0.0', 'node_modules', PKG, 'server.js'));
    expect(first.args).toEqual(['--transport', 'stdio']);
    expect(fake.state.installs).toBe(1);

    fake.calls.length = 0;
    const second = await packages.prepare('npx', ['-y', `${PKG}@latest`, '--transport', 'stdio']);
    expect(second.command).toBe(first.command);
    expect(fake.calls).toEqual([]);
  });

  it('installs a package named without a version, and leaves other commands and versions alone', async () => {
    const base = await tempDir();
    const fake = fakeNpm();
    const packages = new NpmPackages(base, { npm: fake.npm });

    expect((await packages.prepare('npx', ['firebase-tools', 'mcp'])).args).toEqual(['mcp']);
    for (const [command, args] of [
      ['uvx', ['mcp-clickhouse']],
      ['pup', ['--version']],
      ['npx', ['-y', 'left-pad@1.3.0']],
      ['npx', ['-y', '../evil']],
      ['npx', ['--package', 'x', 'y']],
    ] as const) {
      expect(await packages.prepare(command, [...args])).toEqual({ command, args, dir: null });
    }
    expect(fake.state.installs).toBe(1);
  });

  it('installs once when many starts of one package begin together', async () => {
    const base = await tempDir();
    const fake = fakeNpm({ delayMs: 150 });
    const packages = Array.from({ length: 6 }, () => new NpmPackages(base, { npm: fake.npm }));

    const started = await Promise.all(packages.map((one) => one.prepare('npx', ['-y', `${PKG}@latest`])));

    expect(fake.state.installs).toBe(1);
    expect(new Set(started.map((one) => one.command)).size).toBe(1);
    expect(started[0]?.dir).not.toBeNull();
    expect(await dirs(base)).toEqual(['1.0.0']);
  });

  it('leaves no version folder and no pointer after an install that dies halfway, and the next start succeeds', async () => {
    const base = await tempDir();
    let fail = true;
    const fake = fakeNpm({ failHalfway: () => fail });
    const packages = new NpmPackages(base, { npm: fake.npm });

    // The failed install falls back to npx, so the caller still gets a command.
    expect(await packages.prepare('npx', ['-y', `${PKG}@latest`])).toEqual({
      command: 'npx',
      args: ['-y', `${PKG}@latest`],
      dir: null,
    });
    expect(await dirs(base)).toEqual([]);
    await expect(stat(path.join(root(base), 'current.json'))).rejects.toThrow();

    fail = false;
    const next = await packages.prepare('npx', ['-y', `${PKG}@latest`]);
    expect(next.dir).toBe(path.join(root(base), '1.0.0'));
    expect(await readFile(path.join(next.dir ?? '', 'node_modules', PKG, 'package.json'), 'utf8')).toContain('1.0.0');
  });

  it.each([
    ['a dead pid', { pid: 2 ** 22 + 12345, ageMs: 0 }],
    ['an old lock of a live pid', { pid: process.pid, ageMs: 11 * 60_000 }],
  ])('takes over a lock left by %s', async (_name, held) => {
    const base = await tempDir();
    const lock = path.join(root(base), '.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'pid'), String(held.pid));
    const old = new Date(Date.now() - held.ageMs);
    await utimes(lock, old, old);
    const fake = fakeNpm();

    const started = await new NpmPackages(base, { npm: fake.npm, lockTimeoutMs: 2000 }).prepare('npx', [
      '-y',
      `${PKG}@latest`,
    ]);

    expect(started.dir).toBe(path.join(root(base), '1.0.0'));
    await expect(stat(lock)).rejects.toThrow();
  });

  it('refreshes after 24 hours into a new folder, switches the pointer and leaves the running folder alone', async () => {
    const base = await tempDir();
    const fake = fakeNpm();
    let now = Date.now();
    const packages = new NpmPackages(base, { npm: fake.npm, now: () => now });
    const running = await packages.prepare('npx', ['-y', `${PKG}@latest`]);
    const runningFile = running.command;

    fake.state.latest = '1.1.0';
    now += DAY - 1000;
    await packages.prepare('npx', ['-y', `${PKG}@latest`]);
    await packages.settled();
    expect(fake.state.installs).toBe(1);

    now += 2000;
    const next = await packages.prepare('npx', ['-y', `${PKG}@latest`]);
    expect(next.dir).toBe(running.dir);
    await packages.settled();

    expect(await dirs(base)).toEqual(['1.0.0', '1.1.0']);
    expect((await stat(runningFile)).isFile()).toBe(true);
    const after = await packages.prepare('npx', ['-y', `${PKG}@latest`]);
    expect(after.dir).toBe(path.join(root(base), '1.1.0'));
    expect(JSON.parse(await readFile(path.join(root(base), 'current.json'), 'utf8'))).toMatchObject({
      version: '1.1.0',
    });
    // Asked once a day: another start right after does not ask again.
    const asked = fake.calls.filter((call) => call[0] === 'view').length;
    await packages.prepare('npx', ['-y', `${PKG}@latest`]);
    await packages.settled();
    expect(fake.calls.filter((call) => call[0] === 'view')).toHaveLength(asked);
  });

  it('keeps the newest two version folders and removes older ones', async () => {
    const base = await tempDir();
    const fake = fakeNpm();
    let now = Date.now();
    const packages = new NpmPackages(base, { npm: fake.npm, now: () => now });
    await packages.prepare('npx', ['-y', `${PKG}@latest`]);
    for (const version of ['1.1.0', '1.2.0']) {
      fake.state.latest = version;
      now += DAY + 1000;
      await packages.prepare('npx', ['-y', `${PKG}@latest`]);
      await packages.settled();
      // Folders are told apart by age: give each a distinct one.
      const stamp = new Date(now);
      await utimes(path.join(root(base), version), stamp, stamp);
    }
    expect(await dirs(base)).toEqual(['1.1.0', '1.2.0']);
  });

  it.each([
    ['a string', 'server.js', 'server.js'],
    ['the entry named like the package', { other: 'other.js', dbhub: 'server.js' }, 'server.js'],
    ['the first entry', { first: 'server.js', second: 'second.js' }, 'server.js'],
  ])('starts the bin given as %s', async (_name, bin, file) => {
    const base = await tempDir();
    const started = await new NpmPackages(base, { npm: fakeNpm({ bin }).npm }).prepare('npx', ['-y', `${PKG}@latest`]);
    expect(started.command).toBe(path.join(root(base), '1.0.0', 'node_modules', PKG, file));
  });

  it('falls back to npx when the package has no bin', async () => {
    const base = await tempDir();
    const started = await new NpmPackages(base, { npm: fakeNpm({ bin: undefined }).npm }).prepare('npx', [
      '-y',
      `${PKG}@latest`,
    ]);
    expect(started).toEqual({ command: 'npx', args: ['-y', `${PKG}@latest`], dir: null });
  });

  it('falls back to npx when npm is missing', async () => {
    const base = await tempDir();
    const started = await new NpmPackages(base, { npm: fakeNpm({ missing: true }).npm }).prepare('npx', [
      '-y',
      `${PKG}@latest`,
    ]);
    expect(started).toEqual({ command: 'npx', args: ['-y', `${PKG}@latest`], dir: null });
  });

  it('falls back to npx when another process holds the lock past the wait', async () => {
    const base = await tempDir();
    const lock = path.join(root(base), '.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'pid'), String(process.pid));
    const fake = fakeNpm();
    const started = await new NpmPackages(base, { npm: fake.npm, lockTimeoutMs: 300 }).prepare('npx', [
      '-y',
      `${PKG}@latest`,
    ]);
    expect(started).toEqual({ command: 'npx', args: ['-y', `${PKG}@latest`], dir: null });
    expect(fake.state.installs).toBe(0);
  });

  it('removes the folder a start ran from, or the npx cache folder named in the error, when a module is missing', async () => {
    const base = await tempDir();
    const packages = new NpmPackages(base, { npm: fakeNpm().npm });
    const managed = await packages.prepare('npx', ['-y', `${PKG}@latest`]);
    await discardBroken(managed, '');
    expect((await dirs(base)).length).toBe(0);

    const cache = path.join(await tempDir(), '_npx', '57c35de36e7d43c4');
    await mkdir(path.join(cache, 'node_modules'), { recursive: true });
    const stack = `Error: Cannot find module 'es-abstract'\nRequire stack:\n- ${cache}/node_modules/x/index.js`;
    await discardBroken({ command: 'npx', args: [], dir: null }, stack);
    await expect(stat(cache)).rejects.toThrow();

    expect(isModuleMissing(stack)).toBe(true);
    expect(isModuleMissing("code: 'MODULE_NOT_FOUND'")).toBe(true);
    expect(isModuleMissing('password authentication failed')).toBe(false);
  });
});

describe('npm package installs with the real npm', () => {
  it('installs a real package and runs its bin', async (context) => {
    const run = promisify(execFile);
    const registry = await run('npm', ['view', 'which', 'version'], { timeout: 20_000 }).catch(() => null);
    if (!registry) return context.skip();
    const base = await tempDir();
    const packages = new NpmPackages(base);
    const started = await packages.prepare('npx', ['-y', 'which@latest', 'node']);
    expect(started.dir).not.toBeNull();
    const { stdout } = await run(started.command, started.args);
    expect(stdout.trim()).toMatch(/node/);
    expect(await readdir(path.join(base, 'which'))).toContain('current.json');
  }, 120_000);
});
