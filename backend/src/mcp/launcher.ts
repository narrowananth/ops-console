import { spawn } from 'node:child_process';
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
  const env = stored === null ? {} : parseEnv(stored);
  const child = spawn(command, argv.slice(dash + 2), { stdio: 'inherit', env: { ...process.env, ...env } });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
  return new Promise<number>((resolve) => {
    child.once('error', () => resolve(127));
    child.once('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
