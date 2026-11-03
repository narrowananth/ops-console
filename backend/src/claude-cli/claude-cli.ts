import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode, type McpOAuthClient } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { loadPty } from '../terminals/pty';

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
  | {
      name: string;
      transport: 'http' | 'sse';
      url: string;
      headers: Record<string, string>;
      oauth?: McpOAuthClient | null;
    }
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

/** A sign-in started by `authLogin`. */
export type AuthLogin = {
  /** The page to sign in on, from any browser; rejects when the sign-in ends before the CLI prints it. */
  link: Promise<string>;
  /** Hands the CLI the code Anthropic shows after a sign-in through `link`. */
  sendCode: (code: string) => void;
  /** Resolves once signed in; rejects with the CLI's reason when the sign-in fails, is stopped or times out. */
  done: Promise<void>;
};

/**
 * What the shell can hand `claude` that beats the config dir's own sign-in: three credentials, and an API host
 * that answers the account's token with 401 (a gateway expects its own token).
 */
const ENV_CREDENTIALS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

/**
 * The environment for `claude` under a config dir. An added account signs in through its own dir, so shell
 * credentials are dropped: left in, every account reads as signed in and runs bill the shell's login, or fail.
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
            ...(server.oauth
              ? ['--client-id', server.oauth.client_id, '--callback-port', String(server.oauth.callback_port)]
              : []),
            server.name,
            server.url,
          ];
    await this.exec(['mcp', 'add', '--scope', server.scope, ...args], 'mcp add', target);
  }

  async mcpRemove(name: string, scope: McpScope, target: McpTarget): Promise<void> {
    await this.exec(['mcp', 'remove', name, '--scope', scope], 'mcp remove', target);
  }

  /**
   * Opens the browser and ends when the operator finishes the server's sign-in, or on `signal` or the timeout.
   * `claude mcp login` refuses to start without a terminal on stdin, so it runs in a pseudo-terminal.
   */
  async mcpLogin(name: string, configDir: ConfigDir, signal: AbortSignal): Promise<void> {
    const pty = await loadPty();
    const env = Object.fromEntries(
      Object.entries(claudeEnv(configDir)).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const login = pty.spawn(this.bin, ['mcp', 'login', name], { cols: 120, rows: 30, env });
    const stop = () => login.kill();
    const timer = setTimeout(stop, LOGIN_TIMEOUT_MS);
    signal.addEventListener('abort', stop, { once: true });
    // Only the last few lines are kept, for the reason a sign-in failed; earlier ones hold the sign-in URL.
    let tail = '';
    login.onData((data) => {
      tail = (tail + data).slice(-2000);
    });
    const exitCode = await new Promise<number>((resolve) => login.onExit((event) => resolve(event.exitCode)));
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    if (exitCode !== 0) throw new ApiError(502, ErrorCode.UpstreamFailed, loginFailure(tail));
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

  /**
   * Starts Anthropic's sign-in. It ends when someone finishes it, or on `signal` or the timeout. With `openBrowser`
   * the CLI opens a browser tab on this Mac. Without it, the sign-in goes through the link the CLI prints, which
   * works in any browser. Anthropic then shows a one-time code that goes back to the CLI through `sendCode`.
   */
  authLogin(
    configDir: ConfigDir,
    signal: AbortSignal,
    { openBrowser, timeoutMs }: { openBrowser: boolean; timeoutMs: number },
  ): AuthLogin {
    // The CLI runs `$BROWSER <url>` in place of `open`; `true` does nothing.
    const env = openBrowser ? claudeEnv(configDir) : { ...claudeEnv(configDir), BROWSER: 'true' };
    const child = spawn(this.bin, ['auth', 'login', '--claudeai'], { env, signal, timeout: timeoutMs });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    // Only a sign-in through the link takes a pasted code.
    if (openBrowser) child.stdin.end();
    let output = '';
    const link = new Promise<string>((resolve, reject) => {
      const read = (data: Buffer) => {
        output = (output + data.toString()).slice(-4000);
        const url = /visit: (https:\/\/\S+)/.exec(output)?.[1];
        if (url) resolve(url);
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('close', () => reject(new Error('the sign-in ended before it printed a link')));
    });
    link.catch(() => {});
    const done = new Promise<void>((resolve, reject) => {
      // Ends at once on `signal`, as it did before the CLI exits.
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new ApiError(502, ErrorCode.UpstreamFailed, authLoginFailure(output)));
      });
    });
    return {
      link,
      sendCode: (code) => {
        if (child.stdin.writable) child.stdin.write(`${code}\n`);
      },
      done,
    };
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

/** Claude Code's own reason from `claude mcp login` output, URLs dropped; a generic line when it gave none. */
export function loginFailure(output: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
  const plain = output.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const line = plain.match(/Couldn't complete authentication[^\r\n]*/)?.[0];
  return line ? line.replace(/https?:\/\/\S+/g, '<url>').trim() : '`claude mcp login` failed';
}

/** Claude Code's reason from `claude auth login` output, without its "sign in again" advice or URLs. */
export function authLoginFailure(output: string): string {
  const line = output.match(/Login failed: ([^\r\n]*)/)?.[1];
  if (!line) return '`claude auth login` failed';
  return line
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\s*Sign in again[^.]*\./, '')
    .trim();
}

function splitArgs(text: string | undefined): string[] {
  return text?.trim() ? text.trim().split(/\s+/) : [];
}
