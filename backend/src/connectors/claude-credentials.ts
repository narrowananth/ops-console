import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);

export const CLAUDE_CREDENTIALS = Symbol('CLAUDE_CREDENTIALS');

/** The Keychain item Claude Code keeps its sign-ins in. It holds Claude's own sign-in too: only `mcpOAuth` is read. */
const SERVICE = 'Claude Code-credentials';

/** An access token Claude Code stored for an MCP server, with when it ends in ms since the epoch; null when it is unknown. */
export type StoredToken = { accessToken: string; expiresAt: number | null };

/**
 * The sign-in Claude Code stored for an MCP server. The console reads it and never writes or refreshes it, so Claude
 * Code stays the only one that refreshes (ADR 0005). Tests replace it.
 */
export interface ClaudeCredentials {
  /** The token for the server registered under `name` at `url`; null when Claude Code holds none, or macOS refused the read. */
  mcpToken(name: string, url: string): Promise<StoredToken | null>;
}

const entrySchema = z.object({
  serverName: z.string(),
  serverUrl: z.string().optional(),
  accessToken: z.string().optional(),
  expiresAt: z.number().optional(),
});
const itemSchema = z.object({ mcpOAuth: z.record(z.string(), entrySchema).optional() });

/** A stored expiry is milliseconds; a value that small is seconds. */
const asMilliseconds = (at: number): number => (at < 1e11 ? at * 1000 : at);

const sameUrl = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** Claude Code's item in the login Keychain, read through the `security` tool. The first read shows a macOS prompt. */
export class MacClaudeCredentials implements ClaudeCredentials {
  async mcpToken(name: string, url: string): Promise<StoredToken | null> {
    if (process.platform !== 'darwin') return null;
    let raw: string;
    try {
      const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-w'], {
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      raw = stdout;
    } catch {
      // Not found, or the operator refused the prompt.
      return null;
    }
    const item = itemSchema.safeParse(safeJson(raw));
    if (!item.success) return null;
    const entry = Object.values(item.data.mcpOAuth ?? {}).find(
      (found) => found.serverName === name && found.serverUrl !== undefined && sameUrl(found.serverUrl, url),
    );
    if (entry?.accessToken === undefined || entry.accessToken === '') return null;
    return { accessToken: entry.accessToken, expiresAt: entry.expiresAt ? asMilliseconds(entry.expiresAt) : null };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}
