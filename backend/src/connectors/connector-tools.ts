import { type ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode } from '@ops-console/shared';
import { z } from 'zod';
import { LOGIN_TIMEOUT_MS } from '../claude-cli/claude-cli';
import { ApiError } from '../common/errors';

const run = promisify(execFile);

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** What a browser sign-in printed for the operator: the page to open and, for a device sign-in, the code to enter. */
export type SignInPrompt = { code: string | null; url: string | null };

/** `gh` prints "One-time code (ABCD-1234) copied to clipboard", or "First copy your one-time code: ABCD-1234". */
const ONE_TIME_CODE = /one-time code\W+([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const SIGN_IN_URL = /https:\/\/[^\s"'<>]+/;

export const CONNECTOR_TOOLS = Symbol('CONNECTOR_TOOLS');

/** The outside tools Connectors ride on. Tests replace them with a scripted fake. Every method throws when the tool fails. */
export interface ConnectorTools {
  datadogStatus(): Promise<{ signedIn: boolean; org: string | null }>;
  /**
   * Each login ends when the operator finishes in the browser, or on `signal`. Without a terminal a CLI may only print
   * its sign-in page; `onPrompt` gets the page and any one-time code, so the drawer can show them.
   */
  datadogLogin(site: string, signal: AbortSignal, onPrompt: (prompt: SignInPrompt) => void): Promise<void>;
  /** Whether this `pup` can serve an MCP Server (`pup mcp serve`). */
  datadogHasMcp(): Promise<boolean>;
  /** The signed-in login, or `null` when `gh` is signed out. */
  githubUser(): Promise<string | null>;
  githubLogin(signal: AbortSignal, onPrompt: (prompt: SignInPrompt) => void): Promise<void>;
  /** The token of the `gh` sign-in, or `null` when `gh` is signed out. */
  githubToken(): Promise<string | null>;
  gitlabUser(host: string): Promise<string | null>;
  gitlabLogin(host: string, signal: AbortSignal, onPrompt: (prompt: SignInPrompt) => void): Promise<void>;
  /** Whether a command is on the PATH. */
  installed(command: string): Promise<boolean>;
  /** `brew install <formula>`. */
  install(formula: string): Promise<void>;
}

const datadogStatusSchema = z.object({ authenticated: z.boolean(), org: z.string().nullish() }).loose();

export type ToolBins = { pup: string; gh: string; glab: string };

/** Errors name the tool only: output may hold tokens. */
export class CliConnectorTools implements ConnectorTools {
  constructor(private readonly bins: ToolBins = { pup: 'pup', gh: 'gh', glab: 'glab' }) {}

  async datadogStatus(): Promise<{ signedIn: boolean; org: string | null }> {
    const out = await this.exec(this.bins.pup, ['auth', 'status'], 'pup auth status', [0, 1]);
    const status = datadogStatusSchema.parse(JSON.parse(out));
    return { signedIn: status.authenticated, org: status.org ?? null };
  }

  async datadogLogin(site: string, signal: AbortSignal, onPrompt: (prompt: SignInPrompt) => void): Promise<void> {
    await this.exec(this.bins.pup, ['auth', 'login', '--site', site], 'pup auth login', [0], {
      signal,
      login: true,
      onPrompt,
    });
  }

  async datadogHasMcp(): Promise<boolean> {
    try {
      await run(this.bins.pup, ['mcp', '--help']);
      return true;
    } catch {
      return false;
    }
  }

  async githubUser(): Promise<string | null> {
    try {
      const { stdout } = await run(this.bins.gh, ['api', 'user', '--jq', '.login']);
      return stdout.trim() || null;
    } catch (error) {
      if (typeof (error as { code?: unknown }).code === 'number') return null;
      throw new ApiError(502, ErrorCode.UpstreamFailed, '`gh api user` failed');
    }
  }

  async githubLogin(signal: AbortSignal, onPrompt: (prompt: SignInPrompt) => void): Promise<void> {
    // `--clipboard` copies the one-time code; the drawer shows it too.
    await this.exec(
      this.bins.gh,
      ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'ssh', '--skip-ssh-key', '--clipboard'],
      'gh auth login',
      [0],
      { signal, login: true, onPrompt },
    );
  }

  async githubToken(): Promise<string | null> {
    try {
      const { stdout } = await run(this.bins.gh, ['auth', 'token', '--hostname', 'github.com']);
      return stdout.trim() || null;
    } catch (error) {
      if (typeof (error as { code?: unknown }).code === 'number') return null;
      throw new ApiError(502, ErrorCode.UpstreamFailed, '`gh auth token` failed');
    }
  }

  async gitlabUser(host: string): Promise<string | null> {
    try {
      const { stdout } = await run(this.bins.glab, ['api', 'user', '--hostname', host]);
      const user = z.object({ username: z.string() }).safeParse(JSON.parse(stdout));
      return user.success ? user.data.username : null;
    } catch (error) {
      if (typeof (error as { code?: unknown }).code === 'number') return null;
      throw new ApiError(502, ErrorCode.UpstreamFailed, '`glab api user` failed');
    }
  }

  async gitlabLogin(host: string, signal: AbortSignal, onPrompt: (prompt: SignInPrompt) => void): Promise<void> {
    // Every flag answers a prompt `glab` would otherwise ask, leaving only the browser step.
    const registries = [host, `${host}:443`, `registry.${host}`].join(',');
    await this.exec(
      this.bins.glab,
      [
        'auth',
        'login',
        '--hostname',
        host,
        '--web',
        '--git-protocol',
        'ssh',
        '--container-registry-domains',
        registries,
      ],
      'glab auth login',
      [0],
      { signal, login: true, onPrompt },
    );
  }

  async installed(command: string): Promise<boolean> {
    try {
      await run('/bin/sh', ['-c', 'command -v "$1"', 'sh', command]);
      return true;
    } catch {
      return false;
    }
  }

  async install(formula: string): Promise<void> {
    try {
      await run('brew', ['install', formula], {
        env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' },
        maxBuffer: 10 * 1024 * 1024,
        timeout: INSTALL_TIMEOUT_MS,
      });
    } catch {
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`brew install ${formula}\` failed`);
    }
  }

  private async exec(
    bin: string,
    args: string[],
    what: string,
    exitCodes: number[],
    options: { signal?: AbortSignal; login?: boolean; onPrompt?: (prompt: SignInPrompt) => void } = {},
  ): Promise<string> {
    try {
      const pending = run(bin, args, {
        maxBuffer: 10 * 1024 * 1024,
        signal: options.signal,
        timeout: options.login ? LOGIN_TIMEOUT_MS : 30_000,
      });
      pending.child.stdin?.end();
      if (options.onPrompt) watchPrompt(pending.child, options.onPrompt);
      return (await pending).stdout;
    } catch (error) {
      const { code, stdout } = error as { code?: unknown; stdout?: unknown };
      if (typeof code === 'number' && exitCodes.includes(code) && typeof stdout === 'string') return stdout;
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`${what}\` failed`);
    }
  }
}

/** Calls `onPrompt` each time the output names a new sign-in page or code. */
function watchPrompt(child: ChildProcess, onPrompt: (prompt: SignInPrompt) => void): void {
  let output = '';
  let last: SignInPrompt = { code: null, url: null };
  const read = (chunk: unknown) => {
    output += String(chunk);
    const prompt = { code: ONE_TIME_CODE.exec(output)?.[1] ?? null, url: SIGN_IN_URL.exec(output)?.[0] ?? null };
    if (prompt.code === last.code && prompt.url === last.url) return;
    last = prompt;
    onPrompt(prompt);
  };
  child.stdout?.on('data', read);
  child.stderr?.on('data', read);
}
