import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';

const run = promisify(execFile);

export const CLAUDE_CLI = Symbol('CLAUDE_CLI');

export type McpScope = 'local' | 'project' | 'user';
const serverConfigSchema = z.discriminatedUnion('transport', [
  z.object({
    name: z.string(),
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
  }),
  z.object({
    name: z.string(),
    transport: z.enum(['http', 'sse']),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
  }),
]);
export type McpServerConfig = z.infer<typeof serverConfigSchema>;

/** What `claude mcp add` takes. Secrets never go on its command line: Claude Code would keep them in its config. */
export type McpServerToAdd = (
  | { name: string; transport: 'stdio'; command: string; args: string[] }
  | { name: string; transport: 'http' | 'sse'; url: string; headers: Record<string, string> }
) & { scope: McpScope };

/** Which account's config `claude mcp` edits; `cwd` is the directory a `local` scope server belongs to. */
export type McpTarget = { configDir: ConfigDir; cwd?: string };

const authStatusSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().nullish(),
  subscriptionType: z.string().nullish(),
});

export type AuthStatus = { signedIn: boolean; email: string | null; plan: string | null };

/** `null` runs `claude` with the operator's own Claude Code setup; a path sets `CLAUDE_CONFIG_DIR`. */
export type ConfigDir = string | null;

export const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Credentials the shell can hand `claude`; each beats the config dir's own sign-in. */
const ENV_CREDENTIALS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * The environment for `claude` under a config dir. An added account signs in through its own dir, so shell
 * credentials are dropped: left in, every account reads as signed in and runs bill the shell's login.
 */
export function claudeEnv(configDir: ConfigDir): NodeJS.ProcessEnv {
  if (configDir === null) return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  for (const name of ENV_CREDENTIALS) delete env[name];
  return env;
}

/** `claude mcp get` joins args with spaces, so an arg holding a space comes back split. */
export class ClaudeCli {
  constructor(readonly bin = 'claude') {}

  async mcpGet(name: string): Promise<McpServerConfig> {
    const output = await this.exec(['mcp', 'get', name], 'mcp get', { configDir: null });
    const fields = new Map<string, string>();
    const block: Record<string, string> = {};
    let inBlock = false;
    for (const line of output.split('\n')) {
      const nested = /^ {4,}(\S.*)$/.exec(line);
      const field = /^ {2}([A-Za-z]+): ?(.*)$/.exec(line);
      if (nested && inBlock) {
        const pair = /^([^=:]+)(?:=|: )(.*)$/.exec(nested[1] ?? '');
        if (pair) block[(pair[1] ?? '').trim()] = pair[2] ?? '';
      } else if (field) {
        fields.set(field[1] ?? '', field[2] ?? '');
        inBlock = field[1] === 'Environment' || field[1] === 'Headers';
      }
    }
    const type = fields.get('Type');
    return serverConfigSchema.parse(
      type === 'stdio'
        ? { name, transport: 'stdio', command: fields.get('Command'), args: splitArgs(fields.get('Args')), env: block }
        : { name, transport: type, url: fields.get('URL'), headers: block },
    );
  }

  async mcpAdd(server: McpServerToAdd, target: McpTarget): Promise<void> {
    const args =
      server.transport === 'stdio'
        ? [server.name, '--', server.command, ...server.args]
        : [
            '--transport',
            server.transport,
            ...Object.entries(server.headers).flatMap(([key, value]) => ['--header', `${key}: ${value}`]),
            server.name,
            server.url,
          ];
    await this.exec(['mcp', 'add', '--scope', server.scope, ...args], 'mcp add', target);
  }

  async mcpRemove(name: string, scope: McpScope, target: McpTarget): Promise<void> {
    await this.exec(['mcp', 'remove', name, '--scope', scope], 'mcp remove', target);
  }

  /** Opens the browser and ends when the operator finishes the server's sign-in, or on `signal` or the timeout. */
  async mcpLogin(name: string, configDir: ConfigDir, signal: AbortSignal): Promise<void> {
    const login = run(this.bin, ['mcp', 'login', name], {
      env: claudeEnv(configDir),
      signal,
      timeout: LOGIN_TIMEOUT_MS,
    });
    login.child.stdin?.end();
    try {
      await login;
    } catch {
      throw new ApiError(502, ErrorCode.UpstreamFailed, '`claude mcp login` failed');
    }
  }

  async mcpLogout(name: string, configDir: ConfigDir): Promise<void> {
    await this.exec(['mcp', 'logout', name], 'mcp logout', { configDir });
  }

  async authStatus(configDir: ConfigDir): Promise<AuthStatus> {
    // Signed out exits 1, with the same JSON on stdout.
    const output = await this.exec(['auth', 'status', '--json'], 'auth status', { configDir }, [0, 1]);
    const status = authStatusSchema.parse(JSON.parse(output));
    return { signedIn: status.loggedIn, email: status.email ?? null, plan: status.subscriptionType ?? null };
  }

  /** Opens the browser and ends when the operator finishes Anthropic's sign-in, or on `signal` or the timeout. */
  async authLogin(configDir: ConfigDir, signal: AbortSignal): Promise<void> {
    const login = run(this.bin, ['auth', 'login', '--claudeai'], {
      env: claudeEnv(configDir),
      signal,
      timeout: LOGIN_TIMEOUT_MS,
    });
    login.child.stdin?.end();
    await login;
  }

  async authLogout(configDir: ConfigDir): Promise<void> {
    await this.exec(['auth', 'logout'], 'auth logout', { configDir });
  }

  /** Errors name the subcommand only: arguments and output may hold secrets. */
  private async exec(
    args: string[],
    subcommand: string,
    { configDir, cwd }: McpTarget,
    exitCodes = [0],
  ): Promise<string> {
    try {
      const { stdout } = await run(this.bin, args, { maxBuffer: 10 * 1024 * 1024, env: claudeEnv(configDir), cwd });
      return stdout;
    } catch (error) {
      const { code, stdout } = error as { code?: unknown; stdout?: unknown };
      if (typeof code === 'number' && exitCodes.includes(code) && typeof stdout === 'string') return stdout;
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`claude ${subcommand}\` failed (${String(code)})`);
    }
  }
}

function splitArgs(text: string | undefined): string[] {
  return text?.trim() ? text.trim().split(/\s+/) : [];
}
