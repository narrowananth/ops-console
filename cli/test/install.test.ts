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

  it('makes no link and prints no PATH hint when OPS_CONSOLE_NO_LINK is set, and leaves an existing link alone', async () => {
    const m = await machine(release100, 0);
    const link = path.join(m.home, '.local/bin/ops-console');
    const result = await install(m, { OPS_CONSOLE_NO_LINK: '1' });

    expect(result.code).toBe(0);
    expect(await readlink(path.join(m.installDir, 'current'))).toBe('versions/1.0.0');
    await expect(readlink(link)).rejects.toThrow();
    expect(result.stdout).not.toContain('export PATH');

    await install(m);
    const target = await readlink(link);
    await install(m, { OPS_CONSOLE_NO_LINK: '1', ...fileUrl(release110) });
    expect(await readlink(link)).toBe(target);
  });

  it('installs the x64 tarball on an Intel Mac', async () => {
    const intel = await makeRelease('1.0.0', 'x64');
    const m = await machine(intel, 0);
    const result = await install(m, { FAKE_UNAME_M: 'x86_64' });
    expect(result.code).toBe(0);
    expect(await readlink(path.join(m.installDir, 'current'))).toBe('versions/1.0.0');
  });

  it('installs the arm64 tarball from a shell running under Rosetta', async () => {
    const m = await machine(release100, 0);
    const result = await install(m, { FAKE_UNAME_M: 'x86_64', FAKE_SYSCTL_TRANSLATED: '1' });
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
    ['Linux', 'i686'],
    ['Linux', 'riscv64'],
    ['FreeBSD', 'amd64'],
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

describe('install.sh on Linux', () => {
  const linux = { FAKE_UNAME_S: 'Linux', FAKE_UNAME_M: 'x86_64' };

  it.each([
    ['x86_64', 'x64'],
    ['aarch64', 'arm64'],
  ] as const)('installs the linux-%s tarball under the home folder', async (uname, arch) => {
    const release = await makeRelease('1.0.0', arch, 'linux');
    const m = await machine(release, 0);
    const result = await install(m, { ...linux, FAKE_UNAME_M: uname });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`ops-console-linux-${arch}.tar.gz`);
    expect(await readlink(path.join(m.installDir, 'current'))).toBe('versions/1.0.0');
    expect(await readlink(path.join(m.home, '.local/bin/ops-console'))).toBe(
      path.join(m.installDir, 'current/bin/ops-console'),
    );
  });

  it('refuses a tarball whose checksum does not match, and installs nothing', async () => {
    const release = await makeRelease('1.0.0', 'x64', 'linux');
    await writeFile(path.join(release, 'checksums.txt'), `${'0'.repeat(64)}  ops-console-linux-x64.tar.gz\n`);
    const m = await machine(release, 0);
    const result = await install(m, linux);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/checksum mismatch/);
    await expect(readlink(path.join(m.installDir, 'current'))).rejects.toThrow();
  });

  it('refuses a musl system, naming musl', async () => {
    const m = await machine(await makeRelease('1.0.0', 'x64', 'linux'), 0);
    const result = await install(m, { ...linux, FAKE_LDD: 'musl' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('musl');
    await expect(readlink(path.join(m.installDir, 'current'))).rejects.toThrow();
  });

  it('refuses a glibc older than 2.35, naming the version it found', async () => {
    const m = await machine(await makeRelease('1.0.0', 'x64', 'linux'), 0);
    const result = await install(m, { ...linux, FAKE_LDD: '2.31' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('glibc 2.35 or later');
    expect(result.stderr).toContain('2.31');
  });

  it('accepts glibc 2.35 and a newer major', async () => {
    const m = await machine(await makeRelease('1.0.0', 'x64', 'linux'), 0);
    expect((await install(m, { ...linux, FAKE_LDD: '2.35' })).code).toBe(0);
    expect((await install(m, { ...linux, FAKE_LDD: '3.0' })).code).toBe(0);
  });
});
