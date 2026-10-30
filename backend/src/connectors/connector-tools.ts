import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode } from '@ops-console/shared';
import { z } from 'zod';
import { LOGIN_TIMEOUT_MS } from '../claude-cli/claude-cli';
import { ApiError } from '../common/errors';

const run = promisify(execFile);

export const CONNECTOR_TOOLS = Symbol('CONNECTOR_TOOLS');

/** The outside tools Connectors ride on. Tests replace them with a scripted fake. Every method throws when the tool fails. */
export interface ConnectorTools {
  datadogStatus(): Promise<{ signedIn: boolean; org: string | null }>;
  /** Opens the browser and ends when the operator finishes, or on `signal`. */
  datadogLogin(site: string, signal: AbortSignal): Promise<void>;
  /** Whether this `pup` can serve an MCP Server (`pup mcp serve`). */
  datadogHasMcp(): Promise<boolean>;
  /** The signed-in login, or `null` when `gh` is signed out. */
  githubUser(): Promise<string | null>;
  githubLogin(signal: AbortSignal): Promise<void>;
  gitlabUser(host: string): Promise<string | null>;
  /** The token goes to `glab` on stdin, never on its command line. */
  gitlabLogin(host: string, token: string): Promise<void>;
  /** The Bitbucket username the token belongs to, or `null` when it is refused. */
  bitbucketUser(token: string): Promise<string | null>;
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

  async datadogLogin(site: string, signal: AbortSignal): Promise<void> {
    await this.exec(this.bins.pup, ['auth', 'login', '--site', site], 'pup auth login', [0], { signal, login: true });
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

  async githubLogin(signal: AbortSignal): Promise<void> {
    // `--clipboard` puts the one-time code on the clipboard: there is no terminal to print it in.
    await this.exec(
      this.bins.gh,
      ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'ssh', '--skip-ssh-key', '--clipboard'],
      'gh auth login',
      [0],
      { signal, login: true },
    );
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

  async gitlabLogin(host: string, token: string): Promise<void> {
    const login = run(this.bins.glab, ['auth', 'login', '--stdin', '--hostname', host]);
    login.child.stdin?.end(`${token}\n`);
    try {
      await login;
    } catch {
      throw new ApiError(502, ErrorCode.UpstreamFailed, '`glab auth login` failed');
    }
  }

  async bitbucketUser(token: string): Promise<string | null> {
    const response = await fetch('https://api.bitbucket.org/2.0/user', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new ApiError(502, ErrorCode.UpstreamFailed, 'the Bitbucket API failed');
    const user = z
      .object({ nickname: z.string().optional(), username: z.string().optional() })
      .parse(await response.json());
    return user.username ?? user.nickname ?? null;
  }

  private async exec(
    bin: string,
    args: string[],
    what: string,
    exitCodes: number[],
    options: { signal?: AbortSignal; login?: boolean } = {},
  ): Promise<string> {
    try {
      const pending = run(bin, args, {
        maxBuffer: 10 * 1024 * 1024,
        signal: options.signal,
        timeout: options.login ? LOGIN_TIMEOUT_MS : 30_000,
      });
      pending.child.stdin?.end();
      return (await pending).stdout;
    } catch (error) {
      const { code, stdout } = error as { code?: unknown; stdout?: unknown };
      if (typeof code === 'number' && exitCodes.includes(code) && typeof stdout === 'string') return stdout;
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`${what}\` failed`);
    }
  }
}
