import { z } from 'zod';
import { AccessMode, Effort, Model, PrAction, SessionKind, sessionSchema } from './agents';
import { GitHost } from './repos';

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

/** The agent's submitted review of a pull request, tied to the commit it read. */
export const prAgentReviewSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  pr_number: z.number().int(),
  head_sha: z.string(),
  /** The PR Session that submitted it; null once that Session is deleted. */
  session_id: z.string().nullable(),
  decision: z.enum(ReviewVerdict).nullable(),
  /** The verdict in one sentence. */
  verdict: z.string().nullable(),
  /** The production branch the change was compared with, and the commit it was at. Null when it could not be read. */
  base_branch: z.string().nullable(),
  base_sha: z.string().nullable(),
  /** The full review as Markdown; also posted on the pull request. */
  report: z.string().nullable(),
  findings: z.array(findingSchema),
  created_at: z.string(),
  /** The pull request moved on to another commit. */
  stale: z.boolean(),
  /** What the operator told the agent when starting: where to look, a related pull request. Null when left empty. */
  note: z.string().nullable(),
});

/** `POST .../action-sessions`: which button, the threads Address comments covers, the Review note. */
export const startPrActionSchema = z
  .object({
    action: z.enum(PrAction),
    comment_ids: z.array(z.string().min(1)).optional(),
    note: z.string().trim().optional(),
  })
  .strict();

export type StartPrAction = z.infer<typeof startPrActionSchema>;

/** Where a PR Session's current Round stands: the turn runs (also after a submit), it is idle with nothing posted, or its tool call posted everything. */
export enum PrActionState {
  Working = 'working',
  NotSubmitted = 'not_submitted',
  Submitted = 'submitted',
}

export const prActionSessionSchema = z.object({
  session_id: z.string(),
  action: z.enum(PrAction),
  state: z.enum(PrActionState),
  /** The commit an Address comments Session pushed; null before, and when nothing was committed. */
  commit_sha: z.string().nullable(),
  /** The pull request's head moved past the commit the Session started at, or the one it pushed. */
  stale: z.boolean(),
  created_at: z.string(),
});

export type PrActionSession = z.infer<typeof prActionSessionSchema>;

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
  /** Thread roots only. The host's own flag that a later commit moved or removed the line; null when it does not say. */
  outdated: z.boolean().nullable(),
  /** Thread roots only. The diff hunk the comment is on, ending at its line; null when the host gives none. */
  hunk: z.string().nullable(),
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

/** One commit on a pull request's branch that its base lacks, as the Git host lists it. */
export const prCommitSchema = z.object({
  sha: z.string(),
  /** The first line of the message. */
  message: z.string(),
  author: z.string(),
  created_at: z.string(),
  /** The commit's page on the host. */
  url: z.string().nullable(),
});

export type PrCommit = z.infer<typeof prCommitSchema>;

export enum PrMergeState {
  /** The console is reading it now; the page reads again when it knows. */
  Checking = 'checking',
  Clean = 'clean',
  Conflict = 'conflict',
  /** git could not tell: a fetch failed, or the branch's commit is not on origin. */
  Unknown = 'unknown',
}

/** Whether the branch merges into its base as they stand on origin now, and the files that conflict when not. */
export const prConflictsSchema = z.object({
  state: z.enum(PrMergeState),
  files: z.array(z.string()),
  checked_at: z.string().nullable(),
});

export type PrConflicts = z.infer<typeof prConflictsSchema>;

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

/** The latest Agent Review as the list shows it: what it decided and whether the head moved on. */
export const prAgentReviewBriefSchema = prAgentReviewSchema.pick({ decision: true, stale: true });

/** A pull request in a list: no description and only the brief of its latest Agent Review. */
export const pullRequestSummarySchema = pullRequestSchema
  .omit({ body: true, latest_agent_review: true })
  .extend({ latest_agent_review: prAgentReviewBriefSchema.nullable() });

export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;

export enum ReplyVerdict {
  Fixed = 'fixed',
  PartlyFixed = 'partly_fixed',
  NotFixed = 'not_fixed',
}

export enum ThreadOutcome {
  Pending = 'pending',
  /** Address comments. */
  Done = 'done',
  /** Address comments: no change needed, the code already settles it. */
  AlreadyAddressed = 'already_addressed',
  Declined = 'declined',
  /** Check replies: the reply's claim holds, holds in part, or does not. */
  Fixed = 'fixed',
  PartlyFixed = 'partly_fixed',
  NotFixed = 'not_fixed',
}

export const pullRequestDetailSchema = pullRequestSchema.extend({
  repo_id: z.string(),
  files: z.array(prFileSchema),
  comments: z.array(prCommentSchema),
  /** The PR Session on this pull request first, with older Sessions from button presses after it. */
  action_sessions: z.array(prActionSessionSchema),
  /** Oldest first. */
  commits: z.array(prCommitSchema),
  /** Null for a pull request that is not open. */
  conflicts: prConflictsSchema.nullable(),
});

export type PullRequestDetail = z.infer<typeof pullRequestDetailSchema>;

export const pullRequestListSchema = z.object({
  data: z.array(pullRequestSummarySchema),
  meta: z.object({ synced_at: z.string().nullable(), stale: z.boolean(), next_cursor: z.null() }),
});

/** `pr_review` Sessions are made by the backend, never by a request. */
export const createRepoSessionSchema = z.strictObject({
  kind: z.literal(SessionKind.Repo).optional(),
  repo_id: z.string().min(1),
  branch: z.string().trim().min(1),
  /** A branch only origin has, as a pull request's, is fetched and made a local branch tracking it. */
  from_origin: z.boolean().optional(),
  /** A branch no one has: it is made at the newest commit of the Repo's default branch. */
  new_branch: z.boolean().optional(),
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

/** What the Session's header needs to offer opening a pull request. */
export const sessionPullRequestSchema = z.object({
  /** True when the branch has commits its base lacks and no pull request is open for it. */
  can_open: z.boolean(),
  /** The pull request already open for the Session's branch. */
  pull_request: z.object({ number: z.number().int(), url: z.string() }).nullable(),
  /** The branch the pull request merges into by default: the Repo's default branch. */
  base_branch: z.string().nullable(),
  /** Files with changes not committed yet. The pull request leaves them out. */
  uncommitted_files: z.number().int(),
});

export type SessionPullRequest = z.infer<typeof sessionPullRequestSchema>;

export const pullRequestDraftRequestSchema = z.strictObject({ base_branch: z.string().trim().min(1).optional() });

/** The agent's title and description for a pull request; null where the agent gave none. */
export const pullRequestDraftSchema = z.object({ title: z.string().nullable(), description: z.string().nullable() });

export type PullRequestDraft = z.infer<typeof pullRequestDraftSchema>;

export const openPullRequestSchema = z.strictObject({
  title: z.string().trim().min(1),
  description: z.string(),
  base_branch: z.string().trim().min(1),
});

export type OpenPullRequest = z.infer<typeof openPullRequestSchema>;

export const openedPullRequestSchema = z.object({ number: z.number().int(), url: z.string() });

/** `POST /sessions/:id/commit`: commits every change in the Session's worktree. A blank message is written from the files. */
export const commitSessionSchema = z.strictObject({
  message: z.string().trim().max(2000).optional(),
  /** Commit on a new branch made from the current one; the Session follows it. */
  new_branch: z.boolean().default(false),
});

export type CommitSession = z.infer<typeof commitSessionSchema>;

export const committedSessionSchema = z.object({
  sha: z.string(),
  branch: z.string(),
  message: z.string(),
  files: z.number().int(),
});

export type CommittedSession = z.infer<typeof committedSessionSchema>;

/** `POST /sessions/:id/push`: what the branch is on origin after the push. */
export const pushedSessionSchema = z.object({ branch: z.string() });

/** `POST /sessions/:id/open-folder`: where the daemon opens the Session's worktree on this machine. */
export enum FolderTarget {
  Editor = 'editor',
  Folder = 'folder',
}

export const openFolderSchema = z.strictObject({ target: z.enum(FolderTarget) });

export const checkoutSchema = z.object({ branch: z.string().trim().min(1), create: z.boolean().default(false) });

export const checkoutResultSchema = z.object({ session: sessionSchema, stashed: z.boolean() });

export enum SessionDiffStatus {
  Added = 'added',
  Modified = 'modified',
  Deleted = 'deleted',
  Renamed = 'renamed',
}

export const sessionDiffFileSchema = z.object({
  name: z.string(),
  /** The path before a rename; null otherwise. */
  old_name: z.string().nullable(),
  status: z.enum(SessionDiffStatus),
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
  /** Hunk headers and lines; cut at a few thousand, with `truncated` set. */
  lines: z.array(z.object({ sign: z.enum(['+', '-', ' ']), text: z.string() })),
  truncated: z.boolean(),
});

export type SessionDiffFile = z.infer<typeof sessionDiffFileSchema>;

/**
 * What a repo Session's branch changes: committed, staged, unstaged and untracked, against where it forked from the
 * Repo's default branch.
 */
export const sessionDiffSchema = z.object({
  /** The branch checked out in the Session's own worktree; the Session's branch while that is detached. */
  branch: z.string().nullable(),
  /** What the changes are compared with, such as `origin/main`; null when the Repo has no commit to compare with. */
  base: z.string().nullable(),
  files: z.array(sessionDiffFileSchema),
  additions: z.number().int(),
  deletions: z.number().int(),
});

export type SessionDiff = z.infer<typeof sessionDiffSchema>;

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

export const reviewPullRequestSchema = z.object({
  event: z.enum(PrReviewEvent),
  body: z.string().trim().optional(),
});

export const prRefreshStatus = z.enum(['ok', 'rate_limited', 'failed']);

/** Hosts that serve pull requests; `local` has none. */
export const PR_HOSTS: GitHost[] = [GitHost.Github, GitHost.Gitlab, GitHost.Bitbucket];

/** The `@` menu above a Session's composer: files whose path matches the text after the `@`. */
export const fileMenuQuerySchema = z.object({
  session_id: z.string().min(1),
  q: z.string().optional(),
});

/** A row of the `@` menu. */
export const fileMenuItemSchema = z.object({
  /** What `@` inserts: relative to the Session's folder in a Repo Session, absolute in an Anonymous one. */
  path: z.string(),
  name: z.string(),
  /** The folder the file is in, relative to its Repo; empty at the top. */
  dir: z.string(),
  /** The imported Repo the file is in; set only for an Anonymous Session, which searches every Repo. */
  repo: z.string().nullable(),
});

export type FileMenuItem = z.infer<typeof fileMenuItemSchema>;

export const fileMenuSchema = z.object({ items: z.array(fileMenuItemSchema) });

export type FileMenu = z.infer<typeof fileMenuSchema>;
