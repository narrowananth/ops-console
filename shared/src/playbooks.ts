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
  branches: 200,
} as const;

/** A branch name the console passes to git: no option, no `..`, no space. */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[\w./-]+$/;

/** A Playbook's Branch field as the names it lists, in order; blank lists none. */
export function branchList(branches: string): string[] {
  return branches
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

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
  /**
   * The branches Verify and Fix read the code from, comma-separated and tried in order: the first one origin has.
   * Blank: the Repo's default branch.
   */
  branches: z.string(),
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
const branchesSchema = z
  .string()
  .trim()
  .max(PLAYBOOK_LIMITS.branches)
  .refine((value) => branchList(value).every((name) => BRANCH_NAME.test(name)), 'not a branch name');

export const createPlaybookSchema = z
  .object({
    name: nameSchema,
    rules: rulesSchema.default(''),
    branches: branchesSchema.default(''),
    steps: stepsSchema.default([]),
  })
  .strict();

export type CreatePlaybook = z.input<typeof createPlaybookSchema>;

export const playbookPatchSchema = z
  .object({
    name: nameSchema.optional(),
    rules: rulesSchema.optional(),
    branches: branchesSchema.optional(),
    steps: stepsSchema.optional(),
  })
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

/** A failed job's retry. `skip` first marks the failed step skipped by the operator, so the job goes on after it. */
export const retryJobSchema = z.object({ skip: z.boolean().default(false) }).strict();

export type RetryJob = z.infer<typeof retryJobSchema>;

/** The Playbook a Session's rules come from, when it is not built-in. */
export const sessionPlaybookSchema = z.object({ id: z.string(), name: z.string() });

/**
 * The console's rule for pull request descriptions. Every agent run gets it, a Session's chat, a Fix, a PR job, before
 * the Playbook's rules, so a Playbook can add to it.
 */
export const PR_DESCRIPTION_RULE = `Pull request descriptions. Whenever you open a pull request, or are asked to write or update its description, write it in depth for a reviewer who has not seen this work:
- Summary: what changes and why, in two to four sentences.
- Problem or root cause: what was wrong or missing, where (file and line), and how it showed (the error, the Alert, the ticket).
- Changes: each file or area touched and what changed in it, and any design choice a reviewer could question, with why.
- Testing: the commands you ran and their results, tests added or changed, and what was not tested and why.
- Risk and rollback: what could break, who or what is affected, and how to undo it.
- Links: the Jira ticket, the Alert or Report, related pull requests.
Use the Repo's pull request template when it has one (such as .github/pull_request_template.md) and fill each of its sections to the same depth. Leave out a section only when it does not apply. Never a one-line description.`;
