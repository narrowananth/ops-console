import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  Options,
  SDKMessage,
  SDKPermissionDenial,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentSdk } from '../../src/agent/agent-sdk';

type RateLimit = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  five_hour?: { pct: number; resetsInHours: number };
  seven_day?: { pct: number; resetsInHours: number };
};

/** One scripted step of a run. */
export type Step =
  | { text: string }
  | { tool: string; input: Record<string, unknown>; fails?: string; classifierAsks?: boolean }
  | { rateLimit: RateLimit }
  /** A rate-limit event exactly as given, for shapes a later SDK might send. */
  | { rateLimitInfo: object }
  /** The API refuses the account for its limit; the run ends. */
  | { rejected: true }
  /** Holds the run until the promise settles. */
  | { wait: Promise<unknown> }
  /** The SDK throws, as when the Claude Code process dies. */
  | { crash: string };

export type Call = { prompt: string; options: Options; configDir: string; sessionId: string };

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READS = new Set(['Read', 'Glob', 'Grep']);

/** The project key Claude Code files a working directory's transcripts under. */
const projectKey = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-');

const sdk = (message: object) => message as SDKMessage;

/**
 * Stands in for the Claude Agent SDK. Replays scripted runs the way Claude Code would: transcripts written to the
 * config dir in `CLAUDE_CONFIG_DIR` (or `home`), `PreToolUse` hooks first, then `disallowedTools`, then the
 * permission mode and `canUseTool`, then `PostToolUse` hooks.
 */
export class FakeAgentSdk implements AgentSdk {
  readonly calls: Call[] = [];
  /** Tool calls that ran, with the input they ran with. */
  readonly ran: { tool: string; input: Record<string, unknown> }[] = [];
  private readonly scripts: Step[][] = [];
  /** What the next runs' `init` message says about MCP servers. */
  mcpServers: { name: string; status: string }[] = [];

  constructor(private readonly home: string) {}

  script(...steps: Step[]): void {
    this.scripts.push(steps);
  }

  async *query(prompt: string, options: Options): AsyncGenerator<SDKMessage> {
    const configDir = options.env?.CLAUDE_CONFIG_DIR ?? this.home;
    const sessionId = options.resume ?? crypto.randomUUID();
    const dir = path.join(configDir, 'projects', projectKey(options.cwd ?? ''));
    const file = path.join(dir, `${sessionId}.jsonl`);
    if (options.resume && !existsSync(file)) throw new Error(`No conversation found with session ID: ${sessionId}`);
    this.calls.push({ prompt, options, configDir, sessionId });
    const steps = this.scripts.shift() ?? [{ text: 'Done.' }];
    await mkdir(dir, { recursive: true });

    // A resumed run chains onto the transcript's last entry, as Claude Code does.
    const existing = options.resume ? (await readFile(file, 'utf8')).trim().split('\n') : [];
    let parent: string | null = existing.length ? JSON.parse(existing.at(-1) ?? '{}').uuid : null;
    const write = async (type: 'user' | 'assistant', content: unknown): Promise<string> => {
      const uuid = crypto.randomUUID();
      const message = type === 'user' ? { role: 'user', content } : { role: 'assistant', type: 'message', content };
      const entry = {
        parentUuid: parent,
        isSidechain: false,
        type,
        message,
        uuid,
        timestamp: new Date().toISOString(),
        userType: 'external',
        cwd: options.cwd,
        sessionId,
      };
      await appendFile(file, `${JSON.stringify(entry)}\n`);
      parent = uuid;
      return uuid;
    };
    const assistant = async (content: unknown[], extra: object = {}) =>
      sdk({
        type: 'assistant',
        message: { role: 'assistant', content },
        parent_tool_use_id: null,
        uuid: await write('assistant', content),
        session_id: sessionId,
        ...extra,
      });
    const hooks = async (event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure', input: object, id: string) => {
      const outputs: HookJSONOutput[] = [];
      const matchers: HookCallbackMatcher[] = options.hooks?.[event] ?? [];
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          const hookInput = { hook_event_name: event, session_id: sessionId, cwd: options.cwd, ...input } as HookInput;
          outputs.push(await hook(hookInput, id, { signal: new AbortController().signal }));
        }
      }
      return outputs;
    };

    yield sdk({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      mcp_servers: this.mcpServers,
      uuid: crypto.randomUUID(),
    });
    await write('user', prompt);
    const denials: SDKPermissionDenial[] = [];

    for (const step of steps) {
      if ('wait' in step) {
        await step.wait;
      } else if ('crash' in step) {
        throw new Error(step.crash);
      } else if ('text' in step) {
        const half = Math.ceil(step.text.length / 2);
        const event = (value: object) =>
          sdk({
            type: 'stream_event',
            event: value,
            parent_tool_use_id: null,
            uuid: crypto.randomUUID(),
            session_id: sessionId,
          });
        yield event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        yield event({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: step.text.slice(0, half) },
        });
        yield event({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: step.text.slice(half) },
        });
        yield await assistant([{ type: 'text', text: step.text }]);
      } else if ('rateLimit' in step) {
        const window = (value?: { pct: number; resetsInHours: number }) =>
          value && {
            utilization: value.pct / 100,
            resetsAt: Math.floor(Date.now() / 1000 + value.resetsInHours * 3600),
            status: step.rateLimit.status,
          };
        yield sdk({
          type: 'rate_limit_event',
          rate_limit_info: {
            status: step.rateLimit.status,
            unifiedWindows: {
              five_hour: window(step.rateLimit.five_hour),
              seven_day: window(step.rateLimit.seven_day),
            },
          },
          uuid: crypto.randomUUID(),
          session_id: sessionId,
        });
      } else if ('rateLimitInfo' in step) {
        yield sdk({
          type: 'rate_limit_event',
          rate_limit_info: step.rateLimitInfo,
          uuid: crypto.randomUUID(),
          session_id: sessionId,
        });
      } else if ('rejected' in step) {
        yield sdk({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1 },
          uuid: crypto.randomUUID(),
          session_id: sessionId,
        });
        yield await assistant([{ type: 'text', text: "You've hit your limit" }], { error: 'rate_limit' });
        yield sdk({
          type: 'result',
          subtype: 'success',
          is_error: true,
          permission_denials: denials,
          session_id: sessionId,
        });
        return;
      } else {
        const id = `toolu_${crypto.randomUUID()}`;
        yield await assistant([{ type: 'tool_use', id, name: step.tool, input: step.input }]);
        const result = (content: string, isError: boolean) =>
          write('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }]);
        const deny = async (message: string) => {
          denials.push({ tool_name: step.tool, tool_use_id: id, tool_input: step.input });
          await result(message, true);
        };

        const pre = await hooks('PreToolUse', { tool_name: step.tool, tool_input: step.input, tool_use_id: id }, id);
        const decisions = pre.flatMap((output) =>
          'hookSpecificOutput' in output && output.hookSpecificOutput?.hookEventName === 'PreToolUse'
            ? [output.hookSpecificOutput]
            : [],
        );
        const hookDeny = decisions.find((decision) => decision.permissionDecision === 'deny');
        if (hookDeny) {
          await deny(hookDeny.permissionDecisionReason ?? 'Denied by hook');
          continue;
        }
        if (this.disallowed(options.disallowedTools ?? [], step.tool, step.input)) {
          await deny(`Permission to use ${step.tool} has been denied.`);
          continue;
        }
        let input = step.input;
        const hookAllowed = decisions.some((decision) => decision.permissionDecision === 'allow');
        if (!hookAllowed && this.asks(options.permissionMode ?? 'default', step)) {
          const answer = await options.canUseTool?.(step.tool, input, {
            signal: new AbortController().signal,
            toolUseID: id,
            requestId: crypto.randomUUID(),
          });
          if (!answer || answer.behavior === 'deny') {
            await deny(answer?.message ?? 'denied');
            continue;
          }
          input = answer.updatedInput ?? input;
        }
        this.ran.push({ tool: step.tool, input });
        if (step.fails) {
          await hooks(
            'PostToolUseFailure',
            { tool_name: step.tool, tool_input: input, tool_use_id: id, error: step.fails },
            id,
          );
          await result(step.fails, true);
        } else {
          await hooks(
            'PostToolUse',
            { tool_name: step.tool, tool_input: input, tool_use_id: id, tool_response: 'ok' },
            id,
          );
          await result('ok', false);
        }
      }
    }
    yield sdk({
      type: 'result',
      subtype: 'success',
      is_error: false,
      permission_denials: denials,
      session_id: sessionId,
    });
  }

  /** `Bash(<prefix>:*)` and exact tool names, as Claude Code reads deny rules. */
  private disallowed(rules: string[], tool: string, input: Record<string, unknown>): boolean {
    return rules.some((rule) => {
      const bash = /^Bash\((.+):\*\)$/.exec(rule);
      if (bash)
        return (
          tool === 'Bash' &&
          String(input.command ?? '')
            .trim()
            .startsWith(bash[1] ?? '')
        );
      return rule === tool;
    });
  }

  private asks(mode: string, step: { tool: string; classifierAsks?: boolean }): boolean {
    if (step.tool === 'AskUserQuestion') return true;
    if (READS.has(step.tool)) return false;
    if (mode === 'default') return true;
    if (mode === 'acceptEdits') return !EDITS.has(step.tool);
    if (mode === 'auto') return step.classifierAsks === true;
    return false;
  }
}
