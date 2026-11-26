import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HANDOVER_FLAG } from '../src/keychain/handover';
import { filesBase, launcherArgv, runMcpExec, unwrapLauncher } from '../src/mcp/launcher';
import { NpmPackages } from '../src/mcp/npm-packages';
import { FakeKeychain } from './fakes/keychain';
import { fakeNpm } from './fakes/npm';
import { tempDir } from './helpers';

/** A command that writes its env var and arguments to a file, and prints nothing. */
async function stub(): Promise<{ command: string; out: string }> {
  const dir = await tempDir();
  const out = path.join(dir, 'out.json');
  const script = path.join(dir, 'stub.mjs');
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(out)}, JSON.stringify({ secret: process.env.PGPASSWORD ?? null, args: process.argv.slice(2) }));`,
  );
  return { command: script, out };
}

describe('ops-console mcp-exec', () => {
  it('starts the command with the env vars from the Keychain and prints nothing itself', async () => {
    const keychain = new FakeKeychain();
    await keychain.set('mcp:pg', JSON.stringify({ PGPASSWORD: 'hunter2-secret' }));
    const { command, out } = await stub();
    const write = vi.spyOn(process.stdout, 'write');
    const code = await runMcpExec(['pg', '--', process.execPath, command, 'one', 'two words'], keychain);
    const printed = write.mock.calls.length;
    write.mockRestore();

    expect(code).toBe(0);
    expect(printed).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({ secret: 'hunter2-secret', args: ['one', 'two words'] });
    // The secret reached the child only: this process never got it.
    expect(process.env.PGPASSWORD).toBeUndefined();
  });

  it('writes @file entries to a private folder while the command runs, fills {{files}}, and removes it after', async () => {
    const keychain = new FakeKeychain();
    await keychain.set(
      'mcp:fb',
      JSON.stringify({ '@file:key.json': '{"k":1}', KEY_PATH: '{{files}}/key.json', '@file:../escape': 'no' }),
    );
    const dir = await tempDir();
    const out = path.join(dir, 'out.json');
    const script = path.join(dir, 'files.mjs');
    await writeFile(
      script,
      `import { readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs'; import path from 'node:path';
const file = process.env.KEY_PATH; const folder = process.argv[2];
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ key: readFileSync(file, 'utf8'), mode: (statSync(file).mode & 0o777).toString(8), folderMode: (statSync(folder).mode & 0o777).toString(8), same: path.dirname(file) === folder, names: readdirSync(folder), folder }));`,
    );
    expect(await runMcpExec(['fb', '--', process.execPath, script, '{{files}}'], keychain, await tempDir())).toBe(0);
    const seen = JSON.parse(await readFile(out, 'utf8'));
    expect(seen).toMatchObject({ key: '{"k":1}', mode: '600', folderMode: '700', same: true, names: ['key.json'] });
    // The folder, key included, is gone once the command ends.
    await expect(stat(seen.folder)).rejects.toThrow();
  });

  it('keeps the key files under the data folder, which a run cannot read, and not in the user temp folder', async () => {
    const keychain = new FakeKeychain();
    await keychain.set('mcp:fb', JSON.stringify({ '@file:key.json': '{"k":1}', KEY_PATH: '{{files}}/key.json' }));
    const base = path.join(await tempDir(), 'mcp-files');
    const dir = await tempDir();
    const out = path.join(dir, 'out.json');
    const script = path.join(dir, 'where.mjs');
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(out)}, JSON.stringify({ file: process.env.KEY_PATH }));`,
    );
    expect(await runMcpExec(['fb', '--', process.execPath, script], keychain, base)).toBe(0);
    const { file } = JSON.parse(await readFile(out, 'utf8'));
    expect(file.startsWith(`${base}${path.sep}ops-console-mcp-`)).toBe(true);
    await expect(stat(file)).rejects.toThrow();
  });

  it('puts the files under mcp-files in the data folder by default', () => {
    const was = process.env.OPS_CONSOLE_DATA_DIR;
    process.env.OPS_CONSOLE_DATA_DIR = '/data/ops-console';
    try {
      expect(filesBase()).toBe('/data/ops-console/mcp-files');
    } finally {
      if (was === undefined) delete process.env.OPS_CONSOLE_DATA_DIR;
      else process.env.OPS_CONSOLE_DATA_DIR = was;
    }
  });

  it('waits for a handover that is moving the Keychain items before it reads one', async () => {
    const keychain = new FakeKeychain();
    await keychain.set('mcp:pg', JSON.stringify({ PGPASSWORD: 'hunter2-secret' }));
    const { command, out } = await stub();
    // A live process holds the flag: the parent of this test run.
    const flag = path.join(await tempDir(), HANDOVER_FLAG);
    await writeFile(flag, String(process.ppid));
    const running = runMcpExec(['pg', '--', process.execPath, command], keychain, await tempDir(), flag);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(stat(out)).rejects.toThrow();
    await rm(flag);
    expect(await running).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8')).secret).toBe('hunter2-secret');
  });

  it('runs the command without extra env when the Keychain holds nothing', async () => {
    const { command, out } = await stub();
    expect(await runMcpExec(['pg', '--', process.execPath, command], new FakeKeychain())).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8')).secret).toBeNull();
  });

  it('exits with the command exit code, 127 when it is missing, and 2 on bad usage', async () => {
    const keychain = new FakeKeychain();
    expect(await runMcpExec(['pg', '--', process.execPath, '-e', 'process.exit(7)'], keychain)).toBe(7);
    expect(await runMcpExec(['pg', '--', '/nonexistent/command'], keychain)).toBe(127);
    expect(await runMcpExec(['pg'], keychain)).toBe(2);
  });

  it('writes and reads back the registered form', () => {
    const [command, args] = launcherArgv('/x/ops-console', 'pg', 'npx', ['-y', 'pg']);
    expect(unwrapLauncher('/x/ops-console', command, args)).toEqual({ name: 'pg', command: 'npx', args: ['-y', 'pg'] });
    expect(unwrapLauncher('/other', command, args)).toBeNull();
  });
});

describe('ops-console mcp-exec of npx servers', () => {
  const SPEC = ['npx', '-y', '@bytebase/dbhub@latest', '--transport', 'stdio'];
  const flag = async () => path.join(await tempDir(), HANDOVER_FLAG);
  /** A bin that records its arguments and the secret, after `before`. */
  const recording = (out: string, before = '') =>
    `${before}require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), secret: process.env.DSN ?? null }));`;

  /** Puts a command on PATH that records its arguments, and returns where it writes them. */
  async function onPath(name: string): Promise<{ out: string; restore: () => void }> {
    const dir = await tempDir();
    const out = path.join(dir, `${name}.json`);
    const file = path.join(dir, name);
    await writeFile(file, `#!/usr/bin/env node\n${recording(out)}\n`);
    await chmod(file, 0o755);
    const was = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${was}`;
    return {
      out,
      restore: () => {
        process.env.PATH = was;
      },
    };
  }

  it('starts the installed package, not npx, with the Keychain env and the arguments after the package', async () => {
    const keychain = new FakeKeychain();
    await keychain.set('mcp:pg', JSON.stringify({ DSN: 'postgres://u:hunter2-secret@db.example.com/x' }));
    const out = path.join(await tempDir(), 'out.json');
    const fake = fakeNpm({ script: () => recording(out) });
    const packages = new NpmPackages(await tempDir(), { npm: fake.npm });

    expect(await runMcpExec(['pg', '--', ...SPEC], keychain, await tempDir(), await flag(), packages)).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({
      args: ['--transport', 'stdio'],
      secret: 'postgres://u:hunter2-secret@db.example.com/x',
    });

    await rm(out);
    expect(await runMcpExec(['pg', '--', ...SPEC], keychain, await tempDir(), await flag(), packages)).toBe(0);
    expect(fake.state.installs).toBe(1);
  });

  it('leaves uvx alone', async () => {
    const fake = fakeNpm();
    const uvx = await onPath('uvx');
    try {
      const packages = new NpmPackages(await tempDir(), { npm: fake.npm });
      const argv = ['ch', '--', 'uvx', 'mcp-clickhouse'];
      expect(await runMcpExec(argv, new FakeKeychain(), await tempDir(), await flag(), packages)).toBe(0);
    } finally {
      uvx.restore();
    }
    expect(JSON.parse(await readFile(uvx.out, 'utf8')).args).toEqual(['mcp-clickhouse']);
    expect(fake.calls).toEqual([]);
  });

  it('runs the same npx command as before when the install is not possible', async () => {
    const npx = await onPath('npx');
    try {
      const packages = new NpmPackages(await tempDir(), { npm: fakeNpm({ missing: true }).npm });
      expect(await runMcpExec(['pg', '--', ...SPEC], new FakeKeychain(), await tempDir(), await flag(), packages)).toBe(
        0,
      );
    } finally {
      npx.restore();
    }
    expect(JSON.parse(await readFile(npx.out, 'utf8')).args).toEqual(SPEC.slice(1));
  });

  /** A bin that dies on a missing module the first `failures` times it runs, then records. */
  async function flaky(failures: number) {
    const dir = await tempDir();
    const out = path.join(dir, 'out.json');
    const runs = path.join(dir, 'runs');
    const failing = `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(runs)}, 'x');
if (fs.readFileSync(${JSON.stringify(runs)}, 'utf8').length <= ${failures}) { console.error("Error: Cannot find module 'iconv-lite'"); process.exit(1); }`;
    const fake = fakeNpm({ script: () => recording(out, failing) });
    const packages = new NpmPackages(await tempDir(), { npm: fake.npm });
    return { out, fake, packages, runs: async () => (await readFile(runs, 'utf8').catch(() => '')).length };
  }

  it('installs again and starts once more when the server dies at start for a missing module', async () => {
    const { out, fake, packages, runs } = await flaky(1);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runMcpExec(['pg', '--', ...SPEC], new FakeKeychain(), await tempDir(), await flag(), packages);
    const printed = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    stderr.mockRestore();

    expect(code).toBe(0);
    expect(await runs()).toBe(2);
    expect(fake.state.installs).toBe(2);
    expect(JSON.parse(await readFile(out, 'utf8')).args).toEqual(['--transport', 'stdio']);
    expect(printed).toContain("Cannot find module 'iconv-lite'");
  });

  it('retries only once', async () => {
    const { fake, packages, runs } = await flaky(5);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runMcpExec(['pg', '--', ...SPEC], new FakeKeychain(), await tempDir(), await flag(), packages);
    stderr.mockRestore();
    expect(code).toBe(1);
    expect(await runs()).toBe(2);
    expect(fake.state.installs).toBe(2);
  });

  it('does not retry a server that fails for another reason', async () => {
    const fake = fakeNpm({
      script: () => "console.error('Fatal error: password authentication failed'); process.exit(1);",
    });
    const packages = new NpmPackages(await tempDir(), { npm: fake.npm });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runMcpExec(['pg', '--', ...SPEC], new FakeKeychain(), await tempDir(), await flag(), packages);
    stderr.mockRestore();
    expect(code).toBe(1);
    expect(fake.state.installs).toBe(1);
  });
});
