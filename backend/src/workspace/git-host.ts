import type { GitHost, PrChecks, PrFile, PrReviewEvent, PrReviewState, PrState } from '@ops-console/shared';

export const GIT_HOSTS = Symbol('GIT_HOSTS');

/** A pull request as the Git host reports it. The console adds `is_mine`, `by_agent` and the Agent Review. */
export type HostPullRequest = {
  number: number;
  url: string;
  title: string;
  author: string;
  branch: string;
  base_branch: string;
  head_sha: string;
  state: PrState;
  review_state: PrReviewState;
  /** Who approved it, as the host names them; empty when nobody has. */
  approved_by: string[];
  checks: PrChecks;
  additions: number;
  deletions: number;
  body: string;
  opened_at: string;
  merged_at: string | null;
  /** Every comment, replies included. */
  comment_count: number;
  /** Resolved threads. */
  resolved_count: number;
};

/** A pull request read across an owner's repositories. */
export type OwnedPullRequest = HostPullRequest & { slug: string };

export type HostComment = {
  id: string;
  parent_id: string | null;
  author: string;
  body: string;
  file_path: string | null;
  line: number | null;
  resolved: boolean;
  created_at: string;
};

export type NewHostComment = {
  body: string;
  /** The commit an inline comment attaches to. */
  head_sha: string;
  file_path?: string;
  line?: number;
  parent_id?: string;
};

/**
 * One Git host's pull requests, reached through its CLI (ADR 0005). `slug` is `owner/name`. Every method throws an
 * `ApiError`: `rate_limited` when the host says to slow down, `upstream_failed` for anything else.
 */
export interface GitHostAdapter {
  list(slug: string, state: PrState): Promise<HostPullRequest[]>;
  /** The accounts, organizations, groups or workspaces whose repositories the signed-in user can read. */
  owners(): Promise<string[]>;
  /** Pull requests in every repository of one owner, each with its repository's slug. */
  listOwner(owner: string, state: PrState): Promise<OwnedPullRequest[]>;
  /** Drops what an adapter remembers of an owner's last read, so the next `listOwner` reads everything. */
  forgetOwner?(owner: string): void;
  /** One pull request in any state, read alone; null when the repository has none with that number. */
  find(slug: string, number: number): Promise<HostPullRequest | null>;
  get(slug: string, number: number): Promise<{ pr: HostPullRequest; files: PrFile[]; comments: HostComment[] }>;
  postComment(slug: string, number: number, comment: NewHostComment): Promise<HostComment>;
  setResolved(slug: string, number: number, commentId: string, resolved: boolean): Promise<void>;
  /** Removes a comment from the host; the host refuses one the signed-in user did not write. */
  deleteComment(slug: string, number: number, commentId: string): Promise<void>;
  review(slug: string, number: number, event: PrReviewEvent, body: string): Promise<void>;
  merge(slug: string, number: number): Promise<void>;
  /** The text of `path` at commit `ref`, or null when the file is not there. */
  fileAt(slug: string, ref: string, path: string): Promise<string | null>;
  /** Opens a pull request from a branch the host already has. */
  open(slug: string, pull: NewPullRequest): Promise<{ number: number; url: string }>;
}

/** A pull request the console opens: `head` is a branch of the repository, `base` the branch it merges into. */
export type NewPullRequest = { title: string; body: string; head: string; base: string };

export interface GitHosts {
  /** False for a host whose adapter has not landed: lists across Repos leave it out. */
  supports(host: GitHost): boolean;
  for(host: GitHost): GitHostAdapter;
}
