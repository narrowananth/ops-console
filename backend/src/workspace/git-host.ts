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
  get(slug: string, number: number): Promise<{ pr: HostPullRequest; files: PrFile[]; comments: HostComment[] }>;
  postComment(slug: string, number: number, comment: NewHostComment): Promise<HostComment>;
  setResolved(slug: string, number: number, commentId: string, resolved: boolean): Promise<void>;
  review(slug: string, number: number, event: PrReviewEvent, body: string): Promise<void>;
  merge(slug: string, number: number): Promise<void>;
}

export interface GitHosts {
  for(host: GitHost): GitHostAdapter;
}
