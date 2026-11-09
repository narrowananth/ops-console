import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Keychain } from '../keychain/keychain';

/** The Keychain key holding a server's env vars, as one JSON object. */
export const secretsKey = (server: string) => `mcp:${server}`;

const envSchema = z.record(z.string(), z.string());

/** One env var stored for the MCP Server `server`, or null when the server has none or it is unreadable. */
export async function storedEnvVar(keychain: Keychain, server: string, name: string): Promise<string | null> {
  const stored = await keychain.get(secretsKey(server));
  return stored === null ? null : (parseEnv(stored)[name] ?? null);
}

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

/**
 * Where those files go: a folder under the data folder, which the Run sandbox denies reading (ADR 0006), not the user
 * temp folder a run's commands can list. The data folder is where the daemon keeps `runtime.json`.
 */
export function filesBase(): string {
  const dataDir =
    process.env.OPS_CONSOLE_DATA_DIR ?? path.join(homedir(), 'Library', 'Application Support', 'ops-console');
  return path.join(path.resolve(dataDir), 'mcp-files');
}

/** The env vars and args with the files written out and `FILES_DIR` filled in; `cleanup` removes the folder. */
export async function materialize(
  env: Record<string, string>,
  args: string[],
  base: string = tmpdir(),
): Promise<{ env: Record<string, string>; args: string[]; cleanup: () => Promise<void> }> {
  const files = Object.entries(env).filter(([key]) => key.startsWith(FILE_PREFIX));
  if (files.length === 0) return { env, args, cleanup: async () => {} };
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(path.join(base, 'ops-console-mcp-'));
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
export async function runMcpExec(argv: string[], keychain: Keychain, base: string = filesBase()): Promise<number> {
  const dash = argv.indexOf('--');
  const name = argv[0];
  const command = argv[dash + 1];
  if (!name || dash !== 1 || !command) return 2;
  const stored = await keychain.get(secretsKey(name));
  const ready = await materialize(stored === null ? {} : parseEnv(stored), argv.slice(dash + 2), base);
  // Every run starts every Connection's server through `npx …@latest`; asking the npm registry each time costs CPU and
  // a round trip per server. Cached packages are used as they are, and a missing one is still fetched.
  const quiet = { npm_config_prefer_offline: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false' };
  const child = spawn(command, ready.args, { stdio: 'inherit', env: { ...quiet, ...process.env, ...ready.env } });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
  const code = await new Promise<number>((resolve) => {
    child.once('error', () => resolve(127));
    child.once('close', (exit, signal) => resolve(exit ?? (signal ? 128 : 1)));
  });
  await ready.cleanup();
  return code;
}
