import { type Options, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv } from '../claude-cli/claude-cli';

export const PROBE = Symbol('PROBE');

export type ProbedServer = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error: string | null;
  tools: string[];
};

/** One server, as `one` connects it on its own. */
export type OneServer =
  | { name: string; transport: 'http' | 'sse'; url: string; headers: Record<string, string> }
  | { name: string; transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string };

/** Asks Claude Code which MCP servers one account's config connects. Tests replace it with a scripted fake. */
export interface Probe {
  /** `cwd` is the folder `local` and `project` scope servers belong to. Throws when Claude Code does not answer. */
  run(configDir: string, cwd: string): Promise<ProbedServer[]>;
  /**
   * Connects one server alone, with the account's stored sign-in: seconds, where `run` starts every server in the
   * config. Throws when Claude Code does not answer.
   */
  one(configDir: string, server: OneServer): Promise<ProbedServer>;
}

/** How long servers get to connect; a server still starting then reads `pending`, the rest as they stand. */
const WAIT_MS = 30_000;
/** Ends a session that does not answer at all, such as one stuck before init. */
const TIMEOUT_MS = WAIT_MS + 15_000;
const POLL_MS = 500;

/**
 * An Agent SDK session under the account's config dir, started with a prompt that never arrives. Claude Code
 * connects the servers in its config and reports each state and tool list; no model turn runs, so no tokens are spent.
 */
export class SdkProbe implements Probe {
  run(configDir: string, cwd: string): Promise<ProbedServer[]> {
    return this.ask(configDir, cwd, { settingSources: ['user', 'local', 'project'] });
  }

  async one(configDir: string, server: OneServer): Promise<ProbedServer> {
    const config =
      server.transport === 'stdio'
        ? { type: 'stdio' as const, command: server.command, args: server.args, env: server.env }
        : { type: server.transport, url: server.url, headers: server.headers };
    const servers = await this.ask(configDir, server.transport === 'stdio' ? server.cwd : process.cwd(), {
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { [server.name]: config },
    });
    const found = servers.find((item) => item.name === server.name);
    if (!found) throw new Error(`Claude Code did not load ${server.name}`);
    return found;
  }

  private async ask(configDir: string, cwd: string, options: Partial<Options>): Promise<ProbedServer[]> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    const idle = (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }));
    })();
    const session = query({
      prompt: idle,
      options: {
        abortController: abort,
        cwd,
        env: claudeEnv(configDir),
        persistSession: false,
        settings: { disableAllHooks: true },
        allowedTools: [],
        stderr: () => {},
        ...options,
      },
    });
    try {
      await session.initializationResult();
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const servers = await session.mcpServerStatus();
        if (servers.every((server) => server.status !== 'pending') || Date.now() >= deadline) {
          return servers.map((server) => ({
            name: server.name,
            status: server.status,
            error: server.error ? (server.error.split('\n')[0] ?? '').slice(0, 200) : null,
            tools: (server.tools ?? []).map((tool) => tool.name),
          }));
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
}
