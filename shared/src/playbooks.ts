import { z } from 'zod';

/** A place in a tab that starts the agent. Each holds one Playbook, or its built-in. */
export enum PlaybookTrigger {
  Verify = 'verify',
  Fix = 'fix',
  ReviewPr = 'review_pr',
  CheckReply = 'check_reply',
  AddressComments = 'address_comments',
  ThreadReply = 'thread_reply',
  SessionMessage = 'session_message',
}

/** Triggers in the order the Playbooks page lists them. */
export const PLAYBOOK_TRIGGERS: PlaybookTrigger[] = Object.values(PlaybookTrigger);

/** Triggers that start a job with an end; only these run steps. The rest are chats and use rules only. */
export const JOB_TRIGGERS: readonly PlaybookTrigger[] = [
  PlaybookTrigger.Verify,
  PlaybookTrigger.Fix,
  PlaybookTrigger.ReviewPr,
  PlaybookTrigger.CheckReply,
  PlaybookTrigger.AddressComments,
];

export const TRIGGER_LABELS: Record<PlaybookTrigger, { tab: string; label: string }> = {
  [PlaybookTrigger.Verify]: { tab: 'Monitor', label: 'Verify' },
  [PlaybookTrigger.Fix]: { tab: 'Monitor', label: 'Fix' },
  [PlaybookTrigger.ReviewPr]: { tab: 'Workspace', label: 'Review PR' },
  [PlaybookTrigger.CheckReply]: { tab: 'Workspace', label: 'Check reply' },
  [PlaybookTrigger.AddressComments]: { tab: 'Workspace', label: 'Address comments' },
  [PlaybookTrigger.ThreadReply]: { tab: 'Workspace', label: 'Reply in thread' },
  [PlaybookTrigger.SessionMessage]: { tab: 'Workspace', label: 'Session message' },
};

/** The ready-made steps on the Playbooks page, and `custom` for one written from nothing or by a built-in. */
export enum StepBlock {
  TraceLog = 'trace_log',
  FindOwner = 'find_owner',
  FindUsers = 'find_users',
  ReadConnections = 'read_connections',
  ReplayRequest = 'replay_request',
  MakeMockData = 'make_mock_data',
  RunTests = 'run_tests',
  TestLastingFix = 'test_lasting_fix',
  CheckProdReadiness = 'check_prod_readiness',
  Custom = 'custom',
}

export const PLAYBOOK_LIMITS = {
  name: 60,
  rules: 8000,
  steps: 12,
  title: 80,
  instructions: 4000,
  summary: 500,
} as const;

export const playbookStepSchema = z.object({
  block: z.enum(StepBlock),
  title: z.string().trim().min(1).max(PLAYBOOK_LIMITS.title),
  instructions: z.string().trim().min(1).max(PLAYBOOK_LIMITS.instructions),
  /** The "scratch copy" tag: the step writes files or runs commands. */
  writes: z.boolean(),
});

export type PlaybookStep = z.infer<typeof playbookStepSchema>;

export const playbookSchema = z.object({
  /** A uuid, or `builtin:<trigger>`. */
  id: z.string(),
  builtin: z.boolean(),
  name: z.string(),
  rules: z.string(),
  steps: z.array(playbookStepSchema),
  /** The Triggers holding it now. A built-in lists its Trigger when no Playbook holds it. */
  triggers: z.array(z.enum(PlaybookTrigger)),
  /** Null on a built-in. */
  updated_at: z.string().nullable(),
});

export type Playbook = z.infer<typeof playbookSchema>;

export const playbookListSchema = z.object({
  /** The operator's Playbooks A to Z, then the built-ins in Trigger order. */
  items: z.array(playbookSchema),
  /** The Step blocks, in the page's order. Custom step has no instructions yet. */
  blocks: z.array(playbookStepSchema.extend({ instructions: z.string() })),
});

export type PlaybookList = z.infer<typeof playbookListSchema>;

const nameSchema = z.string().trim().min(1).max(PLAYBOOK_LIMITS.name);
const rulesSchema = z.string().max(PLAYBOOK_LIMITS.rules);
const stepsSchema = z.array(playbookStepSchema).max(PLAYBOOK_LIMITS.steps);

export const createPlaybookSchema = z
  .object({ name: nameSchema, rules: rulesSchema.default(''), steps: stepsSchema.default([]) })
  .strict();

export type CreatePlaybook = z.input<typeof createPlaybookSchema>;

export const playbookPatchSchema = z
  .object({ name: nameSchema.optional(), rules: rulesSchema.optional(), steps: stepsSchema.optional() })
  .strict();

export type PlaybookPatch = z.infer<typeof playbookPatchSchema>;

export const setTriggerSchema = z.object({ playbook_id: z.string().min(1).nullable() }).strict();

export enum PlaybookStepStatus {
  Pending = 'pending',
  Running = 'running',
  Done = 'done',
  Skipped = 'skipped',
  Failed = 'failed',
}

/** The Playbook a job ran, as copied when it started. */
export const jobPlaybookSchema = z.object({
  /** Null for a built-in and once the Playbook is deleted. */
  id: z.string().nullable(),
  name: z.string(),
  steps: z.array(
    z.object({
      title: z.string(),
      writes: z.boolean(),
      status: z.enum(PlaybookStepStatus),
      summary: z.string().nullable(),
    }),
  ),
});

export type JobPlaybook = z.infer<typeof jobPlaybookSchema>;

/** The Playbook a Session's rules come from, when it is not built-in. */
export const sessionPlaybookSchema = z.object({ id: z.string(), name: z.string() });
