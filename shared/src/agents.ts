import { z } from 'zod';
import { pageQuerySchema } from './api';
import { sessionPlaybookSchema } from './playbooks';

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
  created_at: z.string(),
  last_active_at: z.string(),
  /** The Playbook its rules come from, when it is not built-in. */
  playbook: sessionPlaybookSchema.nullable(),
});

export type Session = z.infer<typeof sessionSchema>;

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

export const sendMessageSchema = z.object({ text: z.string().trim().min(1) });

/** A file the operator attached to a message: saved in the daemon's data folder, read by the agent from `path`. */
export const attachmentSchema = z.object({ name: z.string(), path: z.string(), size: z.number().int() });
export type Attachment = z.infer<typeof attachmentSchema>;

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
});

export type ClaudeAccount = z.infer<typeof claudeAccountSchema>;

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
