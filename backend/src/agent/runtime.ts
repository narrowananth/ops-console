import { createHash } from 'node:crypto';
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
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  AccessLevel,
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
  type LogSource,
  type Message,
  type Part,
  RunOutcome,
  RunPurpose,
  SessionState,
  type SkillCopy,
  type SkillRef,
  type Subagent,
  SubagentStatus,
} from '@ops-console/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
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
import {
  alerts,
  connections as connectionRows,
  disabledMcpServers,
  messageSkills,
  nowIso,
  repos as repoRows,
  sessions,
} from '../db/schema';
import { STORE, type Store } from '../db/store';
import { KEYCHAIN, type Keychain, KeychainTimeout } from '../keychain/keychain';
import { storedEnvVar } from '../mcp/launcher';
import { PlaybooksService } from '../playbooks/playbooks.service';
import { systemAppend } from '../playbooks/prompts';
import { AGENT_CONFIG, type AgentConfig } from './agent-config';
import { Attachments } from './attachments';
import { cloudWatchDenial } from './cloudwatch-tools';
import { ConnectionLookup } from './connection-lookup';
import { editRoots } from './edit-scope';
import { HOOK_BYPASS_REASON, skipsCommitHooks } from './hook-bypass';
import { hostedLogDenial } from './hosted-log-tools';
import { classifyCli, type IntegrationInput, integrationInputSchema, outsideFile, runCli } from './integration-cli';
import { mcpScope, offersNewRelicQuery } from './mcp-scope';
import { MessageInterceptors } from './message-interceptors';
import { NEW_RELIC_QUERY_TOOL, type NewRelicQuery } from './new-relic-tool';
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
  type PrActionTools,
  type PullRequestOpener,
  prActionOfTool,
  type RepoJoiner,
  RUN_INTEGRATION_TOOL,
  SAVE_FILE_TOOL,
  type SessionSpawner,
  SPAWN_SESSIONS_TOOL,
  spawnSessionsInputSchema,
} from './pull-request-tool';
import { gitControl, runSandbox, worktreeGitDirs } from './run-sandbox';
import { DEFAULT_JOB_RUN_LIMIT, RunSlots } from './run-slots';
import { RunStepsLog } from './run-steps';
import { isOperatorChat, type Run, RunRegistry, type RunSummary } from './runs';
import { type SessionKindHandler, SessionKinds } from './session-kinds';
import { sessionTitle, shortTitle } from './session-title';
import {
  BROWSER_EVALUATE_TOOL,
  BROWSER_QUIET_TOOLS,
  type BrowserTools,
  browserEvaluateInputSchema,
  PROCESS_OUTPUT_TOOL,
  type ProcessTools,
  START_PROCESS_TOOL,
  STOP_PROCESS_TOOL,
  startProcessInputSchema,
} from './session-tools';
import {
  emitSessionUpdated,
  extraRepoIds,
  NEW_SESSION_TITLE,
  type SessionRow,
  SessionsService,
  trustedClis,
} from './sessions.service';
import { type ResolvedSkill, SkillMenuService } from './skill-menu.service';
import { removeSkillPlugin, skillNames, skillRunsDir, writeSkillPlugin } from './skill-plugin';
import { CONSOLE_SUBAGENTS } from './subagents';
import { Transcripts } from './transcripts';

/**
 * Claude Code starts a run's MCP servers in the background and lets the model in before they connect; a server
 * that takes seconds to start (Firebase through npx) then reads as "still connecting" for the whole turn. Runs
 * wait for the servers they start, up to this long; a run that starts none waits for nothing.
 */
const MCP_STARTUP_WAIT_MS = '10000';

/** When to look for Claude Code's name for a new Session after its first run ends. */
const TITLE_WAITS_MS = [0, 2000, 5000];

/** Changes to a run's parts reach the pages at most this often. */
const OUTPUT_EVERY_MS = 100;

/** Each send carries the whole part, so a long text goes out less often: the cost of a send grows with its length. */
function outputEveryMs(part: Part | undefined): number {
  const length = part?.kind === 'text' ? part.text.length : 0;
  return length > 32_000 ? 1000 : length > 8000 ? 400 : OUTPUT_EVERY_MS;
}

/** A spare process nobody used is closed after this long. */
const WARM_TTL_MS = 60_000;
const MAX_WARM = 2;

type Warmed = { run: Run; query: WarmQuery; key: string; timer: NodeJS.Timeout | null };

/** A shutdown waits this long for aborted runs to end. */
const SHUTDOWN_WAIT_MS = 10_000;

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

/** The integration CLIs that write to a Git host. */
const GIT_HOST_CLIS = new Set(['gh', 'glab', 'bkt']);

/**
 * A PR action Session hands its results to the console, which pushes, replies and resolves, and a Verification writes to
 * no Git host. Both lose the agent's own tools for that (ADR 0002).
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

const HIDDEN_TEXT_WARNING =
  'Part of this command is hidden as a secret, and it runs as written. Deny it unless you know what the hidden part does.';

/** What an Approval shows for a command. Redaction can hide a script inside a secret-looking assignment: say so. */
function commandSummary(toolName: string, input: Record<string, unknown>): string {
  const shown = stepText(toolName, input);
  return toolName === 'Bash' && shown !== `$ ${String(input.command ?? '')}`
    ? `${shown}\n${HIDDEN_TEXT_WARNING}`
    : shown;
}

/** A permission rule's form of an absolute path. */
const absolute = (file: string) => `/${file}`;

/**
 * File tools run in Claude Code's own process, outside the Run sandbox's profile (ADR 0006), so the same limits are
 * permission rules, which `disallowedTools` holds in every mode: no reading the login Keychain folder or the installed
 * app, and no editing the git control files the daemon's `git` later reads.
 */
export function fileToolDenials(workingDir: string, home: string = os.homedir(), repoFolders: string[] = []): string[] {
  const closed = [path.join(home, 'Library', 'Keychains', '**'), path.join(home, '.ops-console', '**')];
  return [
    ...closed.flatMap((file) => [`Read(${absolute(file)})`, `Edit(${absolute(file)})`]),
    ...[workingDir, ...repoFolders]
      .flatMap((folder) => gitControl(folder, gitFileOf(folder)))
      .map((file) => `Edit(${absolute(file)})`),
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
  /** False for a skill message: its skill is added and the other skills stay available. Default true. */
  onlyHeldSkills?: boolean;
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
  /** What the agent gets in place of the message text, for a message that names a skill. */
  prompt?: string;
  /** The agent started this turn, not the operator: the kick-off message of a Session `spawn_sessions` made. */
  spawned?: boolean;
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
  "You are now in the Repo, in its own folder. Carry on with what the operator asked. Do the work on a new branch, not on the default branch: make one with git switch -c, commit the change (the repo's commit hooks run and must pass), and when the work is done call the open_pull_request tool. The console pushes the branch and opens the pull request at once, with no Approval. If that tool is not in your tool list, the Repo has no Git host the console can open on: say so, and leave the commit on its branch.";
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

/**
 * A name for the process `options` start: equal keys mean a process started for one serves the other. Hooks, the
 * permission callback, the abort signal and the in-process tool servers belong to a run and are left out; the tools
 * they offer come in as `tools`.
 */
function optionsKey(options: Options, tools: string[]): string {
  const { hooks, canUseTool, abortController, mcpServers, ...rest } = options;
  const text = JSON.stringify([rest, tools], (_key, value: unknown) => (typeof value === 'function' ? null : value));
  return createHash('sha256').update(text).digest('hex');
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const firstLine = (text: string, max: number) => (text.trim().split('\n')[0] ?? '').slice(0, max);

/** Runs Sessions on the Claude Agent SDK: one run per Session at a time, Sessions side by side. */
@Injectable()
export class AgentRuntime implements OnModuleDestroy {
  private readonly logger = new Logger('agent');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(DATA_DIR) readonly _dataDir: string,
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
    @Inject(SkillMenuService) private readonly skillMenu: SkillMenuService,
    @Inject(RunStepsLog) private readonly steps: RunStepsLog,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('agent sessions and approvals', () => this.recover());
    // The conversation goes with its Session, from every account folder it was copied to.
    sessions.onRemoved(async (id, row) => {
      this.dropWarm(id);
      if (row.sdkSessionId === null) return;
      await this.transcripts.remove(
        row.sdkSessionId,
        this.accounts.all().map((account) => account.configDir),
      );
    });
    this.slots = new RunSlots(config.jobRunLimit ?? DEFAULT_JOB_RUN_LIMIT);
  }

  /** Places for the runs a job starts; an operator's own message never waits for one. */
  private readonly slots: RunSlots;
  /** Every run's `execute`, until it ends, so a shutdown can wait for them. */
  private readonly executing = new Set<Promise<void>>();
  private closing = false;

  /**
   * The daemon is stopping: every run aborts and is waited for, so none writes to the database after it closes. A run
   * cut off this way is left as it is, `working`, and start-up recovery fails it, as for a daemon that was killed.
   */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    for (const id of [...this.warmed.keys()]) this.dropWarm(id);
    for (const run of this.runs.all()) {
      run.abort.abort();
      run.answer?.('');
    }
    await Promise.race([
      Promise.allSettled([...this.executing]),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref()),
    ]);
  }

  /** Who opens a pull request when the agent asks. Set once by the Workspace, which this module does not import. */
  private opener: PullRequestOpener | null = null;

  setPullRequestOpener(opener: PullRequestOpener): void {
    this.opener = opener;
  }

  /** Who posts a PR action Session's results when its agent calls the submit tool. Set once by the Workspace. */
  private prActionTools: PrActionTools | null = null;

  setPrActionTools(tools: PrActionTools): void {
    this.prActionTools = tools;
  }

  /** Who moves an Anonymous Session into a Repo when the agent asks. Set once by the Workspace. */
  private joiner: RepoJoiner | null = null;

  setRepoJoiner(joiner: RepoJoiner): void {
    this.joiner = joiner;
  }

  /** Who starts Sessions in several Repos when the agent asks. Set once by the Workspace. */
  private spawner: SessionSpawner | null = null;

  setSessionSpawner(spawner: SessionSpawner): void {
    this.spawner = spawner;
  }

  /** Who runs the browser tools. Set once by the Browser module. */
  private browserTools: BrowserTools | null = null;

  setBrowserTools(tools: BrowserTools): void {
    this.browserTools = tools;
  }

  /** Who runs the New Relic query tool, with the User API key only the daemon holds. Set once by the Monitor module. */
  private newRelicQuery: NewRelicQuery | null = null;

  setNewRelicQuery(query: NewRelicQuery): void {
    this.newRelicQuery = query;
  }

  /** Who runs the process tools. Set once by the Processes module. */
  private processTools: ProcessTools | null = null;

  setProcessTools(tools: ProcessTools): void {
    this.processTools = tools;
  }

  /** Spare Claude Code processes by Session, started by `warm` for the next message. */
  private readonly warmed = new Map<string, Warmed>();
  /** Sessions whose spare process is still starting. */
  private readonly warming = new Set<string>();

  /**
   * Starts a Claude Code process for the Session's next chat message, so the message does not wait for the process to
   * start. The process is made for the options the message would get now; a message that would start it differently
   * (another account, model or Playbook, an edit) closes it and starts its own. An unused one is closed after
   * `WARM_TTL_MS`. Needs no run going; a job's run never has one. Best effort: a failure is only logged.
   */
  warm(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    const kind = this.kinds.get(session.kind);
    if (!kind?.acceptsMessages) {
      throw new ApiError(409, ErrorCode.InvalidState, `a ${session.kind} session takes no messages`);
    }
    if (this.runs.get(sessionId)) throw new ApiError(409, ErrorCode.SessionBusy, "the session's run is still going");
    const had = this.warmed.get(sessionId);
    if (had) {
      this.expireWarm(sessionId, had);
      return;
    }
    if (this.warming.has(sessionId) || this.closing) return;
    this.warming.add(sessionId);
    void this.startWarm(session, kind)
      .catch((error: unknown) => {
        this.logger.debug(
          `no spare process for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.warming.delete(sessionId));
  }

  private async startWarm(session: SessionRow, kind: SessionKindHandler): Promise<void> {
    const { rules, skills } = this.playbooks.forSession(session);
    // The Skills' plugin folder is written when the run starts.
    if (skills.length > 0) return;
    const draft = this.newRun(session, kind, this.accounts.forRun().id, {
      onFinish: null,
      onPart: null,
      options: { rules, skills },
      spare: null,
    });
    const account = this.accounts.get(draft.accountId);
    const { options, key } = await this.buildOptions(draft, session, account);
    const query = await this.config.sdk.startup(options);
    // A message sent while the process started took its own; the process is no use.
    if (this.runs.get(session.id) || this.closing) {
      query.close();
      return;
    }
    // At most this many Sessions hold a spare process: each one is a whole Claude Code process.
    while (this.warmed.size >= MAX_WARM) {
      const oldest = this.warmed.keys().next().value;
      if (oldest === undefined) break;
      this.dropWarm(oldest);
    }
    const warmed: Warmed = { run: draft, query, key, timer: null };
    this.warmed.set(session.id, warmed);
    this.expireWarm(session.id, warmed);
  }

  private expireWarm(sessionId: string, warmed: Warmed): void {
    if (warmed.timer) clearTimeout(warmed.timer);
    warmed.timer = setTimeout(() => this.dropWarm(sessionId), this.config.warmTtlMs ?? WARM_TTL_MS);
    warmed.timer.unref();
  }

  /** Closes the Session's spare process, if it has one. */
  private dropWarm(sessionId: string): void {
    const warmed = this.warmed.get(sessionId);
    if (!warmed) return;
    this.warmed.delete(sessionId);
    if (warmed.timer) clearTimeout(warmed.timer);
    warmed.query.close();
  }

  /** The Session's spare process, now the caller's to use or close. */
  private takeWarm(sessionId: string): { run: Run; query: WarmQuery; key: string } | null {
    const warmed = this.warmed.get(sessionId);
    if (!warmed) return null;
    this.warmed.delete(sessionId);
    if (warmed.timer) clearTimeout(warmed.timer);
    return warmed;
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
  send(sessionId: string, text: string, picked?: SkillRef, extra: RunOptions = {}): { message_id: string } {
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
    return { message_id: this.beginMessage(session, text, picked, extra).messageId };
  }

  /**
   * Starts the run for an operator message. A message that names a skill runs that skill and not the Playbook; any
   * other message runs its Playbook, read at each turn so an edit applies from the next message.
   */
  private beginMessage(session: SessionRow, text: string, picked?: SkillRef, extra: RunOptions = {}): Run {
    const named = this.skillMenu.resolve(session, text, picked);
    if (!named) {
      const { rules, skills } = this.playbooks.forSession(session);
      return this.begin(session.id, text, null, null, { rules, skills, ...extra });
    }
    const run = this.begin(session.id, text, null, null, {
      rules: null,
      skills: named.copies,
      onlyHeldSkills: false,
      prompt: named.prompt,
      ...extra,
    });
    this.rememberSkill(session.id, text, named, run.createdAt);
    return run;
  }

  /** Keeps which skill a message was sent with: the transcript holds only the prompt the agent got. */
  private rememberSkill(sessionId: string, typed: string, named: ResolvedSkill, createdAt: string): void {
    this.store.write((tx) => {
      tx.insert(messageSkills)
        .values({
          id: crypto.randomUUID(),
          sessionId,
          prompt: named.prompt,
          typed,
          kind: named.ref.kind,
          name: named.ref.name,
          createdAt,
        })
        .run();
    });
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

    // The first message has nothing before it: the conversation starts over. An edited message names its skill again
    // by its leading `/name` (Behavior 21).
    const run = this.beginMessage(
      session,
      text,
      undefined,
      typeof before === 'string' ? { resumeAt: before } : { fresh: true },
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
    // A spare process `warm` started for the Session serves the message; its run takes the message's fields.
    const spare = onFinish === null ? this.takeWarm(sessionId) : null;
    const made = this.newRun(session, kind, this.accounts.forRun().id, { onFinish, onPart, options, spare });
    const run = spare ? Object.assign(spare.run, made, { warm: { query: spare.query, key: spare.key } }) : made;
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
    const executing = this.execute(run, options.prompt ?? text).finally(() => this.executing.delete(executing));
    this.executing.add(executing);
    return run;
  }

  /** A Run for a message in the Session; `spare` is the draft a warm process was started for, whose abort it keeps. */
  private newRun(
    session: SessionRow,
    kind: SessionKindHandler,
    accountId: string,
    input: {
      onFinish: ((summary: RunSummary) => void) | null;
      onPart: ((part: Part) => void) | null;
      options: RunOptions;
      spare: { run: Run } | null;
    },
  ): Run {
    const { onFinish, onPart, options, spare } = input;
    return {
      sessionId: session.id,
      messageId: crypto.randomUUID(),
      accountId,
      accessMode: session.accessMode,
      workingDir: options.cwd ?? kind.workingDir(session),
      rules: options.rules ?? null,
      skills: options.skills ?? [],
      onlyHeldSkills: options.onlyHeldSkills ?? true,
      parts: [],
      growing: null,
      outputDirty: new Set(),
      outputTimer: null,
      sdkUuids: new Set(),
      toolRows: new Map(),
      said: [],
      answer: null,
      waits: 0,
      createdAt: new Date().toISOString(),
      onFinish,
      onPart,
      serverLabel: kind.serverLabel ?? null,
      abort: spare?.run.abort ?? new AbortController(),
      stopped: false,
      paused: false,
      waitingSince: null,
      sendQueuedAfter: false,
      joinedRepo: false,
      spawnCallIds: [],
      subagents: new Map(),
      taskOfToolUse: new Map(),
      messageUsage: new Map(),
      limitSince: null,
      resumeAt: options.resumeAt ?? null,
      deny: [...(options.deny ?? []), ...(session.prAction === null ? [] : HOST_WRITE_DENIALS)],
      // A PR action Session works on pull request code: it loads none of that code's settings, hooks or servers.
      projectSettings: options.projectSettings ?? session.prAction === null,
      prAction: session.prAction,
      readOnly: options.readOnly ?? false,
      purpose: options.purpose ?? RunPurpose.Chat,
      editRoots: [],
      failure: null,
      autoTitle: null,
      fetching: null,
      warm: null,
    };
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
    const text = retry ? RETRY_TEXT : PLAY_TEXT;
    // A run that began with a skill goes on with it (Behavior 21).
    const had = this.skillOfRun(session);
    return this.send(sessionId, text, had ?? undefined);
  }

  /** The skill the Session's last run was sent with, if any. */
  private skillOfRun(session: SessionRow): SkillRef | null {
    if (session.runStartedAt === null) return null;
    const row = this.store.db
      .select({ kind: messageSkills.kind, name: messageSkills.name })
      .from(messageSkills)
      .where(and(eq(messageSkills.sessionId, session.id), eq(messageSkills.createdAt, session.runStartedAt)))
      .get();
    return row ? { kind: row.kind as SkillRef['kind'], name: row.name } : null;
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
      const transcript = await this.transcripts.messages(
        session.sdkSessionId,
        kind.workingDir(session),
        configDir,
        run?.sdkUuids,
        kind.serverLabel,
      );
      messages = this.withSkills(sessionId, transcript);
    }
    const last = messages.at(-1);
    if (!run && session.state === SessionState.Failed && last?.role === 'agent') {
      messages = [...messages.slice(0, -1), { ...last, status: 'failed' }];
    }
    if (run) {
      messages = [
        ...messages,
        {
          id: run.messageId,
          role: 'agent',
          status: 'streaming',
          parts: [...run.parts],
          created_at: run.createdAt,
        },
      ];
    }
    return messages;
  }

  /**
   * Shows a skill message as the operator typed it, with its skill, in place of the prompt the agent got. The
   * transcript's messages are shared between reads, so a changed message is a copy.
   */
  private withSkills(sessionId: string, messages: Message[]): Message[] {
    const pool = this.store.db
      .select()
      .from(messageSkills)
      .where(eq(messageSkills.sessionId, sessionId))
      .orderBy(asc(messageSkills.createdAt))
      .all();
    return messages.map((message) => {
      if (message.role !== 'user') return message;
      const first = message.parts[0];
      const at = first?.kind === 'text' ? pool.findIndex((row) => row.prompt === first.text) : -1;
      const row = at < 0 ? undefined : pool.splice(at, 1)[0];
      if (!row) return { ...message, skill: null };
      return {
        ...message,
        parts: [{ kind: 'text', text: row.typed }],
        skill: { kind: row.kind as SkillRef['kind'], name: row.name },
      };
    });
  }

  /** Runs a job's run once a place is free; any other run starts at once. */
  private async execute(run: Run, text: string): Promise<void> {
    if (run.onFinish === null) return this.executeNow(run, text);
    let release: () => void;
    try {
      release = await this.slots.acquire(run.abort.signal, (ahead) => this.noteWaiting(run, ahead));
    } catch {
      // Stopped, or the daemon is stopping, while it waited.
      return this.finish(run, 'stopped');
    }
    try {
      await this.executeNow(run, text);
    } finally {
      release();
    }
  }

  /** Says in the run's steps that it waits for a place, so the page shows why nothing happens yet. */
  private noteWaiting(run: Run, ahead: number): void {
    const text = `Waiting for a free place: ${ahead} job run${ahead === 1 ? '' : 's'} ahead`;
    run.parts.push({ kind: 'step', text });
    this.output(run, run.parts.length - 1);
  }

  private async executeNow(run: Run, text: string): Promise<void> {
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
      if (run.stopped || this.closing) return this.finish(run, 'stopped');
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

  /** The log source of the Alert the Session works on; null for a Session with none. */
  private logSourceOf(alertId: string | null): LogSource | null {
    if (alertId === null) return null;
    return (
      this.store.db.select({ connector: alerts.connector }).from(alerts).where(eq(alerts.id, alertId)).get()
        ?.connector ?? null
    );
  }

  /** The checkouts of the Repos the operator opened to the Session, apart from the folder the run works in. */
  private openedRepoFolders(session: SessionRow, workingDir: string): string[] {
    const ids = extraRepoIds(session);
    if (ids.length === 0) return [];
    const folders = new Map(
      this.store.db
        .select({ id: repoRows.id, path: repoRows.path })
        .from(repoRows)
        .where(and(inArray(repoRows.id, ids), isNull(repoRows.removedAt)))
        .all()
        .map((repo) => [repo.id, repo.path]),
    );
    return ids.flatMap((id) => folders.get(id) ?? []).filter((folder) => folder !== workingDir);
  }

  /** The MCP servers of every Connection. */
  private connectionServers(): string[] {
    return this.store.db
      .select({ name: connectionRows.name })
      .from(connectionRows)
      .all()
      .map((row) => row.name);
  }

  /** The MCP servers of Connections whose Access Level lets them write. */
  private writableConnections(): string[] {
    return this.store.db
      .select()
      .from(connectionRows)
      .all()
      .filter((row) => row.access === AccessLevel.Write)
      .map((row) => row.name);
  }

  private async runOnce(run: Run, text: string, account: AccountRow): Promise<RunResult> {
    const began = performance.now();
    const session = this.sessions.get(run.sessionId);
    const kind = this.kinds.get(session.kind);
    // The Session's own folder first: for a Repo Session, its worktree at the newest code. Other folders are ready.
    if (kind?.prepare && run.workingDir === kind.workingDir(session)) {
      await kind.prepare(session).catch((error: unknown) => {
        run.failure = error instanceof Error && error.message ? error.message : 'the Session folder is not ready';
        throw error;
      });
    }
    // The code update runs beside the rest of the start-up; `beforeTool` holds the first tool until it ends.
    run.fetching = kind?.refresh && run.workingDir === kind.workingDir(session) ? kind.refresh(session) : null;
    const { options, skillFolder, key } = await this.buildOptions(run, session, account);
    if (session.accountId !== account.id) this.sessions.write(run.sessionId, { accountId: account.id });

    // A spare process started by `warm` serves the run when it was started for the same options; otherwise it is dropped.
    const warm = run.warm;
    run.warm = null;
    if (warm && warm.key !== key) warm.query.close();
    const spare = warm && warm.key === key ? warm.query : null;

    // Stop can land while the transcript moves, before the query listens for the abort.
    if (run.stopped) {
      spare?.close();
      return 'stopped';
    }
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
    // Where the wait before the first token went: the daemon's own set-up, Claude Code and its MCP servers, the model.
    const ready = performance.now();
    let initAt: number | null = null;
    let firstTokenAt: number | null = null;
    try {
      for await (const message of spare ? spare.query(text) : this.config.sdk.query(text, options)) {
        if (message.type === 'system' && message.subtype === 'init') initAt ??= performance.now();
        if (firstTokenAt === null && (message.type === 'stream_event' || message.type === 'assistant')) {
          firstTokenAt = performance.now();
          const ms = (from: number, to: number | null) => (to === null ? 'n/a' : `${Math.round(to - from)} ms`);
          this.logger.log(
            `run of session ${run.sessionId} (${run.purpose}): set-up ${ms(began, ready)}, Claude Code and MCP servers ${ms(ready, initAt)}, model ${ms(initAt ?? ready, firstTokenAt)}`,
          );
        }
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
      // A reply that needed no tool never waited for the code update: the run still ends after it.
      await run.fetching;
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

  /**
   * What a run's Claude Code process starts with: its transcript in the account's folder, its folders, MCP servers,
   * hooks and prompt. `key` says whether two builds would start the same process, for `warm`.
   */
  private async buildOptions(
    run: Run,
    session: SessionRow,
    account: AccountRow,
  ): Promise<{ options: Options; skillFolder: string | null; key: string }> {
    const kind = this.kinds.get(session.kind);
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
    const instructions = kind?.instructions;

    const attached = this.attachments.existingFolder(run.sessionId);
    // A run the operator started writes its files for them in the Session's output folder (a read-only run has none).
    const outputFolder = run.onFinish === null && !run.readOnly ? this.outputs.ensure(run.sessionId) : null;
    // The run's Skills sit in a folder of their own that the Run sandbox lets it read.
    const skillFolder = run.skills.length > 0 ? path.join(skillRunsDir(), crypto.randomUUID()) : null;
    // The other Repos the operator opened to this Session, for a run of their own only (the output folder's rule).
    const repoFolders = outputFolder === null ? [] : this.openedRepoFolders(session, run.workingDir);
    const extraDirs = [attached, outputFolder, ...repoFolders].filter((folder) => folder !== null);
    run.editRoots = editRoots({ workingDir: run.workingDir, outputFolder, repoFolders, configDir });
    const logSource = this.logSourceOf(session.alertId);
    const scope = mcpScope(run.purpose, session.kind, logSource);
    // The console tools this run offers, for `key`: the servers' own objects cannot be compared.
    const tools: string[] = [];
    const options: Options = {
      cwd: run.workingDir,
      sandbox: runSandbox({
        workingDir: run.workingDir,
        repos: repoFolders.map((folder) => ({ path: folder, gitFile: gitFileOf(folder) })),
        readOnly: run.readOnly,
        gitFile: gitFileOf(run.workingDir),
        // A Session's own worktree commits into the Repo's git folder, which sits outside it.
        ...(kind?.ownWorktree && run.workingDir === kind.workingDir(session)
          ? { gitDirs: worktreeGitDirs(run.workingDir) }
          : {}),
      }),
      // A folder that holds pull request code never adds its own settings, hooks, servers or memory to the run.
      ...(run.projectSettings ? {} : { settingSources: ['user' as const] }),
      ...(scope.none ? { strictMcpConfig: true } : {}),
      // The operator's attached files sit outside the working folder; the agent reads them without asking.
      ...(extraDirs.length === 0 ? {} : { additionalDirectories: extraDirs }),
      ...(skillFolder === null
        ? {}
        : {
            plugins: [{ type: 'local' as const, path: skillFolder, skipMcpDiscovery: true }],
            ...(run.onlyHeldSkills ? { skills: skillNames(run.skills) } : {}),
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
        CLAUDE_CODE_MCP_STARTUP_WAIT_MS: scope.none ? '0' : MCP_STARTUP_WAIT_MS,
      },
      includePartialMessages: true,
      abortController: run.abort,
      // The console's own tools: the agent asks, the daemon pushes and opens the pull request as the operator.
      ...(() => {
        const opener = run.prAction === null && this.opener?.offers(run.sessionId, run.workingDir) ? this.opener : null;
        // A PR Session's tools: the calls that end each kind of Round.
        const prAction = run.prAction !== null && this.prActionTools ? { tools: this.prActionTools } : null;
        // Only a run the operator started: a Playbook step or a Verification in an Anonymous Session stays where it is.
        const joiner = run.onFinish === null && this.joiner?.offers(run.sessionId) ? this.joiner : null;
        // A chat the operator started, in a Session no other Session spawned.
        const spawner =
          run.onFinish === null &&
          run.purpose === RunPurpose.Chat &&
          run.prAction === null &&
          this.spawner?.offers(run.sessionId)
            ? this.spawner
            : null;
        // The browser and the Session's processes: only a chat the operator started, never a job (ADR 0007).
        const operatorChat = isOperatorChat(run);
        const browser = operatorChat && this.browserTools?.offers(run.sessionId) ? this.browserTools : null;
        const processes = operatorChat && this.processTools?.offers(run.sessionId) ? this.processTools : null;
        const saver = outputFolder === null ? null : this.outputs;
        // The integration CLIs run in the daemon, outside the sandbox, in the Session's output folder.
        const integrations =
          outputFolder === null
            ? null
            : {
                run: (input: IntegrationInput) => runCli(input.cli, input.args, outputFolder),
              };
        // New Relic read with a User API key has no MCP server: the daemon runs the query with the key.
        const newRelic =
          offersNewRelicQuery(run.purpose, logSource) && this.newRelicQuery?.offers() ? this.newRelicQuery : null;
        tools.push(
          ...Object.entries({ opener, prAction, joiner, spawner, saver, integrations, newRelic, browser, processes })
            .filter(([, offered]) => offered)
            .map(([name]) => name),
        );
        return opener || prAction || joiner || spawner || saver || integrations || newRelic || browser || processes
          ? {
              mcpServers: {
                [CONSOLE_TOOLS_SERVER]: consoleToolsServer(
                  {
                    opener,
                    prAction,
                    joiner,
                    spawner,
                    spawnCallId: () => run.spawnCallIds.shift() ?? '',
                    saver,
                    integrations,
                    newRelic,
                    browser,
                    processes,
                    signal: run.abort.signal,
                  },
                  run.sessionId,
                ),
              },
            }
          : {};
      })(),
      agents: CONSOLE_SUBAGENTS,
      disallowedTools: [
        ...MERGE_DENIALS,
        ...fileToolDenials(run.workingDir, undefined, repoFolders),
        ...(run.readOnly ? READ_ONLY_DENIALS : []),
        // Log text steers a Verification: it writes to no Git host and to no Connection (ADR 0002).
        ...(run.purpose === RunPurpose.Verify ? HOST_WRITE_DENIALS : []),
        ...run.deny,
      ],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: systemAppend(instructions, run.rules, outputFolder, repoFolders),
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
          ...(run.purpose === RunPurpose.Verify ? this.writableConnections() : []),
          ...(scope.withoutConnections ? this.connectionServers() : []),
          ...scope.withoutConnectors,
        ].map((name) => ({ serverName: name })),
      },
      hooks: {
        PreToolUse: [{ hooks: [this.beforeTool(run)] }],
        PostToolUse: [{ hooks: [this.afterTool(run)] }],
        PostToolUseFailure: [{ hooks: [this.afterTool(run)] }],
      },
      canUseTool: this.permissionPrompt(run),
    };
    return { options, skillFolder, key: optionsKey(options, tools) };
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

  /**
   * Tells the pages part `index` changed. A token arrives every few milliseconds and each event carries the whole
   * part, so sending every one would cost the daemon's one thread more with each agent running. Changes within
   * `OUTPUT_EVERY_MS` go out together (longer for a long text), each part as it stands then; nothing is lost.
   */
  private output(run: Run, index: number): void {
    run.outputDirty.add(index);
    run.outputTimer ??= setTimeout(() => this.flushOutput(run), outputEveryMs(run.parts[index]));
  }

  /** Sends the parts changed since the last send, in order. Called when the run ends, so nothing is left behind. */
  private flushOutput(run: Run): void {
    if (run.outputTimer) clearTimeout(run.outputTimer);
    run.outputTimer = null;
    const indexes = [...run.outputDirty].sort((a, b) => a - b);
    run.outputDirty.clear();
    for (const index of indexes) {
      const part = run.parts[index];
      if (part) {
        this.store.emit('session.output', {
          session_id: run.sessionId,
          message_id: run.messageId,
          part_index: index,
          part,
        });
      }
    }
  }

  private finish(run: Run, result: RunResult): void {
    this.flushOutput(run);
    this.runs.remove(run.sessionId);
    if (this.closing) return;
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
      await run.fetching;
      const toolInput = asRecord(input.tool_input);
      this.steps.start(run, {
        id: input.tool_use_id,
        agentId: input.agent_id ?? null,
        tool: input.tool_name,
        summary: stepText(input.tool_name, toolInput),
      });
      const cloudWatch = cloudWatchDenial(input.tool_name) ?? hostedLogDenial(input.tool_name);
      if (cloudWatch !== null) {
        this.steps.finish(input.tool_use_id, { ok: false, error: cloudWatch });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: cloudWatch,
          },
        };
      }
      if (input.tool_name === OPEN_PULL_REQUEST_TOOL) return this.checkPullRequest(run, toolInput, input.tool_use_id);
      const round = run.prAction === null ? undefined : prActionOfTool(input.tool_name);
      if (round !== undefined) {
        // Pressing the button was the approval: the console posts what the call says, with no second prompt.
        return this.allowLogged(run, input.tool_name, toolInput, input.tool_use_id, {
          target: 'pull request',
          command: `submit the results of ${round.replace('_', ' ')}`,
          reason: 'The console commits, pushes and posts what this call reports, as the operator.',
        });
      }
      if (input.tool_name === JOIN_REPO_TOOL) return this.approveJoinRepo(run, toolInput, input.tool_use_id);
      if (input.tool_name === SPAWN_SESSIONS_TOOL) return this.approveSpawnSessions(run, toolInput, input.tool_use_id);
      if (input.tool_name === SAVE_FILE_TOOL) return this.approveSaveFile(run, toolInput, input.tool_use_id);
      if (input.tool_name === RUN_INTEGRATION_TOOL) return this.approveIntegration(run, toolInput, input.tool_use_id);
      if (input.tool_name === START_PROCESS_TOOL) return this.approveStartProcess(run, toolInput, input.tool_use_id);
      if (input.tool_name === BROWSER_EVALUATE_TOOL) return this.approveEvaluate(run, toolInput, input.tool_use_id);
      if (input.tool_name === NEW_RELIC_QUERY_TOOL) {
        return this.allowLogged(run, input.tool_name, toolInput, input.tool_use_id, {
          target: 'New Relic',
          command: `NRQL ${redact(String(toolInput.nrql ?? ''))}`,
          reason: 'A read-only NRQL query, run by the console with its own key.',
        });
      }
      if (
        BROWSER_QUIET_TOOLS.has(input.tool_name) ||
        input.tool_name === PROCESS_OUTPUT_TOOL ||
        input.tool_name === STOP_PROCESS_TOOL
      )
        return this.allowLogged(run, input.tool_name, toolInput, input.tool_use_id);
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
          summary: isEdit
            ? `Edit ${String(input.file_path ?? input.notebook_path ?? '')}`
            : commandSummary(toolName, input),
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
   * Opening a pull request needs no Approval in any Access mode: the daemon pushes and opens at once. A call that
   * cannot open anything is refused, and the agent is told why.
   */
  private async checkPullRequest(
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
    try {
      await this.opener.describe(run.sessionId, parsed.data);
    } catch (error) {
      return refuse(error instanceof ApiError ? error.message : 'No pull request can open here.');
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'The console pushes the branch and opens the pull request without asking.',
      },
    };
  }

  /**
   * Moving into a Repo asks in every Access mode but full: the Session's work then happens in a worktree of that Repo. A
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
   * Starting Sessions in several Repos asks once for the whole list, in every Access mode but full: each Session then works in a
   * Repo and may open a pull request. A list with an unknown or repeated Repo, or a blank task, is refused before it asks.
   */
  private async approveSpawnSessions(
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
    const parsed = spawnSessionsInputSchema.safeParse(toolInput);
    if (!this.spawner || !parsed.success) {
      return refuse('No Sessions were started: give at least one entry, each with a Repo and a task.');
    }
    let summary: string;
    try {
      summary = this.spawner.describe(run.sessionId, parsed.data);
    } catch (error) {
      return refuse(`No Sessions were started: ${error instanceof ApiError ? error.message : 'none can start here'}`);
    }
    const decision = await this.ask(
      run,
      { actionLogId: null, sessionId: run.sessionId, kind: ApprovalKind.Command, summary, isProd: false },
      stepId,
    );
    const approved = decision === ApprovalStatus.Approved;
    if (approved) run.spawnCallIds.push(stepId);
    else this.steps.finish(stepId, { ok: false, error: 'denied by the operator' });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: approved ? 'allow' : 'deny',
        permissionDecisionReason: approved
          ? 'The operator approved starting the Sessions.'
          : 'The operator denied starting the Sessions. Do not ask again: the tasks stay with the operator. Say so in one line.',
      },
    };
  }

  /**
   * Saving an output file outside the run's folders asks in every Access mode but full: the daemon, outside the sandbox, writes
   * where the operator says. A call with no such file or no such folder is refused before it asks.
   */
  /**
   * `run_integration`: the daemon runs an integration CLI outside the Run sandbox (ADR 0006). The command is classified
   * by its words first. A read runs at once. A write asks in every Access mode but full, and only a chat run
   * may write: a Verification or a review reads. Sign-in, tokens, merges and anything not on the lists are refused.
   */
  private async approveIntegration(
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
    const parsed = integrationInputSchema.safeParse(toolInput);
    if (!parsed.success)
      return refuse('Give cli (pup, gh, glab, bkt or slashdocs) and args: command words first, one per entry.');
    const { cli, args } = parsed.data;
    const verdict = classifyCli(cli, args);
    if (verdict.kind === 'deny') return refuse(verdict.reason);
    const outputFolder = this.outputs.ensure(run.sessionId);
    const file = outsideFile(args, [...run.editRoots, run.workingDir, outputFolder], outputFolder);
    if (file)
      return refuse(`${file} is a file outside your folders: the CLI runs outside the sandbox and may not read it.`);
    // A PR action Session writes to the Git host only through its tool call, so its host CLIs read only.
    if (
      verdict.kind === 'write' &&
      (run.purpose !== RunPurpose.Chat || (run.prAction !== null && GIT_HOST_CLIS.has(cli)))
    ) {
      return refuse(`This run reads only: ${cli} ${args.slice(0, 2).join(' ')} changes something.`);
    }
    const command = redact(`${cli} ${args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);
    const row = this.actionLog.start({
      sessionId: run.sessionId,
      kind: ActionKind.Shell,
      target: cli,
      command: `outside the sandbox: ${command}`,
      isProd: false,
    });
    run.toolRows.set(stepId, row);
    if (verdict.kind === 'read') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'A read: the console runs it outside the sandbox.',
        },
      };
    }
    // The operator chose "don't ask again this Session" for this CLI: the guards above still held.
    if (trustedClis(this.sessions.get(run.sessionId)).includes(cli)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `The operator stopped asking about ${cli} for this Session.`,
        },
      };
    }
    const decision = await this.ask(
      run,
      {
        actionLogId: row,
        sessionId: run.sessionId,
        kind: ApprovalKind.Command,
        summary: `Run outside the sandbox, as you: ${command}`,
        isProd: false,
        trustCli: cli,
      },
      stepId,
    );
    const approved = decision === ApprovalStatus.Approved;
    if (!approved) this.steps.finish(stepId, { ok: false, error: 'denied by the operator' });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: approved ? 'allow' : 'deny',
        permissionDecisionReason: approved
          ? 'The operator approved this command.'
          : 'The operator denied this command. Do not retry it, by this tool or by a shell command.',
      },
    };
  }

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

  /** A browser or process tool that asks for nothing: a loopback page or the Session's own process. Each call is a row. */
  private allowLogged(
    run: Run,
    toolName: string,
    toolInput: Record<string, unknown>,
    stepId: string,
    as: { target: string; command: string; reason: string } = {
      target: 'session browser',
      command: stepText(toolName, toolInput),
      reason: "This tool acts on the Session's own browser and processes.",
    },
  ): HookJSONOutput {
    const row = this.actionLog.start({
      sessionId: run.sessionId,
      kind: ActionKind.Query,
      target: as.target,
      command: as.command,
      isProd: false,
    });
    run.toolRows.set(stepId, row);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: as.reason,
      },
    };
  }

  /** Starting a process asks in every Access mode but full: it runs as the operator, outside the sandbox. */
  private async approveStartProcess(
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
    const parsed = startProcessInputSchema.safeParse(toolInput);
    if (!this.processTools || !parsed.success) return refuse('Give the process a name and a command.');
    let described: { summary: string; prod: string[] };
    try {
      described = await this.processTools.describeStart(run.sessionId, parsed.data);
    } catch (error) {
      return refuse(error instanceof ApiError ? error.message : 'That process cannot start.');
    }
    // A folder whose .env names a PROD Connection shows the Approval as PROD.
    return this.askLogged(
      run,
      stepId,
      described.summary,
      ActionKind.Shell,
      'session process',
      parsed.data.command,
      described.prod.length > 0,
      {
        yes: 'The operator approved starting this process.',
        no: 'The operator denied starting this process. Do not retry it, by this tool or by a command.',
      },
    );
  }

  /** A script in the page asks in every Access mode but full: it is the one browser tool that can make a page send data out. */
  private async approveEvaluate(run: Run, toolInput: Record<string, unknown>, stepId: string): Promise<HookJSONOutput> {
    const parsed = browserEvaluateInputSchema.safeParse(toolInput);
    if (!this.browserTools || !parsed.success) {
      this.steps.finish(stepId, { ok: false, error: 'Give the script to run.' });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Give the script to run.',
        },
      };
    }
    return this.askLogged(
      run,
      stepId,
      this.browserTools.describeEvaluate(parsed.data.script),
      ActionKind.Query,
      'session browser',
      `browser_evaluate ${parsed.data.script.slice(0, 500)}`,
      false,
      {
        yes: 'The operator approved this script.',
        no: 'The operator denied this script. Do not retry it.',
      },
    );
  }

  private async askLogged(
    run: Run,
    stepId: string,
    summary: string,
    kind: ActionKind,
    target: string,
    command: string,
    isProd: boolean,
    reasons: { yes: string; no: string },
  ): Promise<HookJSONOutput> {
    const row = this.actionLog.start({ sessionId: run.sessionId, kind, target, command, isProd });
    run.toolRows.set(stepId, row);
    const decision = await this.ask(
      run,
      { actionLogId: row, sessionId: run.sessionId, kind: ApprovalKind.Command, summary, isProd },
      stepId,
    );
    const approved = decision === ApprovalStatus.Approved;
    if (!approved) this.steps.finish(stepId, { ok: false, error: 'denied by the operator' });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: approved ? 'allow' : 'deny',
        permissionDecisionReason: approved ? reasons.yes : reasons.no,
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
    // Full access asks about nothing but a PROD write: the console's own tools (integration writes, Repo moves, saved
    // files, processes, page scripts, spawned Sessions) run at once. Merge, sign-in and sandbox refusals still hold.
    if (run.accessMode === AccessMode.Full && !request.isProd) return ApprovalStatus.Approved;
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
