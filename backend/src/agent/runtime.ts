import type {
  CanUseTool,
  EffortLevel,
  HookCallback,
  HookJSONOutput,
  Options,
  PermissionMode,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AccessMode,
  ActionKind,
  ActionOutcome,
  ApprovalKind,
  ApprovalStatus,
  Effort,
  ErrorCode,
  type Message,
  type Part,
  SessionState,
} from '@ops-console/shared';
import { eq, inArray } from 'drizzle-orm';
import { type AccountRow, AccountsService, rateLimitInfoSchema } from '../accounts/accounts.service';
import { ActionLogService } from '../action-log/action-log.service';
import { type ApprovalRequest, ApprovalsService, type Decision } from '../action-log/approvals.service';
import { classifyCall } from '../action-log/classify';
import { redact } from '../action-log/redact';
import { claudeEnv } from '../claude-cli/claude-cli';
import { ApiError } from '../common/errors';
import { StartupRecovery } from '../common/recovery';
import { disabledMcpServers, nowIso, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { AGENT_CONFIG, type AgentConfig } from './agent-config';
import { MessageInterceptors } from './message-interceptors';
import { blockParts, contentSchema, EDIT_TOOLS, questionInputSchema, stepText, toMessages } from './parts';
import { ProdWriteRule } from './prod-write-rule';
import { type Run, RunRegistry, type RunSummary } from './runs';
import { SessionKinds } from './session-kinds';
import { emitSessionUpdated, NEW_SESSION_TITLE, SessionsService } from './sessions.service';
import { Transcripts } from './transcripts';

const PERMISSION_MODES: Record<AccessMode, PermissionMode> = {
  [AccessMode.Supervised]: 'default',
  [AccessMode.AcceptEdits]: 'acceptEdits',
  [AccessMode.Auto]: 'auto',
  [AccessMode.Full]: 'bypassPermissions',
};

const SDK_EFFORT: Record<Effort, EffortLevel> = {
  [Effort.Low]: 'low',
  [Effort.Medium]: 'medium',
  [Effort.High]: 'high',
  [Effort.XHigh]: 'xhigh',
  [Effort.Max]: 'max',
  [Effort.Ultrathink]: 'max',
};

/** No Session can merge (ADR 0002). `disallowedTools` holds in every permission mode, `bypassPermissions` included. */
export const MERGE_DENIALS = [
  'Bash(gh pr merge:*)',
  'Bash(glab mr merge:*)',
  'mcp__github__merge_pull_request',
  'mcp__gitlab__merge_merge_request',
];

type RunResult = 'done' | ErrorCode.RateLimited | ErrorCode.UpstreamFailed;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The text of a part with its fences restored; steps and diffs have none. */
const partText = (part: Part): string =>
  part.kind === 'text' ? part.text : part.kind === 'code' ? `\`\`\`${part.lang}\n${part.text}\n\`\`\`` : '';

const firstLine = (text: string, max: number) => (text.trim().split('\n')[0] ?? '').slice(0, max);

/** Runs Sessions on the Claude Agent SDK: one run per Session at a time, Sessions side by side. */
@Injectable()
export class AgentRuntime {
  private readonly logger = new Logger('agent');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(AGENT_CONFIG) private readonly config: AgentConfig,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(RunRegistry) private readonly runs: RunRegistry,
    @Inject(SessionKinds) private readonly kinds: SessionKinds,
    @Inject(ProdWriteRule) private readonly prodWrites: ProdWriteRule,
    @Inject(Transcripts) private readonly transcripts: Transcripts,
    @Inject(MessageInterceptors) private readonly interceptors: MessageInterceptors,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('agent sessions and approvals', () => this.recover());
  }

  /** A run does not survive a restart: its Session fails and its Approvals expire (Behavior 18). */
  private recover(): void {
    this.store.write((tx, emit) => {
      const interrupted = tx
        .update(sessions)
        .set({ state: SessionState.Failed })
        .where(inArray(sessions.state, [SessionState.Working, SessionState.WaitingInput, SessionState.WaitingApproval]))
        .returning()
        .all();
      for (const row of interrupted) emitSessionUpdated(emit, row);
    });
    this.approvals.expirePending();
  }

  /**
   * Starts a run, or answers the agent's open question. The reply streams as `session.output` under the returned
   * message id.
   */
  send(sessionId: string, text: string): { message_id: string } {
    const session = this.sessions.get(sessionId);
    const kind = this.kinds.get(session.kind);
    if (!kind?.acceptsMessages) {
      throw new ApiError(409, ErrorCode.InvalidState, `a ${session.kind} session takes no messages`);
    }
    const current = this.runs.get(sessionId);
    if (current?.answer) {
      current.answer(text);
      return { message_id: current.messageId };
    }
    if (this.interceptors.handle(session, text)) return { message_id: crypto.randomUUID() };
    return { message_id: this.begin(sessionId, text, null).messageId };
  }

  /**
   * Starts a run the console asks for itself, in a Session that takes no operator messages. Throws `session_busy`
   * while the Session's run is going; `finished` settles when the run ends.
   */
  runFor(
    sessionId: string,
    text: string,
    onPart: ((part: Part) => void) | null = null,
  ): { finished: Promise<RunSummary> } {
    let settle: (summary: RunSummary) => void = () => {};
    const finished = new Promise<RunSummary>((resolve) => {
      settle = resolve;
    });
    this.begin(sessionId, text, settle, onPart);
    return { finished };
  }

  private begin(
    sessionId: string,
    text: string,
    onFinish: ((summary: RunSummary) => void) | null,
    onPart: ((part: Part) => void) | null = null,
  ): Run {
    const session = this.sessions.get(sessionId);
    const kind = this.kinds.get(session.kind);
    if (!kind) throw new ApiError(409, ErrorCode.InvalidState, `a ${session.kind} session cannot run`);
    if (this.runs.get(sessionId)) throw new ApiError(409, ErrorCode.SessionBusy, "the session's run is still going");
    const run: Run = {
      sessionId,
      messageId: crypto.randomUUID(),
      accountId: this.accounts.active().id,
      workingDir: kind.workingDir(session),
      parts: [],
      growing: null,
      sdkUuids: new Set(),
      toolRows: new Map(),
      answer: null,
      waits: 0,
      createdAt: new Date().toISOString(),
      onFinish,
      onPart,
    };
    this.runs.add(run);
    const isFirst = session.title === NEW_SESSION_TITLE && session.sdkSessionId === null;
    this.sessions.write(sessionId, {
      state: SessionState.Working,
      title: isFirst ? firstLine(text, 60) || NEW_SESSION_TITLE : session.title,
      lastActiveAt: new Date().toISOString(),
    });
    void this.execute(run, text);
    return run;
  }

  /** The transcript, oldest first, with the in-flight message last while a run streams. */
  async messages(sessionId: string): Promise<Message[]> {
    const session = this.sessions.get(sessionId);
    const run = this.runs.get(sessionId);
    const kind = this.kinds.get(session.kind);
    let messages: Message[] = [];
    if (session.sdkSessionId !== null && session.accountId !== null && kind) {
      const configDir = this.accounts.configDir(this.accounts.get(session.accountId));
      const entries = await this.transcripts.read(session.sdkSessionId, kind.workingDir(session), configDir);
      messages = toMessages(entries, run?.sdkUuids);
    }
    const last = messages.at(-1);
    if (!run && session.state === SessionState.Failed && last?.role === 'agent') last.status = 'failed';
    if (run) {
      messages.push({
        id: run.messageId,
        role: 'agent',
        status: 'streaming',
        parts: [...run.parts],
        created_at: run.createdAt,
      });
    }
    return messages;
  }

  private async execute(run: Run, text: string): Promise<void> {
    let result: RunResult;
    try {
      let account = this.accounts.get(run.accountId);
      result = await this.runOnce(run, text, account);
      // A run rejected for a limit resumes once, on the account Auto-switch picks (Behavior 26).
      const next = result === ErrorCode.RateLimited ? this.accounts.switchAfterRejection(account.id) : null;
      if (next) {
        account = next;
        run.accountId = next.id;
        result = await this.runOnce(run, text, account);
      }
    } catch (error) {
      this.logger.error(
        `run of session ${run.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      result = ErrorCode.UpstreamFailed;
    }
    this.finish(run, result);
  }

  private async runOnce(run: Run, text: string, account: AccountRow): Promise<RunResult> {
    const session = this.sessions.get(run.sessionId);
    const configDir = this.accounts.configDir(account);
    let resume = session.sdkSessionId;
    if (resume !== null) {
      // The conversation carries over: its transcript moves into the account the run uses (Behavior 23).
      if (session.accountId !== null && session.accountId !== account.id) {
        const from = this.accounts.configDir(this.accounts.get(session.accountId));
        await this.transcripts.copy(resume, from, configDir);
      }
      // A transcript deleted outside the console starts a new SDK session (Behavior 6).
      if (!(await this.transcripts.exists(resume, configDir))) resume = null;
    }
    if (session.accountId !== account.id) this.sessions.write(run.sessionId, { accountId: account.id });

    const options: Options = {
      cwd: run.workingDir,
      model: session.model,
      effort: SDK_EFFORT[session.effort],
      permissionMode: PERMISSION_MODES[session.accessMode],
      allowDangerouslySkipPermissions: session.accessMode === AccessMode.Full,
      ...(resume === null ? {} : { resume }),
      env: claudeEnv(configDir),
      includePartialMessages: true,
      disallowedTools: MERGE_DENIALS,
      // Servers the operator disabled stay out of the run.
      settings: {
        deniedMcpServers: this.store.db
          .select()
          .from(disabledMcpServers)
          .all()
          .map(({ name }) => ({ serverName: name })),
      },
      hooks: {
        PreToolUse: [{ hooks: [this.beforeTool(run)] }],
        PostToolUse: [{ hooks: [this.afterTool(run)] }],
        PostToolUseFailure: [{ hooks: [this.afterTool(run)] }],
      },
      canUseTool: this.permissionPrompt(run),
    };

    let rejected = false;
    let failed = false;
    try {
      for await (const message of this.config.sdk.query(text, options)) {
        if (message.type === 'rate_limit_event') {
          // An event whose shape changed in an SDK release leaves the last usage in place (Not required: exact usage).
          const info = rateLimitInfoSchema.safeParse(message.rate_limit_info);
          if (info.success) {
            this.accounts.recordUsage(account.id, info.data);
            rejected ||= info.data.status === 'rejected';
          }
        } else if (message.type === 'result') {
          for (const denial of message.permission_denials) {
            const row = run.toolRows.get(denial.tool_use_id);
            if (row) this.actionLog.finish(row, ActionOutcome.Denied);
          }
          failed = message.is_error;
        } else {
          rejected ||= message.type === 'assistant' && message.error === 'rate_limit';
          this.stream(run, message);
        }
      }
    } catch (error) {
      if (!rejected) throw error;
    }
    for (const row of run.toolRows.values()) this.actionLog.finish(row, ActionOutcome.Failed, 'no result');
    if (rejected) return ErrorCode.RateLimited;
    return failed ? ErrorCode.UpstreamFailed : 'done';
  }

  /** Turns SDK messages into parts. Text grows from stream deltas, then is replaced by its finished block. */
  private stream(run: Run, message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      const session = this.sessions.get(run.sessionId);
      if (session.sdkSessionId !== message.session_id) {
        this.sessions.write(run.sessionId, { sdkSessionId: message.session_id });
      }
      return;
    }
    if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
      const event = message.event;
      if (event.type === 'content_block_start' && event.content_block.type === 'text') {
        run.growing = run.parts.push({ kind: 'text', text: '' }) - 1;
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && run.growing !== null) {
        const part = run.parts[run.growing];
        if (part?.kind === 'text') {
          part.text += event.delta.text;
          this.output(run, run.growing);
        }
      }
      return;
    }
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      run.sdkUuids.add(message.uuid);
      const content = contentSchema.parse(message.message.content);
      const parts =
        typeof content === 'string' ? blockParts({ type: 'text', text: content }) : content.flatMap(blockParts);
      const from = run.growing ?? run.parts.length;
      run.parts.splice(from, run.growing === null ? 0 : 1, ...parts);
      run.growing = null;
      for (let index = from; index < from + parts.length; index++) this.output(run, index);
      for (const part of parts) run.onPart?.(part);
    }
  }

  private output(run: Run, index: number): void {
    const part = run.parts[index];
    if (!part) return;
    this.store.write((_tx, emit) =>
      emit('session.output', { session_id: run.sessionId, message_id: run.messageId, part_index: index, part }),
    );
  }

  private finish(run: Run, result: RunResult): void {
    this.runs.remove(run.sessionId);
    const failed = result !== 'done';
    // The agent's first words in the message; its tool steps make a poor preview.
    const newest = run.parts.find((part): part is Extract<Part, { kind: 'text' }> => part.kind === 'text');
    this.store.write((tx, emit) => {
      const row = tx
        .update(sessions)
        .set({
          state: failed ? SessionState.Failed : SessionState.Idle,
          ...(newest ? { lastMessagePreview: firstLine(newest.text, 200) } : {}),
          lastActiveAt: nowIso,
        })
        .where(eq(sessions.id, run.sessionId))
        .returning()
        .get();
      if (row) emitSessionUpdated(emit, row);
      emit('session.finished', {
        session_id: run.sessionId,
        message_id: run.messageId,
        status: failed ? 'failed' : 'done',
        state: failed ? SessionState.Failed : SessionState.Idle,
        error_code: failed ? result : null,
      });
    });
    run.onFinish?.({
      ok: !failed,
      text: run.parts.map(partText).join('\n'),
    });
  }

  /**
   * `PreToolUse` runs before every other permission step, in every mode: it writes the Action Log row for a Bash or
   * MCP call before the call runs, and holds a PROD write for an Approval, `full` mode included.
   */
  private beforeTool(run: Run): HookCallback {
    return async (input): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const toolInput = asRecord(input.tool_input);
      const prodWrite = this.prodWrites.match({
        toolName: input.tool_name,
        input: toolInput,
        workingDir: run.workingDir,
      });
      const call = classifyCall(input.tool_name, toolInput, run.workingDir);
      if (!call && !prodWrite) return {};
      const row = this.actionLog.start({
        sessionId: run.sessionId,
        kind: call?.kind ?? ActionKind.Query,
        target: call?.target ?? run.workingDir,
        command: call?.command ?? stepText(input.tool_name, toolInput),
        isProd: prodWrite !== null,
      });
      run.toolRows.set(input.tool_use_id, row);
      if (!prodWrite) return {};
      const decision = await this.ask(run, {
        actionLogId: row,
        sessionId: run.sessionId,
        kind: ApprovalKind.ProdWrite,
        summary: prodWrite.summary,
        isProd: true,
      });
      const approved = decision === ApprovalStatus.Approved;
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: approved ? 'allow' : 'deny',
          permissionDecisionReason: approved
            ? 'The operator approved this PROD write.'
            : 'The operator denied this PROD write. Do not retry it.',
        },
      };
    };
  }

  private afterTool(run: Run): HookCallback {
    return async (input): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') return {};
      const row = run.toolRows.get(input.tool_use_id);
      if (!row) return {};
      if (input.hook_event_name === 'PostToolUse') this.actionLog.finish(row, ActionOutcome.Ok);
      else this.actionLog.finish(row, ActionOutcome.Failed, redact(input.error).slice(0, 500));
      return {};
    };
  }

  /** Permission prompts: the agent's questions, and edits and commands the access mode asks about. */
  private permissionPrompt(run: Run): CanUseTool {
    return async (toolName, input, { toolUseID }) => {
      if (toolName === 'AskUserQuestion') {
        const answer = await this.question(run);
        const parsed = questionInputSchema.safeParse(input);
        const questions = parsed.success ? parsed.data.questions : [];
        return {
          behavior: 'allow',
          updatedInput: {
            ...input,
            answers: Object.fromEntries(questions.map((question) => [question.question, answer])),
          },
        };
      }
      const isEdit = EDIT_TOOLS.has(toolName);
      const decision = await this.ask(run, {
        actionLogId: isEdit ? null : (run.toolRows.get(toolUseID) ?? null),
        sessionId: run.sessionId,
        kind: isEdit ? ApprovalKind.Edit : ApprovalKind.Command,
        summary: isEdit ? `Edit ${String(input.file_path ?? input.notebook_path ?? '')}` : stepText(toolName, input),
        isProd: false,
      });
      return decision === ApprovalStatus.Approved
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The operator denied this.' };
    };
  }

  /** The Session waits for the operator's next message, which answers the question (Behavior 8). */
  private async question(run: Run): Promise<string> {
    const answer = new Promise<string>((resolve) => {
      run.answer = (text) => {
        run.answer = null;
        resolve(text);
      };
    });
    this.sessions.setState(run.sessionId, SessionState.WaitingInput);
    const text = await answer;
    this.resume(run);
    return text;
  }

  private async ask(run: Run, request: ApprovalRequest): Promise<Decision> {
    run.waits++;
    this.sessions.setState(run.sessionId, SessionState.WaitingApproval);
    const decision = await this.approvals.request(request);
    run.waits--;
    this.resume(run);
    return decision;
  }

  /** Back to `working` once nothing is left to wait on. */
  private resume(run: Run): void {
    if (run.waits === 0 && run.answer === null) this.sessions.setState(run.sessionId, SessionState.Working);
  }
}
