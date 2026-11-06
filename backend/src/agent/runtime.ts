import { lstatSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CanUseTool,
  EffortLevel,
  HookCallback,
  HookJSONOutput,
  Options,
  PermissionMode,
  SDKAssistantMessage,
  SDKMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AccessMode,
  ActionKind,
  ActionOutcome,
  ApprovalKind,
  ApprovalStatus,
  CONNECTOR_SERVERS,
  ConnectorId,
  type EditedMessage,
  Effort,
  ErrorCode,
  type Message,
  type Part,
  RunOutcome,
  RunPurpose,
  SessionState,
  type SkillCopy,
  type Subagent,
  SubagentStatus,
} from '@ops-console/shared';
import { eq, inArray } from 'drizzle-orm';
import { type AccountRow, AccountsService, rateLimitInfoSchema } from '../accounts/accounts.service';
import { CliProxyService } from '../accounts/cliproxy.service';
import { ActionLogService } from '../action-log/action-log.service';
import { type ApprovalRequest, ApprovalsService, type Decision } from '../action-log/approvals.service';
import { classifyCall, mcpTool } from '../action-log/classify';
import { redact } from '../action-log/redact';
import { claudeEnv } from '../claude-cli/claude-cli';
import { DATA_DIR } from '../common/data-dir';
import { ApiError } from '../common/errors';
import { StartupRecovery } from '../common/recovery';
import { disabledMcpServers, nowIso, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { KEYCHAIN, type Keychain, KeychainTimeout } from '../keychain/keychain';
import { storedEnvVar } from '../mcp/launcher';
import { NetworkAllowlistService } from '../network/network-allowlist.service';
import { PlaybooksService } from '../playbooks/playbooks.service';
import { systemAppend } from '../playbooks/prompts';
import { AGENT_CONFIG, type AgentConfig } from './agent-config';
import { Attachments } from './attachments';
import { ConnectionLookup } from './connection-lookup';
import { HOOK_BYPASS_REASON, skipsCommitHooks } from './hook-bypass';
import { MessageInterceptors } from './message-interceptors';
import { OutputFiles, saveFileInputSchema } from './output-files';
import { blockParts, contentSchema, EDIT_TOOLS, questionInputSchema, stepText, toMessages } from './parts';
import { mergeLines, type UsageLine } from './pricing';
import { ProdWriteRule } from './prod-write-rule';
import {
  CONSOLE_TOOLS_SERVER,
  consoleToolsServer,
  JOIN_REPO_TOOL,
  joinRepoInputSchema,
  OPEN_PULL_REQUEST_TOOL,
  openPullRequestInputSchema,
  type PullRequestOpener,
  type RepoJoiner,
  SAVE_FILE_TOOL,
} from './pull-request-tool';
import { gitControl, runSandbox } from './run-sandbox';
import { RunStepsLog } from './run-steps';
import { type Run, RunRegistry, type RunSummary } from './runs';
import { SessionKinds } from './session-kinds';
import { sessionTitle, shortTitle } from './session-title';
import { emitSessionUpdated, NEW_SESSION_TITLE, type SessionRow, SessionsService } from './sessions.service';
import { removeSkillPlugin, skillNames, skillRunsDir, writeSkillPlugin } from './skill-plugin';
import { Transcripts } from './transcripts';

/**
 * Claude Code starts a run's MCP servers in the background and lets the model in before they connect; a server
 * that takes seconds to start (Firebase through npx) then reads as "still connecting" for the whole turn. Runs
 * wait for them, up to Claude Code's own connect timeout.
 */
const MCP_STARTUP_WAIT_MS = '30000';

/** When to look for Claude Code's name for a new Session after its first run ends. */
const TITLE_WAITS_MS = [0, 2000, 5000];

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
  'Bash(bkt pr merge:*)',
  'Bash(bkt pr auto-merge:*)',
  'mcp__github__merge_pull_request',
  'mcp__gitlab__merge_merge_request',
  // The hosts' own merge endpoints and mutations, reached through `gh api`, `curl` or another client with `GH_TOKEN`.
  'Bash(*pulls/*/merge*)',
  'Bash(*merge_requests/*/merge*)',
  'Bash(*pullrequests/*/merge*)',
  'Bash(*mergePullRequest*)',
  'Bash(*enablePullRequestAutoMerge*)',
];

/**
 * The Run sandbox filters a run's commands (ADR 0006), not the agent's own web tools, so a steered run could send out
 * what it reads through them.
 */
export const WEB_DENIALS = ['WebFetch', 'WebSearch'];

/**
 * A Reply check or Comment pass hands its outcome to the console, which pushes, replies and resolves; the agent's own
 * tools for that are denied (ADR 0002).
 */
export const HOST_WRITE_DENIALS = [
  'Bash(git push:*)',
  'Bash(gh pr comment:*)',
  'Bash(gh pr review:*)',
  'Bash(gh api:*)',
  'Bash(glab mr note:*)',
  'Bash(glab api:*)',
  'Bash(bkt api:*)',
  'Bash(bkt pr comment:*)',
  'mcp__github__add_issue_comment',
  'mcp__github__create_pull_request_review',
  'mcp__github__add_comment_to_pending_review',
  'mcp__gitlab__create_merge_request_note',
  // The token-holding GitHub server's other tools that write, by the verbs its tool names start with.
  ...[
    'add',
    'assign',
    'close',
    'create',
    'delete',
    'dismiss',
    'edit',
    'fork',
    'lock',
    'merge',
    'push',
    'remove',
    'reply',
    'request',
    'set',
    'submit',
    'transfer',
    'update',
    'write',
  ].flatMap((verb) => [`mcp__github__${verb}_*`, `mcp__gitlab__${verb}_*`]),
];

/** A run that only reads: it has no tool that edits files, and its sandbox leaves the working folder read-only. */
export const READ_ONLY_DENIALS = ['Edit', 'MultiEdit', 'NotebookEdit', 'Write'];

/** A permission rule's form of an absolute path. */
const absolute = (file: string) => `/${file}`;

/**
 * File tools run in Claude Code's own process, outside the Run sandbox's profile (ADR 0006), so the same limits are
 * permission rules, which `disallowedTools` holds in every mode: no reading the data folder's secrets or the operator's
 * credential folders, and no editing the git control files the daemon's `git` later reads.
 */
export function fileToolDenials(dataDir: string, workingDir: string, home: string = os.homedir()): string[] {
  const secrets = [
    path.join(dataDir, 'runtime.json'),
    path.join(dataDir, 'state.db'),
    path.join(dataDir, 'state.db-wal'),
    path.join(dataDir, 'state.db-shm'),
    path.join(dataDir, 'keychain-owner.json'),
    path.join(dataDir, 'accounts', '**'),
    path.join(dataDir, 'mcp-files', '**'),
    path.join(home, '.aws', '**'),
    path.join(home, '.config', 'gcloud', '**'),
    path.join(home, 'Library', 'Keychains', '**'),
    path.join(home, '.ssh', '**'),
  ];
  return [
    ...secrets.flatMap((file) => [`Read(${absolute(file)})`, `Edit(${absolute(file)})`]),
    ...gitControl(workingDir, gitFileOf(workingDir)).map((file) => `Edit(${absolute(file)})`),
  ];
}

/** Whether the folder's `.git` is a file, as it is in a worktree. */
function gitFileOf(workingDir: string): boolean {
  try {
    return lstatSync(path.join(workingDir, '.git')).isFile();
  } catch {
    return false;
  }
}

/** How a run the console starts itself differs from an operator's message. */
export type RunOptions = {
  /** Runs in this folder instead of the Session's own. */
  cwd?: string;
  /** The Playbook rules the job copied. */
  rules?: string | null;
  /** The Skills the job copied. */
  skills?: SkillCopy[];
  /** Starts a new agent conversation instead of resuming the Session's. */
  fresh?: boolean;
  /** Resumes the conversation from this transcript entry, dropping what came after it. */
  resumeAt?: string;
  /** Tools denied on top of merging. */
  deny?: string[];
  /** False for a folder that holds pull request code: no `.claude` settings, `.mcp.json` or CLAUDE.md from it. */
  projectSettings?: boolean;
  /** The run may not change its working folder. */
  readOnly?: boolean;
  /** What the run is for; a chat message when absent. */
  purpose?: RunPurpose;
};

type RunResult =
  | 'done'
  | 'stopped'
  | ErrorCode.RateLimited
  | ErrorCode.Unauthorized
  | ErrorCode.UpstreamFailed
  | ErrorCode.KeychainTimeout;

/** What Play and Retry say to the agent. */
const PLAY_TEXT = 'Carry on from where you stopped.';
const JOINED_TEXT =
  "You are now in the Repo, in its own folder. Carry on with what the operator asked. Do the work on a new branch, not on the default branch: make one with git switch -c, commit the change (the repo's commit hooks run and must pass), and when the work is done call the open_pull_request tool. The operator approves it, then the console pushes the branch and opens the pull request. If that tool is not in your tool list, the Repo has no Git host the console can open on: say so, and leave the commit on its branch.";
const RETRY_TEXT = 'Your last run ended before it finished. Try again and carry on from where it stopped.';

/** How a run that ended with `result` reads in the tray. */
function outcomeOf(result: RunResult, paused: boolean): RunOutcome {
  switch (result) {
    case 'done':
      return RunOutcome.Done;
    case 'stopped':
      return paused ? RunOutcome.Paused : RunOutcome.Stopped;
    case ErrorCode.RateLimited:
      return RunOutcome.RateLimited;
    case ErrorCode.Unauthorized:
      return RunOutcome.SignedOut;
    default:
      return RunOutcome.Failed;
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const firstLine = (text: string, max: number) => (text.trim().split('\n')[0] ?? '').slice(0, max);

/** Runs Sessions on the Claude Agent SDK: one run per Session at a time, Sessions side by side. */
@Injectable()
export class AgentRuntime {
  private readonly logger = new Logger('agent');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(KEYCHAIN) private readonly keychain: Keychain,
    @Inject(AGENT_CONFIG) private readonly config: AgentConfig,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(CliProxyService) private readonly cliProxy: CliProxyService,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(RunRegistry) private readonly runs: RunRegistry,
    @Inject(SessionKinds) private readonly kinds: SessionKinds,
    @Inject(ProdWriteRule) private readonly prodWrites: ProdWriteRule,
    @Inject(Transcripts) private readonly transcripts: Transcripts,
    @Inject(Attachments) private readonly attachments: Attachments,
    @Inject(OutputFiles) private readonly outputs: OutputFiles,
    @Inject(MessageInterceptors) private readonly interceptors: MessageInterceptors,
    @Inject(ConnectionLookup) private readonly connections: ConnectionLookup,
    @Inject(PlaybooksService) private readonly playbooks: PlaybooksService,
    @Inject(NetworkAllowlistService) private readonly network: NetworkAllowlistService,
    @Inject(RunStepsLog) private readonly steps: RunStepsLog,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('agent sessions and approvals', () => this.recover());
  }

  /** Who opens a pull request when the agent asks. Set once by the Workspace, which this module does not import. */
  private opener: PullRequestOpener | null = null;

  setPullRequestOpener(opener: PullRequestOpener): void {
    this.opener = opener;
  }

  /** Who moves an Anonymous Session into a Repo when the agent asks. Set once by the Workspace. */
  private joiner: RepoJoiner | null = null;

  setRepoJoiner(joiner: RepoJoiner): void {
    this.joiner = joiner;
  }

  /** A run does not survive a restart: its Session fails and its Approvals expire (Behavior 18). */
  private recover(): void {
    this.store.write((tx, emit) => {
      const interrupted = tx
        .update(sessions)
        .set({
          state: SessionState.Failed,
          runOutcome: RunOutcome.Interrupted,
          runFinishedAt: new Date().toISOString(),
        })
        .where(inArray(sessions.state, [SessionState.Working, SessionState.WaitingInput, SessionState.WaitingApproval]))
        .returning()
        .all();
      for (const row of interrupted) emitSessionUpdated(emit, row);
    });
    this.steps.closeAllOpen('the console restarted');
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
    // A chat reads its Playbook at each turn, so an edit applies from the next message (Behavior 20).
    const { rules, skills } = this.playbooks.forSession(session);
    return { message_id: this.begin(sessionId, text, null, null, { rules, skills }).messageId };
  }

  /**
   * Edits the Session's last message and runs it again (Behavior 8a): the files the agent changed with its edit tools
   * since that message go back as they were, and the conversation goes on from just before it. Only the last
   * message can be edited, and only while no run is going.
   */
  async edit(sessionId: string, messageId: string, text: string): Promise<EditedMessage> {
    const session = this.sessions.get(sessionId);
    const kind = this.kinds.get(session.kind);
    if (!kind?.acceptsMessages) {
      throw new ApiError(409, ErrorCode.InvalidState, `a ${session.kind} session takes no messages`);
    }
    if (this.runs.get(sessionId)) throw new ApiError(409, ErrorCode.SessionBusy, "the session's run is still going");
    const notLast = new ApiError(409, ErrorCode.InvalidState, 'only the last message can be edited');
    if (session.sdkSessionId === null || session.accountId === null) throw notLast;
    const configDir = this.accounts.configDir(this.accounts.get(session.accountId));
    const workingDir = kind.workingDir(session);
    const entries = await this.transcripts.read(session.sdkSessionId, workingDir, configDir);
    const last = toMessages(entries, undefined, kind.serverLabel).findLast((message) => message.role === 'user');
    if (last?.id !== messageId) throw notLast;
    const at = entries.findIndex((entry) => asRecord(entry).uuid === messageId);
    const before = at > 0 ? asRecord(entries[at - 1]).uuid : undefined;

    const rewind = await this.config.sdk
      .rewindFiles(messageId, {
        cwd: workingDir,
        resume: session.sdkSessionId,
        env: claudeEnv(configDir),
        enableFileCheckpointing: true,
      })
      .catch((error: unknown) => ({ canRewind: false, error: error instanceof Error ? error.message : String(error) }));
    // Claude Code names files by their real path; the operator reads them from the working directory.
    const real = await realpath(workingDir).catch(() => workingDir);
    const shown = (file: string) => {
      const relative = path.relative(real, file);
      return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative;
    };
    const reverted =
      rewind.canRewind && 'filesChanged' in rewind
        ? {
            files: (rewind.filesChanged ?? []).map(shown),
            insertions: rewind.insertions ?? 0,
            deletions: rewind.deletions ?? 0,
          }
        : null;

    const { rules, skills } = this.playbooks.forSession(session);
    // The first message has nothing before it: the conversation starts over.
    const run = this.begin(
      sessionId,
      text,
      null,
      null,
      typeof before === 'string' ? { rules, skills, resumeAt: before } : { rules, skills, fresh: true },
    );
    return {
      message_id: run.messageId,
      reverted,
      revert_error: reverted ? null : (rewind.error ?? 'Claude Code could not put the files back'),
    };
  }

  /**
   * Starts a run the console asks for itself, in a Session that takes no operator messages. Throws `session_busy`
   * while the Session's run is going; `finished` settles when the run ends.
   */
  runFor(
    sessionId: string,
    text: string,
    onPart: ((part: Part) => void) | null = null,
    options: RunOptions = {},
  ): { finished: Promise<RunSummary> } {
    let settle: (summary: RunSummary) => void = () => {};
    const finished = new Promise<RunSummary>((resolve) => {
      settle = resolve;
    });
    this.begin(sessionId, text, settle, onPart, options);
    return { finished };
  }

  private begin(
    sessionId: string,
    text: string,
    onFinish: ((summary: RunSummary) => void) | null,
    onPart: ((part: Part) => void) | null = null,
    options: RunOptions = {},
  ): Run {
    const session = this.sessions.get(sessionId);
    const kind = this.kinds.get(session.kind);
    if (!kind) throw new ApiError(409, ErrorCode.InvalidState, `a ${session.kind} session cannot run`);
    if (this.runs.get(sessionId)) throw new ApiError(409, ErrorCode.SessionBusy, "the session's run is still going");
    const run: Run = {
      sessionId,
      messageId: crypto.randomUUID(),
      accountId: this.accounts.forRun().id,
      workingDir: options.cwd ?? kind.workingDir(session),
      rules: options.rules ?? null,
      skills: options.skills ?? [],
      parts: [],
      growing: null,
      sdkUuids: new Set(),
      toolRows: new Map(),
      said: [],
      answer: null,
      waits: 0,
      createdAt: new Date().toISOString(),
      onFinish,
      onPart,
      serverLabel: kind.serverLabel ?? null,
      abort: new AbortController(),
      stopped: false,
      paused: false,
      waitingSince: null,
      sendQueuedAfter: false,
      joinedRepo: false,
      subagents: new Map(),
      taskOfToolUse: new Map(),
      messageUsage: new Map(),
      limitSince: null,
      resumeAt: options.resumeAt ?? null,
      deny: options.deny ?? [],
      projectSettings: options.projectSettings ?? true,
      readOnly: options.readOnly ?? false,
      purpose: options.purpose ?? RunPurpose.Chat,
      networkDomains: this.network.forRun(),
      failure: null,
      autoTitle: null,
    };
    this.runs.add(run);
    this.sessions.setFailure(sessionId, null);
    if (options.fresh) this.sessions.write(sessionId, { sdkSessionId: null });
    const isFirst = session.title === NEW_SESSION_TITLE && session.sdkSessionId === null;
    if (isFirst) run.autoTitle = sessionTitle(text) ?? NEW_SESSION_TITLE;
    this.sessions.write(sessionId, {
      state: SessionState.Working,
      title: run.autoTitle ?? session.title,
      lastActiveAt: run.createdAt,
      runStartedAt: run.createdAt,
      runFinishedAt: null,
      runOutcome: null,
      runSubagents: null,
      runLimitSince: null,
      runLimitResetsAt: null,
    });
    void this.execute(run, text);
    return run;
  }

  /**
   * Ends the Session's run where it is: the SDK query aborts, its pending Approvals expire, and the Session goes back
   * to `idle`. Refused with `invalid_state` when no run is going. A paused run ends the same way, and its tray entry
   * offers Play.
   */
  stop(sessionId: string, paused = false): void {
    this.sessions.get(sessionId);
    const run = this.runs.get(sessionId);
    if (!run) throw new ApiError(409, ErrorCode.InvalidState, 'the session has no run going');
    run.stopped = true;
    run.paused = paused;
    run.abort.abort();
    this.approvals.expirePending(sessionId);
    // An open question would hold the permission prompt forever; the aborted query ignores the answer.
    run.answer?.('');
  }

  /**
   * Queues a message behind the Session's run: it goes out when the run ends, unless the operator stops the run. With no
   * run going there is nothing to wait for, so it goes out now.
   */
  queue(sessionId: string, text: string): { queued: boolean } {
    this.sessions.get(sessionId);
    if (!this.runs.get(sessionId)) {
      this.send(sessionId, text);
      return { queued: false };
    }
    this.sessions.write(sessionId, { queuedText: text });
    return { queued: true };
  }

  /** Takes the queued message back: it stays out of the next run. */
  takeBack(sessionId: string): void {
    this.sessions.get(sessionId);
    this.sessions.write(sessionId, { queuedText: null });
  }

  /** Sends the queued message now. A run going stops first, and the message starts the next. */
  sendQueuedNow(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session.queuedText === null) throw new ApiError(409, ErrorCode.InvalidState, 'no message is queued');
    const run = this.runs.get(sessionId);
    if (run) {
      run.sendQueuedAfter = true;
      this.stop(sessionId);
      return;
    }
    this.releaseQueued(sessionId);
  }

  /** Clears the queued message and starts the run it asks for; a message that cannot start stays queued. */
  private releaseQueued(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session.queuedText === null) return;
    const text = session.queuedText;
    this.sessions.write(sessionId, { queuedText: null });
    try {
      this.send(sessionId, text);
    } catch (error) {
      this.logger.error(
        `queued message of session ${sessionId} did not start: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.sessions.write(sessionId, { queuedText: text });
    }
  }

  /**
   * Starts the run again from the conversation as it stands, for Play on a paused or stopped run and Retry on one that
   * failed. Refused while a run is going. A Session that takes no messages runs its last failed job again instead.
   */
  async resumeRun(sessionId: string): Promise<{ message_id: string }> {
    const session = this.sessions.get(sessionId);
    if (this.runs.get(sessionId)) throw new ApiError(409, ErrorCode.SessionBusy, "the session's run is still going");
    // A kind that takes no messages, such as a pull request review, runs its last job again its own way.
    const again = this.kinds.retryOf(session.kind);
    if (again && !this.kinds.get(session.kind)?.acceptsMessages) {
      await again(session);
      return { message_id: crypto.randomUUID() };
    }
    const retry = session.runOutcome !== RunOutcome.Paused && session.runOutcome !== RunOutcome.Stopped;
    return this.send(sessionId, retry ? RETRY_TEXT : PLAY_TEXT);
  }

  /** True while the Session's run is going. */
  busy(sessionId: string): boolean {
    return this.runs.get(sessionId) !== undefined;
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
      messages = toMessages(entries, run?.sdkUuids, kind.serverLabel);
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
      // A run rejected for a limit resumes once, on the account Auto-switch picks (Behavior 26). One whose sign-in no
      // longer works resumes once on the next signed-in account (Behavior 26a).
      // Through CLIProxy a limit or a refused key is CLIProxy's to handle: no account switch, no account signed out.
      const next = this.cliProxy.enabled()
        ? null
        : result === ErrorCode.RateLimited
          ? this.accounts.switchAfterRejection(account.id)
          : result === ErrorCode.Unauthorized
            ? this.accounts.signInFailed(account.id)
            : null;
      if (next) {
        account = next;
        run.accountId = next.id;
        result = await this.runOnce(run, text, account);
      }
    } catch (error) {
      if (run.stopped) return this.finish(run, 'stopped');
      this.logger.error(
        `run of session ${run.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (error instanceof KeychainTimeout) run.failure = error.message;
      result = error instanceof KeychainTimeout ? ErrorCode.KeychainTimeout : ErrorCode.UpstreamFailed;
    }
    this.finish(run, result);
  }

  /**
   * `gh` keeps its token in the login Keychain, which the Run sandbox blocks, so a run signs `gh` in through
   * `GH_TOKEN` with the copy the GitHub Connector holds (ADR 0006). With no Connector there is none to give.
   */
  private async githubEnv(): Promise<Record<string, string>> {
    const server = CONNECTOR_SERVERS[ConnectorId.Github];
    const token = server ? await storedEnvVar(this.keychain, server.name, 'GITHUB_PERSONAL_ACCESS_TOKEN') : null;
    return token ? { GH_TOKEN: token } : {};
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
      // Claude Code finds a conversation by its folder: one begun in a scratch copy moves to this run's folder.
      else await this.transcripts.place(resume, configDir, run.workingDir);
    }
    if (session.accountId !== account.id) this.sessions.write(run.sessionId, { accountId: account.id });
    const instructions = this.kinds.get(session.kind)?.instructions;

    const attached = this.attachments.existingFolder(run.sessionId);
    // A run the operator started writes its files for them in the Session's output folder (a read-only run has none).
    const outputFolder = run.onFinish === null && !run.readOnly ? this.outputs.ensure(run.sessionId) : null;
    // The run's Skills sit in a folder of their own that the Run sandbox lets it read.
    const skillFolder = run.skills.length > 0 ? path.join(skillRunsDir(), crypto.randomUUID()) : null;
    const extraDirs = [attached, outputFolder].filter((folder) => folder !== null);
    const options: Options = {
      cwd: run.workingDir,
      sandbox: runSandbox({
        workingDir: run.workingDir,
        dataDir: this.dataDir,
        readable: [...(attached === null ? [] : [attached]), ...(skillFolder === null ? [] : [skillFolder])],
        writable: outputFolder === null ? [] : [outputFolder],
        networkDomains: run.networkDomains,
        readOnly: run.readOnly,
        gitFile: gitFileOf(run.workingDir),
      }),
      // A folder that holds pull request code never adds its own settings, hooks, servers or memory to the run.
      ...(run.projectSettings ? {} : { settingSources: ['user' as const] }),
      // The operator's attached files sit outside the working folder; the agent reads them without asking.
      ...(extraDirs.length === 0 ? {} : { additionalDirectories: extraDirs }),
      ...(skillFolder === null
        ? {}
        : {
            plugins: [{ type: 'local' as const, path: skillFolder, skipMcpDiscovery: true }],
            skills: skillNames(run.skills),
          }),
      model: session.model,
      effort: SDK_EFFORT[session.effort],
      permissionMode: PERMISSION_MODES[session.accessMode],
      allowDangerouslySkipPermissions: session.accessMode === AccessMode.Full,
      ...(resume === null ? {} : { resume, ...(run.resumeAt === null ? {} : { resumeSessionAt: run.resumeAt }) }),
      // Each message gets a file checkpoint, so editing it can put the agent's file edits back (Behavior 8a).
      enableFileCheckpointing: true,
      env: {
        ...claudeEnv(configDir),
        ...(await this.cliProxy.env()),
        ...(await this.githubEnv()),
        CLAUDE_CODE_MCP_STARTUP_WAIT_MS: MCP_STARTUP_WAIT_MS,
      },
      includePartialMessages: true,
      abortController: run.abort,
      // The console's own tools: the agent asks, the operator approves, the daemon pushes and opens the pull request.
      ...(() => {
        const opener = this.opener?.offers(run.sessionId, run.workingDir) ? this.opener : null;
        // Only a run the operator started: a Playbook step or a Verification in an Anonymous Session stays where it is.
        const joiner = run.onFinish === null && this.joiner?.offers(run.sessionId) ? this.joiner : null;
        const saver = outputFolder === null ? null : this.outputs;
        return opener || joiner || saver
          ? { mcpServers: { [CONSOLE_TOOLS_SERVER]: consoleToolsServer({ opener, joiner, saver }, run.sessionId) } }
          : {};
      })(),
      disallowedTools: [
        ...MERGE_DENIALS,
        ...WEB_DENIALS,
        ...fileToolDenials(this.dataDir, run.workingDir),
        ...(run.readOnly ? READ_ONLY_DENIALS : []),
        ...run.deny,
      ],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: systemAppend(instructions, run.rules, outputFolder),
      },
      // Servers the operator disabled stay out of the run.
      settings: {
        deniedMcpServers: [
          ...this.store.db
            .select()
            .from(disabledMcpServers)
            .all()
            .map(({ name }) => name),
          ...(this.kinds.get(session.kind)?.deniedServers?.(session) ?? []),
        ].map((name) => ({ serverName: name })),
      },
      hooks: {
        PreToolUse: [{ hooks: [this.beforeTool(run)] }],
        PostToolUse: [{ hooks: [this.afterTool(run)] }],
        PostToolUseFailure: [{ hooks: [this.afterTool(run)] }],
      },
      canUseTool: this.permissionPrompt(run),
    };

    // Stop can land while the transcript moves, before the query listens for the abort.
    if (run.stopped) return 'stopped';
    if (skillFolder !== null) {
      try {
        await writeSkillPlugin(skillFolder, run.skills);
      } catch (error) {
        await removeSkillPlugin(skillFolder);
        run.failure = `could not hand the Skills to the run: ${error instanceof Error ? error.message : String(error)}`;
        return ErrorCode.UpstreamFailed;
      }
    }
    let rejected = false;
    let signInFailed = false;
    let failed = false;
    let reportedCost = 0;
    let reportedTokens = 0;
    try {
      for await (const message of this.config.sdk.query(text, options)) {
        if (message.type === 'rate_limit_event') {
          // An event whose shape changed in an SDK release leaves the last usage in place (Not required: exact usage).
          const info = rateLimitInfoSchema.safeParse(message.rate_limit_info);
          if (info.success) {
            // Through CLIProxy the numbers are of whichever account CLIProxy picked, not this one.
            if (!this.cliProxy.enabled()) this.accounts.recordUsage(account.id, info.data);
            rejected ||= info.data.status === 'rejected';
            if (info.data.status === 'rejected') this.noteLimit(run, info.data.resetsAt);
          }
        } else if (message.type === 'result') {
          for (const denial of message.permission_denials) {
            const row = run.toolRows.get(denial.tool_use_id);
            if (row) this.actionLog.finish(row, ActionOutcome.Denied);
          }
          failed = message.is_error;
          reportedCost += message.total_cost_usd ?? 0;
          const used = message.usage;
          reportedTokens +=
            (used?.input_tokens ?? 0) +
            (used?.output_tokens ?? 0) +
            (used?.cache_read_input_tokens ?? 0) +
            (used?.cache_creation_input_tokens ?? 0);
          // Only a sandbox refusal is worth the operator's eyes; other result text stays in the transcript.
          const said = message.subtype === 'success' ? message.result : message.errors?.join('; ');
          if (failed && typeof said === 'string' && /sandbox/i.test(said)) run.failure = said;
        } else {
          if (message.type === 'assistant') {
            this.noteUsage(run, message);
            if (message.error === 'rate_limit') this.noteLimit(run, undefined);
          }
          rejected ||= message.type === 'assistant' && message.error === 'rate_limit';
          signInFailed ||= message.type === 'assistant' && message.error === 'authentication_failed';
          this.stream(run, message);
        }
      }
    } catch (error) {
      if (!rejected && !signInFailed && !run.stopped) throw error;
    } finally {
      // Saved even when the query threw: a run the limit cut off still used what it used.
      this.steps.addUsage(
        run,
        reportedCost,
        this.takeUsage(run),
        reportedTokens,
        this.accounts.attributedTo(run.accountId),
        run.purpose,
      );
      if (skillFolder !== null) await removeSkillPlugin(skillFolder);
    }
    for (const row of run.toolRows.values()) {
      this.actionLog.finish(row, ActionOutcome.Failed, run.stopped ? 'stopped' : 'no result');
    }
    if (run.stopped) return 'stopped';
    if (rejected) return ErrorCode.RateLimited;
    if (signInFailed) return ErrorCode.Unauthorized;
    return failed ? ErrorCode.UpstreamFailed : 'done';
  }

  /** Keeps what a model message used, once per message id; the subagent it came from is found by its Task call. */
  private noteUsage(run: Run, message: SDKAssistantMessage): void {
    const { id, model, usage } = message.message;
    if (!id || !usage) return;
    const agentId =
      message.parent_tool_use_id === null
        ? null
        : (run.taskOfToolUse.get(message.parent_tool_use_id) ?? message.parent_tool_use_id);
    run.messageUsage.set(id, {
      agentId,
      model: String(model),
      tokens: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cache_read: usage.cache_read_input_tokens ?? 0,
        cache_write: usage.cache_creation_input_tokens ?? 0,
      },
    });
  }

  /** The usage of the messages seen since the last save, summed per agent and model; the messages are forgotten. */
  private takeUsage(run: Run): UsageLine[] {
    const lines = [...run.messageUsage.values()].map((one) => {
      const subagent = one.agentId === null ? undefined : run.subagents.get(one.agentId);
      return {
        agent_id: one.agentId,
        model: one.model,
        ...(subagent ? { agent_type: subagent.type, agent_description: subagent.description.slice(0, 120) } : {}),
        ...one.tokens,
      };
    });
    run.messageUsage.clear();
    return mergeLines(lines);
  }

  /** The run hit the account's usage limit: when, and when the window resets (the SDK gives seconds). */
  private noteLimit(run: Run, resetsAtSeconds: number | undefined): void {
    const resets = resetsAtSeconds === undefined ? null : new Date(resetsAtSeconds * 1000).toISOString();
    if (run.limitSince !== null && resets === null) return;
    run.limitSince ??= new Date().toISOString();
    this.sessions.write(run.sessionId, {
      runLimitSince: run.limitSince,
      ...(resets === null ? {} : { runLimitResetsAt: resets }),
    });
  }

  /** Turns SDK messages into parts. Text grows from stream deltas, then is replaced by its finished block. */
  private stream(run: Run, message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      const session = this.sessions.get(run.sessionId);
      if (session.sdkSessionId !== message.session_id) {
        this.sessions.write(run.sessionId, { sdkSessionId: message.session_id });
      }
      this.reportServers(run, session, message.mcp_servers);
      return;
    }
    if (message.type === 'system' && (message.subtype === 'task_started' || message.subtype === 'task_notification')) {
      this.trackSubagent(run, message);
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
      run.said.push(
        ...(typeof content === 'string'
          ? [content]
          : content.flatMap((block) => ('text' in block && block.type === 'text' ? [block.text] : []))),
      );
      const parts =
        typeof content === 'string'
          ? blockParts({ type: 'text', text: content })
          : content.flatMap((block) => blockParts(block, run.serverLabel));
      const from = run.growing ?? run.parts.length;
      run.parts.splice(from, run.growing === null ? 0 : 1, ...parts);
      run.growing = null;
      for (let index = from; index < from + parts.length; index++) this.output(run, index);
      for (const part of parts) run.onPart?.(part);
    }
  }

  /** Keeps the run's subagents for the tray: one per `task_started` that names a subagent, ended by its notification. */
  private trackSubagent(run: Run, message: SDKTaskStartedMessage | SDKTaskNotificationMessage): void {
    if (message.subtype === 'task_started') {
      if (message.subagent_type === undefined && message.spawn_depth === undefined) return;
      if (message.tool_use_id) run.taskOfToolUse.set(message.tool_use_id, message.task_id);
      run.subagents.set(message.task_id, {
        id: message.task_id,
        parent_id: message.parent_task_id ?? null,
        description: message.description,
        type: message.subagent_type ?? null,
        status: SubagentStatus.Working,
        started_at: new Date().toISOString(),
        finished_at: null,
      });
      this.steps.agentStarted(run, run.subagents.get(message.task_id) as Subagent);
    } else {
      const task = run.subagents.get(message.task_id);
      if (!task) return;
      task.status =
        message.status === 'completed'
          ? SubagentStatus.Done
          : message.status === 'failed'
            ? SubagentStatus.Failed
            : SubagentStatus.Stopped;
      task.finished_at = new Date().toISOString();
      this.steps.agentEnded(run, task);
    }
    this.sessions.write(run.sessionId, { runSubagents: JSON.stringify([...run.subagents.values()]) });
  }

  /**
   * A Connection's server that is down or needs a login is named in a step and skipped; the run goes on with the
   * others. Servers left out of this run are not reported.
   */
  private reportServers(run: Run, session: SessionRow, servers: { name: string; status: string }[]): void {
    const denied = new Set(this.kinds.get(session.kind)?.deniedServers?.(session) ?? []);
    const from = run.parts.length;
    for (const { name, status } of servers) {
      if ((status !== 'failed' && status !== 'needs-auth') || denied.has(name) || !this.connections.find(name))
        continue;
      const label = run.serverLabel?.(name) ?? name;
      run.parts.push({
        kind: 'step',
        text: `${label}: ${status === 'needs-auth' ? 'needs a login' : 'is down'}, skipped`,
      });
    }
    for (let index = from; index < run.parts.length; index++) this.output(run, index);
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
    this.sessions.setFailure(run.sessionId, run.failure);
    // A run the operator stopped ends `idle`, like one that finished; the job that started it still sees it fail.
    const failed = result !== 'done' && result !== 'stopped';
    const finishedAt = new Date().toISOString();
    // Subagents still going when the run ends ended with it.
    const ending = failed ? SubagentStatus.Failed : result === 'stopped' ? SubagentStatus.Stopped : SubagentStatus.Done;
    const subagents: Subagent[] = [...run.subagents.values()].map((task) =>
      task.status === SubagentStatus.Working ? { ...task, status: ending, finished_at: finishedAt } : task,
    );
    for (const task of subagents)
      if (run.subagents.get(task.id)?.status === SubagentStatus.Working) this.steps.agentEnded(run, task);
    this.steps.closeOpen(run.sessionId, run.stopped ? 'stopped' : 'no result');
    // The agent's first words in the message; its tool steps make a poor preview.
    const newest = run.parts.find((part): part is Extract<Part, { kind: 'text' }> => part.kind === 'text');
    this.store.write((tx, emit) => {
      const row = tx
        .update(sessions)
        .set({
          state: failed ? SessionState.Failed : SessionState.Idle,
          runFinishedAt: finishedAt,
          runOutcome: outcomeOf(result, run.paused),
          runSubagents: subagents.length > 0 ? JSON.stringify(subagents) : null,
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
        started_by: run.onFinish ? 'console' : 'operator',
      });
    });
    // A Session deleted mid-run has nothing to look at after it.
    const session = (() => {
      try {
        return this.sessions.get(run.sessionId);
      } catch {
        return null;
      }
    })();
    if (session && run.autoTitle !== null) void this.nameForTask(run.sessionId, run.autoTitle).catch(() => {});
    const after = session ? this.kinds.get(session.kind)?.afterRun : undefined;
    if (session && after) void after(session, { startedAt: run.createdAt, workingDir: run.workingDir }).catch(() => {});
    run.onFinish?.({
      ok: result === 'done',
      stopped: result === 'stopped',
      text: run.said.join('\n'),
      failure: run.failure,
    });
    // A run that moved the Session into a Repo hands over: its next turn starts in the Repo's folder.
    if (session && run.joinedRepo && result === 'done') {
      try {
        this.send(run.sessionId, JOINED_TEXT);
        return;
      } catch (error) {
        this.logger.error(
          `session ${run.sessionId} joined a Repo but its next turn did not start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // The message queued behind the run goes out now, unless the operator stopped the run and did not ask for it.
    if (session && (!run.stopped || run.sendQueuedAfter)) this.releaseQueued(run.sessionId);
  }

  /**
   * After a new Session's first run: the name Claude Code gave the conversation replaces the first-sentence title,
   * unless the operator renamed the Session meanwhile. Claude Code may write it just after the run ends, so it is
   * looked for again a few times.
   */
  private async nameForTask(sessionId: string, autoTitle: string): Promise<void> {
    for (const wait of TITLE_WAITS_MS) {
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait).unref());
      const session = this.sessions.get(sessionId);
      if (session.title !== autoTitle) return;
      if (session.sdkSessionId === null || session.accountId === null) continue;
      const configDir = this.accounts.configDir(this.accounts.get(session.accountId));
      const title = await this.transcripts.aiTitle(session.sdkSessionId, configDir);
      if (title === null) continue;
      if (this.sessions.get(sessionId).title === autoTitle)
        this.sessions.write(sessionId, { title: shortTitle(title) });
      return;
    }
  }

  /**
   * `PreToolUse` runs before every other permission step, in every mode: it writes the Action Log row for a Bash or
   * MCP call before the call runs, and holds a PROD write for an Approval, `full` mode included.
   */
  private beforeTool(run: Run): HookCallback {
    return async (input): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const toolInput = asRecord(input.tool_input);
      this.steps.start(run, {
        id: input.tool_use_id,
        agentId: input.agent_id ?? null,
        tool: input.tool_name,
        summary: stepText(input.tool_name, toolInput),
      });
      if (input.tool_name === OPEN_PULL_REQUEST_TOOL) return this.approvePullRequest(run, toolInput, input.tool_use_id);
      if (input.tool_name === JOIN_REPO_TOOL) return this.approveJoinRepo(run, toolInput, input.tool_use_id);
      if (input.tool_name === SAVE_FILE_TOOL) return this.approveSaveFile(run, toolInput, input.tool_use_id);
      if (input.tool_name === 'Bash' && typeof toolInput.command === 'string' && skipsCommitHooks(toolInput.command)) {
        this.steps.finish(input.tool_use_id, { ok: false, error: HOOK_BYPASS_REASON });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: HOOK_BYPASS_REASON,
          },
        };
      }
      const prodWrite = this.prodWrites.match({
        toolName: input.tool_name,
        input: toolInput,
        workingDir: run.workingDir,
      });
      const call = classifyCall(input.tool_name, toolInput, run.workingDir);
      if (!call && !prodWrite) return {};
      const server = mcpTool(input.tool_name)?.server;
      const connection = server ? this.connections.find(server) : null;
      const row = this.actionLog.start({
        sessionId: run.sessionId,
        kind: call?.kind ?? ActionKind.Query,
        target: call?.target ?? run.workingDir,
        command: call?.command ?? stepText(input.tool_name, toolInput),
        // A query on a PROD Connection is PROD whether or not it writes.
        isProd: prodWrite !== null || connection?.isProd === true,
        ...(connection ? { connectionId: connection.id } : {}),
      });
      run.toolRows.set(input.tool_use_id, row);
      if (!prodWrite) return {};
      const decision = await this.ask(
        run,
        {
          actionLogId: row,
          sessionId: run.sessionId,
          kind: ApprovalKind.ProdWrite,
          summary: prodWrite.summary,
          isProd: true,
        },
        input.tool_use_id,
      );
      const approved = decision === ApprovalStatus.Approved;
      if (!approved) this.steps.finish(input.tool_use_id, { ok: false, error: 'denied by the operator' });
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
      if (input.hook_event_name === 'PostToolUse') this.steps.finish(input.tool_use_id, { ok: true });
      else this.steps.finish(input.tool_use_id, { ok: false, error: input.error });
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
        const answer = await this.question(run, toolUseID);
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
      const decision = await this.ask(
        run,
        {
          actionLogId: isEdit ? null : (run.toolRows.get(toolUseID) ?? null),
          sessionId: run.sessionId,
          kind: isEdit ? ApprovalKind.Edit : ApprovalKind.Command,
          summary: isEdit ? `Edit ${String(input.file_path ?? input.notebook_path ?? '')}` : stepText(toolName, input),
          isProd: false,
        },
        toolUseID,
      );
      if (decision !== ApprovalStatus.Approved)
        this.steps.finish(toolUseID, { ok: false, error: 'denied by the operator' });
      return decision === ApprovalStatus.Approved
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The operator denied this.' };
    };
  }

  /**
   * Opening a pull request asks in every Access mode, `full` included: the operator reads what will be pushed and where,
   * and the daemon pushes and opens only after a yes. A call that cannot open anything is refused before it asks.
   */
  private async approvePullRequest(
    run: Run,
    toolInput: Record<string, unknown>,
    stepId: string,
  ): Promise<HookJSONOutput> {
    const refuse = (reason: string): HookJSONOutput => {
      this.steps.finish(stepId, { ok: false, error: reason });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    };
    const parsed = openPullRequestInputSchema.safeParse(toolInput);
    if (!this.opener || !parsed.success) return refuse('Give the pull request a title and a description.');
    let summary: string;
    try {
      summary = await this.opener.describe(run.sessionId, parsed.data);
    } catch (error) {
      return refuse(error instanceof ApiError ? error.message : 'No pull request can open here.');
    }
    const decision = await this.ask(
      run,
      { actionLogId: null, sessionId: run.sessionId, kind: ApprovalKind.Command, summary, isProd: false },
      stepId,
    );
    const approved = decision === ApprovalStatus.Approved;
    if (!approved) this.steps.finish(stepId, { ok: false, error: 'denied by the operator' });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: approved ? 'allow' : 'deny',
        permissionDecisionReason: approved
          ? 'The operator approved this pull request.'
          : 'The operator denied this pull request. Do not retry it.',
      },
    };
  }

  /**
   * Moving into a Repo asks in every Access mode: the Session's work then happens in the operator's own checkout. A
   * call that matches no imported Repo is refused before it asks.
   */
  private async approveJoinRepo(run: Run, toolInput: Record<string, unknown>, stepId: string): Promise<HookJSONOutput> {
    const refuse = (reason: string): HookJSONOutput => {
      this.steps.finish(stepId, { ok: false, error: reason });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    };
    const parsed = joinRepoInputSchema.safeParse(toolInput);
    if (!this.joiner || !parsed.success) return refuse('Name the Repo: its name, its path or its Git URL.');
    let summary: string;
    try {
      summary = this.joiner.describe(run.sessionId, parsed.data);
    } catch (error) {
      return refuse(error instanceof ApiError ? error.message : 'No Repo can be joined here.');
    }
    const decision = await this.ask(
      run,
      { actionLogId: null, sessionId: run.sessionId, kind: ApprovalKind.Command, summary, isProd: false },
      stepId,
    );
    const approved = decision === ApprovalStatus.Approved;
    if (approved) run.joinedRepo = true;
    else this.steps.finish(stepId, { ok: false, error: 'denied by the operator' });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: approved ? 'allow' : 'deny',
        permissionDecisionReason: approved
          ? 'The operator approved joining the Repo.'
          : 'The operator denied joining the Repo. Do not ask again: work in this folder or ask the operator.',
      },
    };
  }

  /**
   * Saving an output file outside the run's folders asks in every Access mode: the daemon, outside the sandbox, writes
   * where the operator says. A call with no such file or no such folder is refused before it asks.
   */
  private async approveSaveFile(run: Run, toolInput: Record<string, unknown>, stepId: string): Promise<HookJSONOutput> {
    const refuse = (reason: string): HookJSONOutput => {
      this.steps.finish(stepId, { ok: false, error: reason });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    };
    const parsed = saveFileInputSchema.safeParse(toolInput);
    if (!parsed.success) return refuse("Give the file's name in your output folder and the folder's absolute path.");
    let summary: string;
    try {
      summary = await this.outputs.describe(run.sessionId, parsed.data);
    } catch (error) {
      return refuse(error instanceof ApiError ? error.message : 'That file cannot be saved.');
    }
    const decision = await this.ask(
      run,
      { actionLogId: null, sessionId: run.sessionId, kind: ApprovalKind.Command, summary, isProd: false },
      stepId,
    );
    const approved = decision === ApprovalStatus.Approved;
    if (!approved) this.steps.finish(stepId, { ok: false, error: 'denied by the operator' });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: approved ? 'allow' : 'deny',
        permissionDecisionReason: approved
          ? 'The operator approved saving this file.'
          : 'The operator denied saving this file. Do not retry it, by this tool or by a command.',
      },
    };
  }

  /** The Session waits for the operator's next message, which answers the question (Behavior 8). */
  private async question(run: Run, stepId: string): Promise<string> {
    const since = Date.now();
    run.waitingSince ??= since;
    const answer = new Promise<string>((resolve) => {
      run.answer = (text) => {
        run.answer = null;
        resolve(text);
      };
    });
    this.sessions.setState(run.sessionId, SessionState.WaitingInput);
    const text = await answer;
    this.steps.waited(stepId, Date.now() - since);
    this.resume(run);
    return text;
  }

  private async ask(run: Run, request: ApprovalRequest, stepId: string | null = null): Promise<Decision> {
    const since = Date.now();
    run.waitingSince ??= since;
    run.waits++;
    this.sessions.setState(run.sessionId, SessionState.WaitingApproval);
    const decision = await this.approvals.request(request);
    run.waits--;
    if (stepId !== null) this.steps.waited(stepId, Date.now() - since);
    this.resume(run);
    return decision;
  }

  /** Back to `working` once nothing is left to wait on. */
  private resume(run: Run): void {
    if (run.waits === 0 && run.answer === null) {
      run.waitingSince = null;
      this.sessions.setState(run.sessionId, SessionState.Working);
    }
  }
}
