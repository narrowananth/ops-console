import { readdir, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { install, machine, makeRelease, opsConsole } from './helpers';

let release100: string;
let release110: string;
let release120: string;

beforeAll(async () => {
  [release100, release110, release120] = await Promise.all([
    makeRelease('1.0.0'),
    makeRelease('1.1.0'),
    makeRelease('1.2.0'),
  ]);
});

const fileUrl = (dir: string) => ({ OPS_CONSOLE_RELEASE_URL: `file://${dir}` });

describe('install.sh', () => {
  it('installs a checked release under the home folder and links the command', async () => {
    const m = await machine(release100, 0);
    const result = await install(m);

    expect(result.code).toBe(0);
    expect(await readlink(path.join(m.installDir, 'current'))).toBe('versions/1.0.0');
    expect(await readlink(path.join(m.home, '.local/bin/ops-console'))).toBe(
      path.join(m.installDir, 'current/bin/ops-console'),
    );
    expect(result.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect((await opsConsole(m, '--version')).stdout.trim()).toBe('1.0.0');
  });

  it('says nothing about PATH when ~/.local/bin is already on it', async () => {
    const m = await machine(release100, 0);
    const result = await install(m, { PATH: `${path.join(m.home, '.local/bin')}:${m.env.PATH}` });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('export PATH');
  });

  it('installs the x64 tarball on an Intel Mac', async () => {
    const intel = await makeRelease('1.0.0', 'x64');
    const m = await machine(intel, 0);
    const result = await install(m, { FAKE_UNAME_M: 'x86_64' });
    expect(result.code).toBe(0);
    expect(await readlink(path.join(m.installDir, 'current'))).toBe('versions/1.0.0');
  });

  it('refuses a tarball whose checksum does not match, and leaves current alone', async () => {
    const m = await machine(release100, 0);
    await install(m);
    const tampered = await makeRelease('1.1.0');
    await writeFile(path.join(tampered, 'checksums.txt'), `${'0'.repeat(64)}  ops-console-darwin-arm64.tar.gz\n`);

    const result = await install(m, fileUrl(tampered));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/checksum mismatch/);
    expect(await readdir(path.join(m.installDir, 'versions'))).toEqual(['1.0.0']);
    expect(await readlink(path.join(m.installDir, 'current'))).toBe('versions/1.0.0');
  });

  it('refuses a release with no checksum for the tarball', async () => {
    const m = await machine(release100, 0);
    await install(m);
    const unsigned = await makeRelease('1.1.0');
    await writeFile(path.join(unsigned, 'checksums.txt'), '');

    const result = await install(m, fileUrl(unsigned));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/no entry/);
    expect(await readdir(path.join(m.installDir, 'versions'))).toEqual(['1.0.0']);
    expect(await readlink(path.join(m.installDir, 'current'))).toBe('versions/1.0.0');
  });

  it.each([
    ['Linux', 'x86_64'],
    ['Darwin', 'i386'],
  ])('refuses %s %s, naming the platform', async (os, cpu) => {
    const m = await machine(release100, 0);
    const result = await install(m, { FAKE_UNAME_S: os, FAKE_UNAME_M: cpu });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`${os} ${cpu}`);
  });

  it('keeps the previous version when the current one is installed again', async () => {
    const m = await machine(release100, 0);
    await install(m);
    await install(m, fileUrl(release110));
    await install(m, fileUrl(release110));

    expect((await readdir(path.join(m.installDir, 'versions'))).sort()).toEqual(['1.0.0', '1.1.0']);
    expect(await readlink(path.join(m.installDir, 'current'))).toBe('versions/1.1.0');
  });

  it('keeps the current and previous versions and removes older ones', async () => {
    const m = await machine(release100, 0);
    await install(m);
    await install(m, fileUrl(release110));
    await install(m, fileUrl(release120));

    expect((await readdir(path.join(m.installDir, 'versions'))).sort()).toEqual(['1.1.0', '1.2.0']);
    expect(await readlink(path.join(m.installDir, 'current'))).toBe('versions/1.2.0');
    expect((await opsConsole(m, '--version')).stdout.trim()).toBe('1.2.0');
  });
});
