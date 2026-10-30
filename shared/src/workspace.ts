import { z } from 'zod';
import { AccessMode, Effort, Model, SessionKind, sessionSchema } from './agents';
import { GitHost } from './repos';

export enum AgentReviewStatus {
  Running = 'running',
  Ready = 'ready',
  Failed = 'failed',
}

export enum FindingSeverity {
  Blocker = 'blocker',
  Suggestion = 'suggestion',
  Nit = 'nit',
}

export enum PrState {
  Open = 'open',
  Merged = 'merged',
  Closed = 'closed',
}

export enum PrReviewState {
  None = 'none',
  Approved = 'approved',
  ChangesRequested = 'changes_requested',
}

export enum PrChecks {
  None = 'none',
  Running = 'running',
  Passed = 'passed',
  Failed = 'failed',
}

export enum PrReviewEvent {
  Approve = 'approve',
  RequestChanges = 'request_changes',
  Comment = 'comment',
}

export const findingSchema = z.object({
  severity: z.enum(FindingSeverity),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  text: z.string(),
  /** The host's id of the comment this finding became. */
  comment_id: z.string().nullable(),
  post_error: z.string().nullable(),
});

export type Finding = z.infer<typeof findingSchema>;

export const checklistItemSchema = z.object({
  item: z.string(),
  status: z.enum(['pass', 'warn', 'fail', 'na']),
  note: z.string(),
});

export const toolUseSchema = z.object({ connection: z.string(), query: z.string(), result: z.string() });

export const prAgentReviewSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  pr_number: z.number().int(),
  head_sha: z.string(),
  status: z.enum(AgentReviewStatus),
  verdict: z.string().nullable(),
  findings: z.array(findingSchema),
  checklist: z.array(checklistItemSchema),
  tools: z.array(toolUseSchema),
  created_at: z.string(),
  /** The pull request moved on to another commit. */
  stale: z.boolean(),
});

export type PrAgentReview = z.infer<typeof prAgentReviewSchema>;

export const prCommentSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  author: z.string(),
  by_agent: z.boolean(),
  body: z.string(),
  file_path: z.string().nullable(),
  line: z.number().int().nullable(),
  /** Thread roots only; replies read `false`. */
  resolved: z.boolean(),
  created_at: z.string(),
  reply_count: z.number().int(),
});

export type PrComment = z.infer<typeof prCommentSchema>;

export const prFileSchema = z.object({
  name: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  lines: z.array(z.object({ sign: z.enum(['+', '-', ' ']), text: z.string() })),
});

export type PrFile = z.infer<typeof prFileSchema>;

export const pullRequestSchema = z.object({
  repo_id: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  author: z.string(),
  branch: z.string(),
  base_branch: z.string(),
  head_sha: z.string(),
  state: z.enum(PrState),
  review_state: z.enum(PrReviewState),
  checks: z.enum(PrChecks),
  additions: z.number().int(),
  deletions: z.number().int(),
  body: z.string(),
  opened_at: z.string(),
  merged_at: z.string().nullable(),
  is_mine: z.boolean(),
  by_agent: z.boolean(),
  comment_count: z.number().int(),
  resolved_count: z.number().int(),
  /** The `pr_review` Session, or null before the agent first speaks on this pull request. */
  agent_session_id: z.string().nullable(),
  latest_agent_review: prAgentReviewSchema.nullable(),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;

export const pullRequestDetailSchema = pullRequestSchema.extend({
  files: z.array(prFileSchema),
  comments: z.array(prCommentSchema),
});

export type PullRequestDetail = z.infer<typeof pullRequestDetailSchema>;

export const pullRequestListSchema = z.object({
  data: z.array(pullRequestSchema),
  meta: z.object({ synced_at: z.string().nullable(), stale: z.boolean(), next_cursor: z.null() }),
});

/** `pr_review` Sessions are made by the backend, never by a request. */
export const createRepoSessionSchema = z.strictObject({
  kind: z.literal(SessionKind.Repo).optional(),
  repo_id: z.string().min(1),
  branch: z.string().trim().min(1),
  model: z.enum(Model).optional(),
  effort: z.enum(Effort).optional(),
  access_mode: z.enum(AccessMode).optional(),
});

export type CreateRepoSession = z.infer<typeof createRepoSessionSchema>;

export const checkoutSchema = z.object({ branch: z.string().trim().min(1), create: z.boolean().default(false) });

export const checkoutResultSchema = z.object({ session: sessionSchema, stashed: z.boolean() });

export const pullRequestQuerySchema = z.object({
  repo_id: z.string().optional(),
  state: z.enum(PrState).default(PrState.Open),
  mine: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  q: z.string().optional(),
});

export const refreshPullRequestsSchema = z.object({ repo_id: z.string().optional() });

export const postCommentSchema = z.object({
  body: z.string().trim().min(1),
  file_path: z.string().min(1).optional(),
  line: z.number().int().min(1).optional(),
  parent_id: z.string().min(1).optional(),
});

export const resolveCommentSchema = z.object({ resolved: z.boolean() });

export const reviewPullRequestSchema = z.object({
  event: z.enum(PrReviewEvent),
  body: z.string().trim().optional(),
});

export const prRefreshStatus = z.enum(['ok', 'rate_limited', 'failed']);

/** Hosts that serve pull requests; `local` has none. */
export const PR_HOSTS: GitHost[] = [GitHost.Github, GitHost.Gitlab, GitHost.Bitbucket];
