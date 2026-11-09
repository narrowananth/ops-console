import { z } from 'zod';
import { pageQuerySchema } from './api';
import { sessionPlaybookSchema } from './playbooks';
import { skillRefSchema } from './skills';

export enum SessionKind {
  Repo = 'repo',
  Devtools = 'devtools',
  PrReview = 'pr_review',
  /** Runs in its own folder in the data directory, with no imported Repo. */
  Anonymous = 'anonymous',
}

export enum Model {
  Opus = 'claude-opus-5-5',
  Sonnet = 'claude-sonnet-5-5',
  Haiku = 'claude-haiku-5-5',
  Fable = 'claude-fable-5-1',
}

export enum Effort {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  XHigh = 'xhigh',
  Max = 'max',
  Ultrathink = 'ultrathink',
}

export enum AccessMode {
  Supervised = 'supervised',
  AcceptEdits = 'accept_edits',
  Auto = 'auto',
  Full = 'full',
}

export enum SessionState {
  Idle = 'idle',
  Working = 'working',
  WaitingInput = 'waiting_input',
  WaitingApproval = 'waiting_approval',
  Failed = 'failed',
}

/** How a Session's last run ended. A run that ended any way but `done` stays in the Running tray until dismissed. */
export enum RunOutcome {
  Done = 'done',
  Stopped = 'stopped',
  /** Stopped by the operator to carry on later with Play. */
  Paused = 'paused',
  Failed = 'failed',
  /** The account's usage limit ended it. */
  RateLimited = 'rate_limited',
  SignedOut = 'signed_out',
  /** The daemon restarted mid-run. */
  Interrupted = 'interrupted',
}

export enum SubagentStatus {
  Working = 'working',
  Done = 'done',
  Failed = 'failed',
  Stopped = 'stopped',
}

/** What the Agent runs page says about a run: whether to look at it. */
export enum RunHealth {
  OnTrack = 'on_track',
  /** A step has gone on much longer than the same step usually takes. */
  Slow = 'slow',
  /** The agent waits for an Approval or an answer. */
  NeedsYou = 'needs_you',
  /** Ended: failed, usage limit, signed out or interrupted. */
  Failed = 'failed',
  /** Ended: the operator stopped or paused it. */
  Stopped = 'stopped',
}

/**
 * Where a run's time goes, in the order the legend lists it. Time between steps is the agent thinking; time the main
 * agent is blocked on a subagent call is `Subagents`; time lost to the account's usage limit is `WaitingLimit`.
 */
export enum RunPhase {
  Thinking = 'thinking',
  Reading = 'reading',
  Editing = 'editing',
  Commands = 'commands',
  Subagents = 'subagents',
  WaitingYou = 'waiting_you',
  WaitingLimit = 'waiting_limit',
}

/** Why a run ended badly, as far as the console can tell from what it saw. */
export enum FailureKind {
  NetworkBlocked = 'network_blocked',
  WriteBlocked = 'write_blocked',
  RateLimited = 'rate_limited',
  SignedOut = 'signed_out',
  HookFailed = 'hook_failed',
  Interrupted = 'interrupted',
  Unknown = 'unknown',
}

export enum ActionActor {
  Agent = 'agent',
  Operator = 'operator',
}

export enum ActionKind {
  Query = 'query',
  Shell = 'shell',
  Message = 'message',
  Git = 'git',
  Pr = 'pr',
  Ticket = 'ticket',
  Skill = 'skill',
}

export enum ActionOutcome {
  Pending = 'pending',
  Ok = 'ok',
  Failed = 'failed',
  Denied = 'denied',
}

export enum ApprovalKind {
  ProdWrite = 'prod_write',
  Command = 'command',
  Edit = 'edit',
}

export enum ApprovalStatus {
  Pending = 'pending',
  Approved = 'approved',
  Denied = 'denied',
  Expired = 'expired',
}

export enum SwitchReason {
  Manual = 'manual',
  Auto = 'auto',
  Smart = 'smart',
  RateLimited = 'rate_limited',
  /** The active account's sign-in stopped working mid-run. */
  SignInFailed = 'sign_in_failed',
  /** The operator disabled the active account. */
  Disabled = 'disabled',
}

const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export type Cell = z.infer<typeof cellSchema>;

export const partSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('step'), text: z.string() }),
  z.object({
    kind: z.literal('diff'),
    file: z.string(),
    lines: z.array(z.object({ sign: z.enum(['+', '-', ' ']), text: z.string() })),
  }),
  z.object({ kind: z.literal('code'), lang: z.string(), text: z.string() }),
  z.object({
    kind: z.literal('question'),
    text: z.string(),
    /** The short label the agent gave the question, such as `Fix approach`. */
    header: z.string().default(''),
    /** More than one option may be picked. */
    multi_select: z.boolean().default(false),
    options: z.array(z.object({ label: z.string(), description: z.string().default('') })),
  }),
  /** The rows one Connection gave for one question (`10-dev-tools-compare`). */
  z.object({
    kind: z.literal('result'),
    connection: z.string(),
    query: z.string().nullable(),
    columns: z.array(z.string()),
    rows: z.array(z.array(cellSchema)),
    /** Rows the query matched; `rows` holds at most 50 of them. */
    total: z.number().nullable(),
    ms: z.number().nullable(),
  }),
  /** The agent's match of Results from two or more Connections on one key. */
  z.object({
    kind: z.literal('comparison'),
    key: z.string(),
    value: z.string(),
    connections: z.array(z.string()),
    rows: z.array(
      z.object({
        field: z.string(),
        values: z.array(z.string().nullable()),
        /** Set by the console: two non-empty values differ as text. */
        differs: z.boolean(),
      }),
    ),
  }),
]);

export type Part = z.infer<typeof partSchema>;

export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'agent']),
  status: z.enum(['streaming', 'done', 'failed']),
  parts: z.array(partSchema),
  created_at: z.string(),
  /** The skill a user message was sent with, or null: it ran the Playbook. */
  skill: skillRefSchema.nullable().optional(),
});

export type Message = z.infer<typeof messageSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  kind: z.enum(SessionKind),
  title: z.string(),
  model: z.enum(Model),
  effort: z.enum(Effort),
  access_mode: z.enum(AccessMode),
  account_id: z.string().nullable(),
  /** `repo` and `pr_review` Sessions run in a Repo. */
  repo_id: z.string().nullable(),
  /** `repo` Sessions: the checked-out branch; `anonymous` Sessions: the branch of the clone, if any. */
  branch: z.string().nullable(),
  /** `pr_review` Sessions: the pull request in `repo_id`. */
  pr_number: z.number().int().nullable(),
  /** `devtools` Sessions: the Connections the agent may reach; empty means every Connection with access. Null for other kinds. */
  connection_ids: z.array(z.string()).nullable(),
  /** The Monitor Alert whose Verification or Fix runs in it; null for any other Session. */
  alert_id: z.string().nullable(),
  state: z.enum(SessionState),
  last_message_preview: z.string().nullable(),
  /** Why the last run failed, when the console can say: the Run sandbox is unavailable, or the Keychain did not answer. */
  last_error: z.string().nullable(),
  created_at: z.string(),
  last_active_at: z.string(),
  /** The Playbook its rules come from, when it is not built-in. */
  playbook: sessionPlaybookSchema.nullable(),
  /** The message queued behind the run: sent when the run ends, or held when the operator stopped it. */
  queued_message: z.string().nullable(),
});

export type Session = z.infer<typeof sessionSchema>;

/** A subagent the main agent started in a run, or one a subagent started in turn. */
export const subagentSchema = z.object({
  id: z.string(),
  /** The subagent that started this one; null when the main agent did. */
  parent_id: z.string().nullable(),
  description: z.string(),
  /** The subagent type, such as `Explore`. */
  type: z.string().nullable(),
  status: z.enum(SubagentStatus),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

export type Subagent = z.infer<typeof subagentSchema>;

/** Raw token counts, each priced on its own: the cost is never kept without them. */
export const tokenCountsSchema = z.object({
  input: z.number().int(),
  output: z.number().int(),
  cache_read: z.number().int(),
  cache_write: z.number().int(),
});

export type TokenCounts = z.infer<typeof tokenCountsSchema>;

/** What one agent of a run used: the main agent (`agent_id` null) or one subagent. */
export const agentUsageSchema = z.object({
  agent_id: z.string().nullable(),
  tokens: tokenCountsSchema,
  /** From `tokens` and the price table of the model each message ran on. */
  cost_usd: z.number(),
});

export type AgentUsage = z.infer<typeof agentUsageSchema>;

/** What a run used, from the raw token counts of every message, once each. `total` equals main plus every subagent. */
export const runUsageSchema = z.object({
  total: z.object({ tokens: tokenCountsSchema, cost_usd: z.number() }),
  main: z.object({ tokens: tokenCountsSchema, cost_usd: z.number() }),
  subagents: z.object({ tokens: tokenCountsSchema, cost_usd: z.number() }),
  by_agent: z.array(agentUsageSchema),
  /** What the SDK reported for the run, to compare with `total`; null when it gave none. */
  reported_cost_usd: z.number().nullable(),
  /** Models the run's messages ran on. */
  models: z.array(z.string()),
});

export type RunUsage = z.infer<typeof runUsageSchema>;

/** The usage limit a run ended on or waits on. */
export const runLimitSchema = z.object({
  /** When the run began to wait on the limit; null when the console did not see it. */
  since: z.string().nullable(),
  /** When the account's window resets, when the SDK said. */
  resets_at: z.string().nullable(),
});

export type RunLimit = z.infer<typeof runLimitSchema>;

/** One entry of the Running tray: a Session's run going now, or one that ended without finishing. */
export const agentRunSchema = z.object({
  session: sessionSchema,
  running: z.boolean(),
  /** How the last run ended; null while the first one is going. */
  outcome: z.enum(RunOutcome).nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  /** The Session takes messages, so the run can pause and a message can queue behind it. */
  can_resume: z.boolean(),
  /** Play or Retry can start the run again: the Session takes messages, or its kind has a way to run it again. */
  can_retry: z.boolean(),
  subagents: z.array(subagentSchema),
  health: z.enum(RunHealth),
  /** One line on why the run has this health: what it waits on, what is slow, what failed. */
  health_reason: z.string(),
  /** What the agent does now: its open step. Null when nothing is open. */
  activity: z.string().nullable(),
  /** `usage.total.cost_usd`; null when the run has no usage. */
  cost_usd: z.number().nullable(),
  /** Every token of the run: input, output, cache read and cache write. */
  tokens: z.number().int().nullable(),
  usage: runUsageSchema.nullable(),
  /** The usage limit the run waits on or ended on; null otherwise. */
  limit: runLimitSchema.nullable(),
  /** Hosts the Run sandbox refused the run's commands that are still not on the Network allowlist, first met first. */
  blocked_hosts: z.array(z.string()),
  /** Milliseconds per phase over the run, in `RunPhase` order. */
  split: z.array(z.object({ phase: z.enum(RunPhase), ms: z.number().int() })),
});

export type AgentRun = z.infer<typeof agentRunSchema>;

/** One tool call of a run: what the agent did, how long it took and whether it worked. */
export const runStepSchema = z.object({
  id: z.string(),
  /** The subagent that made the call; null for the main agent. */
  agent_id: z.string().nullable(),
  tool: z.string(),
  summary: z.string(),
  phase: z.enum(RunPhase),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  /** Milliseconds of the call spent waiting on the operator's Approval or answer. */
  waited_ms: z.number().int(),
  /** Null while the step goes. */
  ok: z.boolean().nullable(),
  error: z.string().nullable(),
});

export type RunStep = z.infer<typeof runStepSchema>;

/** Why a run is slow, in rows the page prints under "Why this run is slow". */
export const slowDiagnosisSchema = z.object({
  right_now: z.string(),
  likely_cause: z.string(),
  also: z.string().nullable(),
  suggestion: z.string(),
  /** A host the Run sandbox refused, when the run's errors name one. */
  blocked_host: z.string().nullable(),
});

/** Why a run ended badly: what happened, the likely cause and what to do, with the raw error under it. */
export const failureSchema = z.object({
  kind: z.enum(FailureKind),
  what_happened: z.string(),
  likely_cause: z.string(),
  what_to_do: z.string(),
  raw: z.string().nullable(),
  /** The host to allow, for `network_blocked`. */
  blocked_host: z.string().nullable(),
  /** When the usage window resets, for `rate_limited`, when known. */
  resets_at: z.string().nullable(),
  /** What a Retry carries on with: the subagent or step the run stopped at. Null when nothing is known. */
  resume_point: z.string().nullable(),
});

export type SlowDiagnosis = z.infer<typeof slowDiagnosisSchema>;
export type Failure = z.infer<typeof failureSchema>;

/**
 * One phase of the run's own order of work. The set is read from the run: a run that only reads and searches has no
 * Edit or Run tests. `done` means the run has evidence of it, `skipped` that the run went past it with none.
 */
export const runPhaseStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: z.enum(['done', 'now', 'skipped', 'todo']),
  /** Set on the phase an ended run stopped in: why, and the tone the marker takes. */
  stopped: z.object({ tone: z.enum(['limit', 'failed', 'stopped']), label: z.string() }).nullable(),
});

export type RunPhaseStep = z.infer<typeof runPhaseStepSchema>;

/** `GET /agent-runs/:id`: one run with its steps, where the time went and why it is slow or failed. */
export const runDetailSchema = z.object({
  run: agentRunSchema,
  steps: z.array(runStepSchema),
  stages: z.array(runPhaseStepSchema),
  slow: slowDiagnosisSchema.nullable(),
  failure: failureSchema.nullable(),
});

export type RunDetail = z.infer<typeof runDetailSchema>;

export const sessionListQuerySchema = pageQuerySchema.extend({
  kind: z.enum(SessionKind).optional(),
  q: z.string().optional(),
});

export const sessionPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    model: z.enum(Model).optional(),
    effort: z.enum(Effort).optional(),
    access_mode: z.enum(AccessMode).optional(),
    /** `devtools` Sessions only. */
    connection_ids: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type SessionPatch = z.infer<typeof sessionPatchSchema>;

export const sendMessageSchema = z.object({ text: z.string().trim().min(1), skill: skillRefSchema.optional() });

/** A file the operator attached to a message: saved in the daemon's data folder, read by the agent from `path`. */
export const attachmentSchema = z.object({ name: z.string(), path: z.string(), size: z.number().int() });
export type Attachment = z.infer<typeof attachmentSchema>;

/** A file the agent wrote in its Session's output folder for the operator. `modified_at` is an ISO time. */
export const outputFileSchema = z.object({ name: z.string(), size: z.number().int(), modified_at: z.string() });
export type OutputFile = z.infer<typeof outputFileSchema>;

const ATTACHED = 'Attached files (open each with the Read tool):';

/** A message with its attachments: the text, then one `- <name>: <path>` line per file under a heading. */
export function withAttachments(text: string, attachments: Pick<Attachment, 'name' | 'path'>[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((file) => `- ${file.name}: ${file.path}`);
  return [text.trim(), [ATTACHED, ...lines].join('\n')].filter(Boolean).join('\n\n');
}

/** The other way: a message's own text and the files listed under its heading, if any. */
export function splitAttachments(message: string): { text: string; attachments: Pick<Attachment, 'name' | 'path'>[] } {
  const at = message.lastIndexOf(ATTACHED);
  if (at === -1 || (at > 0 && !message.slice(0, at).endsWith('\n\n'))) return { text: message, attachments: [] };
  const attachments = message
    .slice(at + ATTACHED.length)
    .split('\n')
    .flatMap((line) => {
      const cut = line.lastIndexOf(': /');
      return line.startsWith('- ') && cut > 2 ? [{ name: line.slice(2, cut), path: line.slice(cut + 2) }] : [];
    });
  return { text: message.slice(0, at).trimEnd(), attachments };
}

/** Where an attached file sits in the operator's text: `[📎 <name>]`. A name holds no `]` and no line break. */
export const fileToken = (name: string) => `[📎 ${name}]`;
export const FILE_TOKEN = /\[📎 ([^\]\n]+)\]/g;

/** Text pasted past this many characters attaches as a `pasted-text.txt` file, shown as a card with its first lines. */
export const PASTE_AS_FILE_LIMIT = 3000;
/** The name a pasted text file goes under; a second one in a message is `pasted-text (2).txt`. */
export const PASTED_TEXT_NAME = /^pasted-text(?: \(\d+\))?\.txt$/;

/** A file name a token can hold: `]` and line breaks become spaces. */
export const tokenName = (name: string) => name.replace(/[\]\r\n]+/g, ' ').trim() || 'pasted';

/** The names of the files whose tokens sit in `text`, in order, each once. */
export function namesInText(text: string): string[] {
  return [...new Set([...text.matchAll(FILE_TOKEN)].map((match) => match[1] as string))];
}

/** What editing the last message did to the files before it ran again. */
export const editedMessageSchema = z.object({
  message_id: z.string(),
  /** Files put back as they were before the message; null when they could not be. */
  reverted: z.object({ files: z.array(z.string()), insertions: z.number(), deletions: z.number() }).nullable(),
  /** Why the files were not put back. */
  revert_error: z.string().nullable(),
});
export type EditedMessage = z.infer<typeof editedMessageSchema>;

export const actionLogRowSchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.enum(ActionActor),
  kind: z.enum(ActionKind),
  session_id: z.string().nullable(),
  target: z.string(),
  command: z.string(),
  is_prod: z.boolean(),
  outcome: z.enum(ActionOutcome),
  error_message: z.string().nullable(),
  finished_at: z.string().nullable(),
});

export type ActionLogRow = z.infer<typeof actionLogRowSchema>;

const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

export const actionLogQuerySchema = pageQuerySchema.extend({
  session_id: z.string().optional(),
  kind: z.enum(ActionKind).optional(),
  is_prod: booleanQuery.optional(),
  outcome: z.enum(ActionOutcome).optional(),
});

/** An edit Approval has no Action Log row: edits are not logged, so `target` and `command` are null. */
export const approvalSchema = z.object({
  id: z.string(),
  action_log_id: z.string().nullable(),
  session_id: z.string().nullable(),
  kind: z.enum(ApprovalKind),
  summary: z.string(),
  status: z.enum(ApprovalStatus),
  requested_at: z.string(),
  decided_at: z.string().nullable(),
  target: z.string().nullable(),
  command: z.string().nullable(),
  is_prod: z.boolean(),
});

export type Approval = z.infer<typeof approvalSchema>;

export const approvalListQuerySchema = pageQuerySchema.extend({ status: z.enum(ApprovalStatus).optional() });

export const approvalDecisionSchema = z.object({
  decision: z.enum([ApprovalStatus.Approved, ApprovalStatus.Denied]),
});

export const claudeAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  position: z.number().int(),
  signed_in: z.boolean(),
  signing_in: z.boolean(),
  /** A disabled account stays signed in, but no run starts or moves onto it. */
  enabled: z.boolean(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  five_hour_pct: z.number().nullable(),
  five_hour_resets_at: z.string().nullable(),
  weekly_pct: z.number().nullable(),
  weekly_resets_at: z.string().nullable(),
  usage_seen_at: z.string().nullable(),
  last_checked_at: z.string().nullable(),
  created_at: z.string(),
  is_active: z.boolean(),
  smart_note: z.string().optional(),
  /**
   * Set while a sign-in by link waits: the page anyone can sign in on (`null` until the CLI prints it) and when the
   * sign-in stops waiting. Held in memory.
   */
  sign_in_link: z.object({ url: z.string().nullable(), expires_at: z.string() }).nullable(),
});

export type ClaudeAccount = z.infer<typeof claudeAccountSchema>;

/**
 * How a Claude account signs in: `browser` opens Anthropic's page in a browser tab on this Mac; `link` gives a link
 * to open in any browser, and the code Anthropic shows there is pasted back.
 */
export enum SignInVia {
  Browser = 'browser',
  Link = 'link',
}

/** `POST /agent-accounts/:id/logins` */
export const startLoginSchema = z.object({ via: z.enum(SignInVia).default(SignInVia.Browser) });

/** `PATCH /agent-accounts/:id` */
export const accountPatchSchema = z.object({ enabled: z.boolean() });

/** `POST /agent-accounts/:id/logins/code`: the code Anthropic showed, or the address of the page it showed it on. */
export const signInCodeSchema = z.object({ code: z.string().trim().min(1).max(4096) });

export const smartPickSchema = z.object({ account_id: z.string(), reason: z.string() });

export type SmartPick = z.infer<typeof smartPickSchema>;

export const accountListSchema = z.object({
  data: z.array(claudeAccountSchema),
  meta: z.object({
    next_cursor: z.null(),
    active_account_id: z.string().nullable(),
    smart_pick: smartPickSchema.nullable(),
  }),
});

export const addedAccountSchema = z.object({ account: claudeAccountSchema, sign_in_command: z.string() });

/** `PATCH /settings` key `session_defaults`. */
export const sessionDefaultsSchema = z.object({
  model: z.enum(Model),
  effort: z.enum(Effort),
  access_mode: z.enum(AccessMode),
});

export type SessionDefaults = z.infer<typeof sessionDefaultsSchema>;

export const SESSION_DEFAULTS: SessionDefaults = {
  model: Model.Sonnet,
  effort: Effort.High,
  access_mode: AccessMode.Supervised,
};

/** `PATCH /settings` key `agent_accounts`. */
export const agentAccountsSettingSchema = z.object({
  active_account_id: z.string().min(1).nullable(),
  auto_switch: z.boolean(),
  threshold: z.number().min(50).max(100),
  smart_usage: z.boolean(),
});

export type AgentAccountsSetting = z.infer<typeof agentAccountsSettingSchema>;

/** An address on this Mac (ADR 0003): prompts and code go there, so a remote one is refused. */
export const LOCAL_ADDRESS = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/?$/;

/**
 * `PATCH /settings` key `cliproxy`. On, the agent signs in to Claude through the CLIProxy server at `address` in place
 * of the Claude accounts, and CLIProxy picks the account and tracks the quota.
 */
export const cliProxySettingSchema = z.object({
  enabled: z.boolean(),
  address: z.string().trim().regex(LOCAL_ADDRESS, 'an address on this Mac, such as http://127.0.0.1:8317'),
});

export type CliProxySetting = z.infer<typeof cliProxySettingSchema>;

export enum CliProxyStatus {
  /** Answered with the saved key. */
  Connected = 'connected',
  /** No key saved yet. */
  NoKey = 'no_key',
  /** Not checked since the daemon started or the address or key changed. */
  Unchecked = 'unchecked',
  /** Answered, but refused the key. */
  Refused = 'refused',
  /** Nothing answered at the address. */
  Unreachable = 'unreachable',
}

/** `GET /cliproxy`. The key itself never leaves the Keychain (ADR 0004). */
export const cliProxySchema = z.object({
  enabled: z.boolean(),
  address: z.string(),
  has_key: z.boolean(),
  status: z.enum(CliProxyStatus),
  status_detail: z.string().nullable(),
  checked_at: z.string().nullable(),
});

export type CliProxy = z.infer<typeof cliProxySchema>;

/** `PUT /cliproxy/key`: one of the keys in CLIProxy's `access.api-keys`. */
export const cliProxyKeySchema = z.object({ key: z.string().trim().min(1).max(512) });

/** What a run was for, kept with its usage so the dashboard can say where the credit went. */
export enum RunPurpose {
  /** A message the operator sent in a Session. */
  Chat = 'chat',
  Verify = 'verify',
  Fix = 'fix',
  CommentPass = 'comment_pass',
  ReplyCheck = 'reply_check',
  AgentReview = 'agent_review',
  OpenPullRequest = 'open_pull_request',
}

export enum UsageRange {
  Today = 'today',
  Week = '7d',
  Month = '30d',
  /** The longest range: usage is kept 90 days. */
  Quarter = '90d',
}

/** `GET /agent-accounts/usage`: `account` is an account id, or `none` for runs that have no account. */
export const accountUsageQuerySchema = z.object({
  range: z.enum(UsageRange).default(UsageRange.Week),
  account: z.string().min(1).optional(),
});

export type AccountUsageQuery = z.infer<typeof accountUsageQuerySchema>;

const accountIdOrNull = z.string().nullable();

/** What the console recorded for the accounts in a range: totals, per day, per account, per kind and per agent. */
export const accountUsageSchema = z.object({
  range: z.enum(UsageRange),
  account_id: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  totals: z.object({
    /** Raw counts of the runs that kept them. */
    tokens: tokenCountsSchema,
    /** Every token of every run, kept raw or not. */
    total_tokens: z.number(),
    cost_usd: z.number(),
    runs: z.number().int(),
    subagents: z.number().int(),
  }),
  days: z.array(
    z.object({
      date: z.string(),
      cost_usd: z.number(),
      tokens: z.number(),
      runs: z.number().int(),
      by_account: z.array(z.object({ account_id: accountIdOrNull, cost_usd: z.number() })),
      by_work: z.array(z.object({ work: z.string(), cost_usd: z.number() })),
    }),
  ),
  accounts: z.array(
    z.object({
      account_id: accountIdOrNull,
      label: z.string(),
      removed: z.boolean(),
      enabled: z.boolean(),
      tokens: z.number(),
      cost_usd: z.number(),
      runs: z.number().int(),
      subagents: z.number().int(),
    }),
  ),
  /**
   * What the runs were for. `work` is a `RunPurpose`, or `kind:<session kind>` for a run kept before purposes were
   * recorded, which knows only its Session's kind.
   */
  work: z.array(
    z.object({
      work: z.string(),
      tokens: z.number(),
      cost_usd: z.number(),
      runs: z.number().int(),
      subagents: z.number().int(),
    }),
  ),
  subagent_types: z.array(
    z.object({
      type: z.string().nullable(),
      /** The main agents of every run, which have no type. */
      main: z.boolean(),
      tokens: z.number(),
      cost_usd: z.number(),
      agents: z.number().int(),
      /** Subagents of this type that failed; 0 for main agents. */
      failed: z.number().int(),
      /** How long the finished ones took, on average; null when none finished or none was timed. */
      avg_ms: z.number().nullable(),
    }),
  ),
  runs: z.array(
    z.object({
      session_id: z.string(),
      title: z.string(),
      kind: z.string(),
      /** As `work` above. */
      work: z.string(),
      account_id: accountIdOrNull,
      finished_at: z.string(),
      tokens: z.number(),
      cost_usd: z.number(),
      subagents: z.number().int(),
      agents: z.array(
        z.object({
          agent_id: z.string().nullable(),
          /** The subagent that started this one; null for the main agent and for a subagent the main agent started. */
          parent_id: z.string().nullable(),
          type: z.string().nullable(),
          description: z.string().nullable(),
          status: z.enum(SubagentStatus).nullable(),
          started_at: z.string().nullable(),
          finished_at: z.string().nullable(),
          tokens: z.number(),
          cost_usd: z.number(),
        }),
      ),
    }),
  ),
});

export type AccountUsageReport = z.infer<typeof accountUsageSchema>;

/** The most characters one paste into a Skill or Playbook field may hold; a longer paste is refused with an error. */
export const EDITOR_PASTE_LIMIT = 5000;
/** The most characters a terminal prompt holds; a longer paste is cut to it. */
export const TERMINAL_TEXT_LIMIT = 10000;
/** The most characters a pull request description holds; a longer paste is cut to it, with an error. */
export const PR_DESCRIPTION_LIMIT = 3000;
