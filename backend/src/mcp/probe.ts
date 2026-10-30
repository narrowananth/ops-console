import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv } from '../claude-cli/claude-cli';

export const PROBE = Symbol('PROBE');

export type ProbedServer = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error: string | null;
  tools: string[];
};

/** Asks Claude Code which MCP servers one account's config connects. Tests replace it with a scripted fake. */
export interface Probe {
  /** `cwd` is the folder `local` and `project` scope servers belong to. Throws when Claude Code does not answer. */
  run(configDir: string, cwd: string): Promise<ProbedServer[]>;
}

const TIMEOUT_MS = 30_000;
const POLL_MS = 500;

/**
 * An Agent SDK session under the account's config dir, started with a prompt that never arrives. Claude Code
 * connects the servers in its config and reports each state and tool list; no model turn runs, so no tokens are spent.
 */
export class SdkProbe implements Probe {
  async run(configDir: string, cwd: string): Promise<ProbedServer[]> {
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
        settingSources: ['user', 'local', 'project'],
        settings: { disableAllHooks: true },
        allowedTools: [],
        stderr: () => {},
      },
    });
    try {
      await session.initializationResult();
      for (;;) {
        const servers = await session.mcpServerStatus();
        if (servers.every((server) => server.status !== 'pending') || abort.signal.aborted) {
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
