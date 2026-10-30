import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv } from '../claude-cli/claude-cli';

export const USAGE_SOURCE = Symbol('USAGE_SOURCE');

/** One usage window: percent used (0 to 100) and when it resets. */
export type UsageWindow = { pct: number; resetsAt: string };

export type UsageReading = { fiveHour: UsageWindow | null; weekly: UsageWindow | null };

/** Reads an account's current usage. Tests replace it with a scripted fake. */
export interface UsageSource {
  /** `null` when the account has no plan limits (signed out, API key). Throws when Claude does not answer. */
  read(configDir: string): Promise<UsageReading | null>;
}

const TIMEOUT_MS = 20_000;

/**
 * The `/usage` numbers, asked of a Claude Code process under the account's config dir through the SDK's usage
 * request. The process starts with a prompt that never arrives, so nothing reaches the model and no quota is spent,
 * and the console never touches the account's token: Claude Code reads it and makes the request itself.
 */
export class SdkUsageSource implements UsageSource {
  async read(configDir: string): Promise<UsageReading | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    const idle = (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }));
    })();
    const probe = query({
      prompt: idle,
      options: {
        abortController: abort,
        env: claudeEnv(configDir),
        persistSession: false,
        settingSources: [],
        settings: { disableAllHooks: true },
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        stderr: () => {},
      },
    });
    try {
      await probe.initializationResult();
      const usage = await probe.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      if (!usage.rate_limits_available || !usage.rate_limits) return null;
      const { five_hour: fiveHour, seven_day: weekly } = usage.rate_limits;
      const windowOf = (window: typeof fiveHour): UsageWindow | null =>
        window?.utilization != null && window.resets_at
          ? { pct: window.utilization, resetsAt: new Date(window.resets_at).toISOString() }
          : null;
      return { fiveHour: windowOf(fiveHour), weekly: windowOf(weekly) };
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
}
