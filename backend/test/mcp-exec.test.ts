import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { launcherArgv, runMcpExec, unwrapLauncher } from '../src/mcp/launcher';
import { FakeKeychain } from './fakes/keychain';
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
