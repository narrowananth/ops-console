import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Keychain } from '../keychain/keychain';

/** The Keychain key holding a server's env vars, as one JSON object. */
export const secretsKey = (server: string) => `mcp:${server}`;

const envSchema = z.record(z.string(), z.string());

/** The env vars stored under `mcp:<name>`; anything unreadable is no env vars. */
export function parseEnv(stored: string): Record<string, string> {
  try {
    return envSchema.parse(JSON.parse(stored));
  } catch {
    return {};
  }
}

export const LAUNCHER_COMMAND = 'mcp-exec';

/**
 * A stored env key `@file:<name>` holds a file, not an env var: a server that only reads a key from a file path, as
 * Firebase's does, gets it written to a private folder (mode 700, the file 600) while it runs, then removed.
 */
export const FILE_PREFIX = '@file:';

/** Stands for that folder in the server's args and env values. */
export const FILES_DIR = '{{files}}';

/** The env vars and args with the files written out and `FILES_DIR` filled in; `cleanup` removes the folder. */
export async function materialize(
  env: Record<string, string>,
  args: string[],
): Promise<{ env: Record<string, string>; args: string[]; cleanup: () => Promise<void> }> {
  const files = Object.entries(env).filter(([key]) => key.startsWith(FILE_PREFIX));
  if (files.length === 0) return { env, args, cleanup: async () => {} };
  const dir = await mkdtemp(path.join(tmpdir(), 'ops-console-mcp-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    for (const [key, content] of files) {
      const name = key.slice(FILE_PREFIX.length);
      if (name === '' || name !== path.basename(name)) continue;
      await writeFile(path.join(dir, name), content, { mode: 0o600 });
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  const fill = (value: string) => value.split(FILES_DIR).join(dir);
  return {
    env: Object.fromEntries(
      Object.entries(env)
        .filter(([key]) => !key.startsWith(FILE_PREFIX))
        .map(([key, value]) => [key, fill(value)]),
    ),
    args: args.map(fill),
    cleanup,
  };
}

/** The argv `claude mcp add` registers for a stdio server whose env vars the console holds. */
export function launcherArgv(launcher: string, name: string, command: string, args: string[]): [string, string[]] {
  return [launcher, [LAUNCHER_COMMAND, name, '--', command, ...args]];
}

/** The server's own command, with the launcher prefix removed; `null` for a command that is not a launcher call. */
export function unwrapLauncher(
  launcher: string,
  command: string,
  args: string[],
): { name: string; command: string; args: string[] } | null {
  if (command !== launcher || args[0] !== LAUNCHER_COMMAND || args[2] !== '--') return null;
  if (args[1] === undefined || args[3] === undefined) return null;
  return { name: args[1], command: args[3], args: args.slice(4) };
}

/**
 * `ops-console mcp-exec <name> -- <command> [args]`: starts the command with the server's env vars from the
 * Keychain, so secrets reach that process and nothing else. Prints nothing: stdout belongs to the MCP protocol.
 * Resolves with the exit code.
 */
export async function runMcpExec(argv: string[], keychain: Keychain): Promise<number> {
  const dash = argv.indexOf('--');
  const name = argv[0];
  const command = argv[dash + 1];
  if (!name || dash !== 1 || !command) return 2;
  const stored = await keychain.get(secretsKey(name));
  const ready = await materialize(stored === null ? {} : parseEnv(stored), argv.slice(dash + 2));
  const child = spawn(command, ready.args, { stdio: 'inherit', env: { ...process.env, ...ready.env } });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
  const code = await new Promise<number>((resolve) => {
    child.once('error', () => resolve(127));
    child.once('close', (exit, signal) => resolve(exit ?? (signal ? 128 : 1)));
  });
  await ready.cleanup();
  return code;
}
