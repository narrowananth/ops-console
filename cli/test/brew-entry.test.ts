import { chmod, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bareMachine, brewEntry, cleanup, freePort, type Machine, makeCellar, makeRelease, tempDir } from './helpers';

let release100: string;
let release110: string;
const machines: Machine[] = [];

beforeAll(async () => {
  [release100, release110] = await Promise.all([makeRelease('1.0.0'), makeRelease('1.1.0')]);
});

afterEach(async () => {
  for (const m of machines.splice(0)) await cleanup(m);
});

async function mac(): Promise<Machine> {
  const m = await bareMachine(await freePort());
  machines.push(m);
  return m;
}

const installedVersion = async (m: Machine) =>
  (await readFile(path.join(m.installDir, 'current/VERSION'), 'utf8').catch(() => '')).trim();

describe('the Brew entry command', () => {
  it('installs the formula version on first run, then runs the typed command with its exit code', async () => {
    const m = await mac();
    const cellar = await makeCellar(release100, '1.0.0');

    const result = await brewEntry(cellar, m, ['status']);

    expect(await installedVersion(m)).toBe('1.0.0');
    expect(result.stdout).toContain('Installed ops-console 1.0.0');
    expect(result.stdout).toContain('stopped');
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('ops-console: installing 1.0.0');
    // The entry command's own install makes no ~/.local/bin link.
    await expect(readlink(path.join(m.home, '.local/bin/ops-console'))).rejects.toThrow();
  });

  it('installs a newer formula version over an older install, then runs the command', async () => {
    const m = await mac();
    await brewEntry(await makeCellar(release100, '1.0.0'), m, ['--version']);

    const result = await brewEntry(await makeCellar(release110, '1.1.0'), m, ['--version']);

    expect(result.stderr).toContain('ops-console: installing 1.1.0');
    expect(result.stdout.trim().split('\n').pop()).toBe('1.1.0');
    expect(await installedVersion(m)).toBe('1.1.0');
  });

  it('runs the command with no install when the installed version equals the formula version', async () => {
    const m = await mac();
    const cellar = await makeCellar(release100, '1.0.0');
    await brewEntry(cellar, m, ['--version']);

    const result = await brewEntry(cellar, m, ['--version']);

    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('1.0.0');
  });

  it('never downgrades an app that updated itself past the formula', async () => {
    const m = await mac();
    await brewEntry(await makeCellar(release110, '1.1.0'), m, ['--version']);

    const result = await brewEntry(await makeCellar(release100, '1.0.0'), m, ['--version']);

    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('1.1.0');
    expect(await installedVersion(m)).toBe('1.1.0');
  });

  it('compares versions as numbers, not as text', async () => {
    const m = await mac();
    const [nine, ten] = await Promise.all([makeRelease('1.9.0'), makeRelease('1.10.0')]);
    await brewEntry(await makeCellar(nine, '1.9.0'), m, ['--version']);
    expect(await installedVersion(m)).toBe('1.9.0');

    await brewEntry(await makeCellar(ten, '1.10.0'), m, ['--version']);

    expect(await installedVersion(m)).toBe('1.10.0');
  });

  it('skips the version check for uninstall and update when an app is installed', async () => {
    const m = await mac();
    await brewEntry(await makeCellar(release100, '1.0.0'), m, ['--version']);
    const newer = await makeCellar(release110, '1.1.0');

    const update = await brewEntry(newer, m, ['update'], { OPS_CONSOLE_RELEASE_URL: `file://${release110}` });
    expect(update.stderr).not.toContain('installing');
    expect(await installedVersion(m)).toBe('1.1.0');
    await expect(readlink(path.join(m.home, '.local/bin/ops-console'))).rejects.toThrow();

    const stale = await mac();
    await brewEntry(await makeCellar(release100, '1.0.0'), stale, ['--version']);
    const uninstall = await brewEntry(newer, stale, ['uninstall']);
    expect(uninstall.stderr).not.toContain('installing');
    expect(uninstall.code).toBe(0);
    expect(await installedVersion(stale)).toBe('');
  });

  it('says nothing is installed for uninstall with no app, and installs the formula version first for update', async () => {
    const m = await mac();
    const cellar = await makeCellar(release100, '1.0.0');

    const uninstall = await brewEntry(cellar, m, ['uninstall']);
    expect(uninstall.code).toBe(0);
    expect(uninstall.stderr).toContain('not installed');
    expect(await installedVersion(m)).toBe('');

    const update = await brewEntry(cellar, m, ['update'], { OPS_CONSOLE_RELEASE_URL: `file://${release110}` });
    expect(update.stderr).toContain('installing 1.0.0');
    expect(await installedVersion(m)).toBe('1.1.0');
  });

  it('passes arguments, stdin and the exit code to the installed command', async () => {
    const m = await mac();
    const current = path.join(m.installDir, 'current');
    await mkdir(path.join(current, 'bin'), { recursive: true });
    await writeFile(path.join(current, 'VERSION'), '1.0.0\n');
    const stub = path.join(current, 'bin/ops-console');
    await writeFile(stub, '#!/bin/sh\necho "args: $*"\ncat\nexit 7\n');
    await chmod(stub, 0o755);

    const result = await brewEntry(await makeCellar(release100, '1.0.0'), m, ['open', 'Google Chrome'], {}, 'typed\n');

    expect(result.stdout).toBe('args: open Google Chrome\ntyped\n');
    expect(result.code).toBe(7);
  });

  it('prints the install failure, runs no command and keeps the installed version', async () => {
    const m = await mac();
    await brewEntry(await makeCellar(release100, '1.0.0'), m, ['--version']);
    const failing = path.join(await tempDir('failing-'), 'install.sh');
    await writeFile(failing, '#!/bin/sh\necho "disk full" >&2\nexit 9\n');

    const result = await brewEntry(await makeCellar(release110, '1.1.0', failing), m, ['--version']);

    expect(result.code).toBe(9);
    expect(result.stderr).toContain('disk full');
    expect(result.stdout).toBe('');
    expect(await installedVersion(m)).toBe('1.0.0');
  });

  it('installs nothing and runs no command when the tarball fails its checksum', async () => {
    const m = await mac();
    const tampered = await makeRelease('1.0.0');
    await writeFile(path.join(tampered, 'checksums.txt'), `${'0'.repeat(64)}  ops-console-darwin-arm64.tar.gz\n`);

    const result = await brewEntry(await makeCellar(tampered, '1.0.0'), m, ['--version']);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/checksum mismatch/);
    expect(result.stdout).not.toMatch(/\d+\.\d+\.\d+/);
    expect(await installedVersion(m)).toBe('');
  });

  it('refuses an install from an x64 formula on an Apple silicon Mac, and installs it on an Intel Mac', async () => {
    const x64 = await makeRelease('1.0.0', 'x64');
    const cellar = await makeCellar(x64, '1.0.0');
    const rosetta = { FAKE_SYSCTL_ARM64: '1', FAKE_UNAME_M: 'x86_64' };

    const refusedMac = await mac();
    const refused = await brewEntry(cellar, refusedMac, ['--version'], rosetta);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('native Homebrew');
    expect(await installedVersion(refusedMac)).toBe('');

    const intel = await mac();
    const ok = await brewEntry(cellar, intel, ['--version'], { FAKE_SYSCTL_ARM64: '0', FAKE_UNAME_M: 'x86_64' });
    expect(ok.code).toBe(0);
    expect(await installedVersion(intel)).toBe('1.0.0');

    // An app that is already installed needs no install, so its commands still run.
    const again = await brewEntry(cellar, intel, ['--version'], rosetta);
    expect(again.code).toBe(0);
    expect(again.stdout.trim()).toBe('1.0.0');
  });

  it('restarts a running daemon on the new version after an upgrade', async () => {
    const m = await mac();
    await brewEntry(await makeCellar(release100, '1.0.0'), m, ['start']);

    const result = await brewEntry(await makeCellar(release110, '1.1.0'), m, ['status']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/version\s+1\.1\.0/);
  });

  it('leaves a stopped daemon stopped after an upgrade', async () => {
    const m = await mac();
    await brewEntry(await makeCellar(release100, '1.0.0'), m, ['--version']);

    const result = await brewEntry(await makeCellar(release110, '1.1.0'), m, ['status']);

    expect(result.code).toBe(3);
    expect(result.stdout).toContain('stopped');
  });
});
