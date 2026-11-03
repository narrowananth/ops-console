import { z } from 'zod';
import { AccessMode, Effort, Model, SessionKind, sessionSchema } from './agents';
import { jobPlaybookSchema } from './playbooks';
import { GitHost } from './repos';

export enum AgentReviewStatus {
  Running = 'running',
  Ready = 'ready',
  Failed = 'failed',
}

/** How much a review finding matters, worst first. */
export enum FindingSeverity {
  Critical = 'critical',
  High = 'high',
  Medium = 'medium',
  Low = 'low',
  Info = 'info',
}

/** Severities worst first, for counts and sorting. */
export const FINDING_SEVERITIES: FindingSeverity[] = Object.values(FindingSeverity);

/** An Agent Review's overall answer. */
export enum ReviewVerdict {
  Approve = 'approve',
  RequestChanges = 'request_changes',
  Comment = 'comment',
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
  /** Null until ready, and on reviews from before verdicts. */
  decision: z.enum(ReviewVerdict).nullable(),
  /** The verdict in one sentence. */
  verdict: z.string().nullable(),
  /** The production branch the change was compared with, and the commit it was at. Null when it could not be read. */
  base_branch: z.string().nullable(),
  base_sha: z.string().nullable(),
  /** The full review as Markdown; also posted on the pull request. */
  report: z.string().nullable(),
  /** Why a failed review stopped; null when it gave no reason. */
  error: z.string().nullable(),
  findings: z.array(findingSchema),
  checklist: z.array(checklistItemSchema),
  tools: z.array(toolUseSchema),
  created_at: z.string(),
  /** The pull request moved on to another commit. */
  stale: z.boolean(),
  /** Null on Agent Reviews from before Playbooks. */
  playbook: jobPlaybookSchema.nullable(),
});

export type PrAgentReview = z.infer<typeof prAgentReviewSchema>;

export const prCommentSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  author: z.string(),
  by_agent: z.boolean(),
  /** Written by the operator or the agent, both signed in as the operator: the ones the operator can delete. */
  is_mine: z.boolean(),
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
  /** The imported Repo it belongs to; null for a repository on the host that is not imported. */
  repo_id: z.string().nullable(),
  host: z.enum(GitHost),
  /** The repository on the host, `owner/name` (GitLab: `group/subgroup/name`). */
  slug: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  author: z.string(),
  branch: z.string(),
  base_branch: z.string(),
  head_sha: z.string(),
  state: z.enum(PrState),
  review_state: z.enum(PrReviewState),
  /** Who approved it, as the Git host names them. */
  approved_by: z.array(z.string()),
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

export enum ReplyVerdict {
  Fixed = 'fixed',
  PartlyFixed = 'partly_fixed',
  NotFixed = 'not_fixed',
}

/** One Reply check: the agent's verdict on one thread, posted as a reply. */
export const replyCheckSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  pr_number: z.number().int(),
  /** The thread's root comment. */
  comment_id: z.string(),
  head_sha: z.string(),
  status: z.enum(AgentReviewStatus),
  verdict: z.enum(ReplyVerdict).nullable(),
  reply: z.string().nullable(),
  resolved: z.boolean(),
  error: z.string().nullable(),
  can_retry: z.boolean(),
  created_at: z.string(),
  playbook: jobPlaybookSchema.nullable(),
});

export type ReplyCheck = z.infer<typeof replyCheckSchema>;

export enum ThreadOutcome {
  Pending = 'pending',
  /** Address comments. */
  Done = 'done',
  Declined = 'declined',
  /** Check replies: the reply's claim holds, holds in part, or does not. */
  Fixed = 'fixed',
  PartlyFixed = 'partly_fixed',
  NotFixed = 'not_fixed',
}

export enum CommentPassKind {
  /** The agent changes code for the ticked threads; one commit, one push. */
  Address = 'address',
  /** The agent checks every replied thread against the head commit and gives each a verdict. Reads only. */
  Check = 'check',
}

export const passThreadSchema = z.object({
  comment_id: z.string(),
  /** Null for a general comment on the pull request; `line` also for one on a whole file. */
  file_path: z.string().nullable(),
  line: z.number().int().nullable(),
  author: z.string(),
  /** The first line of the thread's first comment. */
  excerpt: z.string(),
  outcome: z.enum(ThreadOutcome),
  reply: z.string().nullable(),
  posted: z.boolean(),
  resolved: z.boolean(),
});

export type PassThread = z.infer<typeof passThreadSchema>;

/** One Comment pass over the threads the operator ticked on a pull request. */
export const commentPassSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  pr_number: z.number().int(),
  kind: z.enum(CommentPassKind),
  head_sha: z.string(),
  status: z.enum(AgentReviewStatus),
  /** Null until pushed, and when there was nothing to commit. */
  commit_sha: z.string().nullable(),
  threads: z.array(passThreadSchema),
  error: z.string().nullable(),
  can_retry: z.boolean(),
  /** The pull request's head is neither the commit it started from nor the one it pushed. */
  stale: z.boolean(),
  created_at: z.string(),
  playbook: jobPlaybookSchema.nullable(),
});

export type CommentPass = z.infer<typeof commentPassSchema>;

export const pullRequestDetailSchema = pullRequestSchema.extend({
  repo_id: z.string(),
  files: z.array(prFileSchema),
  comments: z.array(prCommentSchema),
  /** The newest Reply check of each thread. */
  reply_checks: z.array(replyCheckSchema),
  /** Newest first. */
  comment_passes: z.array(commentPassSchema),
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
  /** A branch only origin has, as a pull request's, is fetched and made a local branch tracking it. */
  from_origin: z.boolean().optional(),
  model: z.enum(Model).optional(),
  effort: z.enum(Effort).optional(),
  access_mode: z.enum(AccessMode).optional(),
});

export type CreateRepoSession = z.infer<typeof createRepoSessionSchema>;

/** A Session with no imported Repo: the agent works in a folder of its own, and may clone into it. */
export const createAnonymousSessionSchema = z.strictObject({
  kind: z.literal(SessionKind.Anonymous),
  title: z.string().trim().min(1).max(200).optional(),
  model: z.enum(Model).optional(),
  effort: z.enum(Effort).optional(),
  access_mode: z.enum(AccessMode).optional(),
});

export type CreateAnonymousSession = z.infer<typeof createAnonymousSessionSchema>;

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

/** `GET /repos/:repo/pull-requests/:number/file`: one file of the pull request at a commit. */
export const prFileQuerySchema = z.object({
  path: z.string().min(1),
  /** A commit id; the pull request's `head_sha`. */
  ref: z.string().regex(/^[0-9a-f]{7,40}$/i),
});

export const prFileContentSchema = z.object({
  path: z.string(),
  ref: z.string(),
  /** Null when the file is not there at `ref`, as for a deleted file. */
  text: z.string().nullable(),
});

export type PrFileContent = z.infer<typeof prFileContentSchema>;

export const postCommentSchema = z.object({
  body: z.string().trim().min(1),
  file_path: z.string().min(1).optional(),
  line: z.number().int().min(1).optional(),
  parent_id: z.string().min(1).optional(),
});

export const resolveCommentSchema = z.object({ resolved: z.boolean() });

export const startReplyCheckSchema = z.object({ comment_id: z.string().min(1) });

export const startCommentPassSchema = z.object({ comment_ids: z.array(z.string().min(1)).min(1) });

export const reviewPullRequestSchema = z.object({
  event: z.enum(PrReviewEvent),
  body: z.string().trim().optional(),
});

export const prRefreshStatus = z.enum(['ok', 'rate_limited', 'failed']);

/** Hosts that serve pull requests; `local` has none. */
export const PR_HOSTS: GitHost[] = [GitHost.Github, GitHost.Gitlab, GitHost.Bitbucket];
