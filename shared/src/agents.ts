import { z } from 'zod';
import { pageQuerySchema } from './api';

export enum SessionKind {
  Repo = 'repo',
  Devtools = 'devtools',
  PrReview = 'pr_review',
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
}

export const partSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('step'), text: z.string() }),
  z.object({
    kind: z.literal('diff'),
    file: z.string(),
    lines: z.array(z.object({ sign: z.enum(['+', '-', ' ']), text: z.string() })),
  }),
  z.object({ kind: z.literal('code'), lang: z.string(), text: z.string() }),
  z.object({ kind: z.literal('question'), text: z.string(), options: z.array(z.string()) }),
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
  state: z.enum(SessionState),
  last_message_preview: z.string().nullable(),
  created_at: z.string(),
  last_active_at: z.string(),
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
  })
  .strict();

export type SessionPatch = z.infer<typeof sessionPatchSchema>;

export const sendMessageSchema = z.object({ text: z.string().trim().min(1) });

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
    active_account_id: z.string(),
    smart_pick: smartPickSchema.nullable(),
  }),
});

export const addAccountSchema = z.object({ label: z.string().trim().min(1).max(60) });

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
  active_account_id: z.string().min(1),
  auto_switch: z.boolean(),
  threshold: z.number().min(50).max(100),
  smart_usage: z.boolean(),
});

export type AgentAccountsSetting = z.infer<typeof agentAccountsSettingSchema>;
