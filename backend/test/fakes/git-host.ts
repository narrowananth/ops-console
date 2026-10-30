import {
  ErrorCode,
  GitHost,
  PrChecks,
  type PrFile,
  type PrReviewEvent,
  PrReviewState,
  PrState,
} from '@ops-console/shared';
import { ApiError } from '../../src/common/errors';
import type {
  GitHostAdapter,
  GitHosts,
  HostComment,
  HostPullRequest,
  NewHostComment,
} from '../../src/workspace/git-host';

export function hostPr(number: number, overrides: Partial<HostPullRequest> = {}): HostPullRequest {
  return {
    number,
    url: `https://github.com/acme/orders-api/pull/${number}`,
    title: `Change ${number}`,
    author: 'colleague',
    branch: `feature-${number}`,
    base_branch: 'main',
    head_sha: `sha-${number}-a`,
    state: PrState.Open,
    review_state: PrReviewState.None,
    checks: PrChecks.Passed,
    additions: 10,
    deletions: 2,
    body: 'Adds the thing.',
    opened_at: `2026-10-0${number}T10:00:00.000Z`,
    merged_at: null,
    comment_count: 0,
    resolved_count: 0,
    ...overrides,
  };
}

/** One Git host in memory. Counts what reaches it and fails on cue. */
export class FakeGitHost implements GitHostAdapter, GitHosts {
  prs: HostPullRequest[] = [];
  files: PrFile[] = [{ name: 'src/app.ts', additions: 3, deletions: 1, lines: [{ sign: '+', text: 'const a = 1;' }] }];
  comments = new Map<number, HostComment[]>();
  readonly calls = { list: 0, get: 0 };
  readonly posted: (NewHostComment & { id: string; number: number })[] = [];
  readonly reviews: { number: number; event: PrReviewEvent; body: string }[] = [];
  readonly merged: number[] = [];
  /** Every read fails like this while set. */
  down: 'rate_limited' | 'failed' | null = null;
  failPosts: ((comment: NewHostComment) => boolean) | null = null;
  rejectMerge = false;
  /** Runs just before a comment reaches the host. */
  beforePost: (comment: NewHostComment) => void = () => {};
  private nextId = 100;

  for(host: GitHost): GitHostAdapter {
    if (host === GitHost.Local) throw new ApiError(409, ErrorCode.InvalidState, 'a local Repo has no pull requests');
    return this;
  }

  private check(): void {
    if (this.down === 'rate_limited') throw new ApiError(429, ErrorCode.RateLimited, 'rate limited');
    if (this.down === 'failed') throw new ApiError(502, ErrorCode.UpstreamFailed, 'down');
  }

  private pr(number: number): HostPullRequest {
    const found = this.prs.find((pr) => pr.number === number);
    if (!found) throw new ApiError(404, ErrorCode.NotFound, 'no such pull request');
    return found;
  }

  private counted(pr: HostPullRequest): HostPullRequest {
    const comments = this.comments.get(pr.number) ?? [];
    return {
      ...pr,
      comment_count: comments.length,
      resolved_count: comments.filter((comment) => comment.parent_id === null && comment.resolved).length,
    };
  }

  async list(_slug: string, state: PrState): Promise<HostPullRequest[]> {
    this.calls.list++;
    this.check();
    return this.prs.filter((pr) => pr.state === state).map((pr) => this.counted(pr));
  }

  async get(_slug: string, number: number) {
    this.calls.get++;
    this.check();
    return { pr: this.counted(this.pr(number)), files: this.files, comments: [...(this.comments.get(number) ?? [])] };
  }

  async postComment(_slug: string, number: number, comment: NewHostComment): Promise<HostComment> {
    this.check();
    this.beforePost(comment);
    if (this.failPosts?.(comment)) throw new ApiError(502, ErrorCode.UpstreamFailed, 'the host refused the comment');
    const posted: HostComment = {
      id: String(++this.nextId),
      parent_id: comment.parent_id ?? null,
      author: 'octo-operator',
      body: comment.body,
      file_path: comment.file_path ?? null,
      line: comment.line ?? null,
      resolved: false,
      created_at: new Date().toISOString(),
    };
    this.comments.set(number, [...(this.comments.get(number) ?? []), posted]);
    this.posted.push({ ...comment, id: posted.id, number });
    return posted;
  }

  async setResolved(_slug: string, number: number, commentId: string, resolved: boolean): Promise<void> {
    this.check();
    for (const comment of this.comments.get(number) ?? []) if (comment.id === commentId) comment.resolved = resolved;
  }

  async review(_slug: string, number: number, event: PrReviewEvent, body: string): Promise<void> {
    this.check();
    this.reviews.push({ number, event, body });
    const pr = this.pr(number);
    if (event === 'approve') pr.review_state = PrReviewState.Approved;
    if (event === 'request_changes') pr.review_state = PrReviewState.ChangesRequested;
  }

  async merge(_slug: string, number: number): Promise<void> {
    this.check();
    if (this.rejectMerge) throw new ApiError(502, ErrorCode.UpstreamFailed, 'merge refused');
    this.pr(number).state = PrState.Merged;
    this.merged.push(number);
  }
}
