import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode, PrChecks, PrReviewState, PrState } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import type { GitHostAdapter, HostPullRequest, NewPullRequest, OwnedPullRequest } from './git-host';

const run = promisify(execFile);

const STATES: Record<PrState, string> = {
  [PrState.Open]: 'opened',
  [PrState.Merged]: 'merged',
  [PrState.Closed]: 'closed',
};

const mrSchema = z.object({
  iid: z.number().int(),
  title: z.string(),
  web_url: z.string(),
  description: z.string().nullish(),
  state: z.string(),
  author: z.object({ username: z.string() }).nullish(),
  source_branch: z.string(),
  target_branch: z.string(),
  sha: z.string().nullish(),
  created_at: z.string(),
  merged_at: z.string().nullish(),
  user_notes_count: z.number().int().nullish(),
  references: z.object({ full: z.string() }),
});

function toPullRequest(mr: z.infer<typeof mrSchema>): OwnedPullRequest {
  return {
    number: mr.iid,
    url: mr.web_url,
    title: mr.title,
    author: mr.author?.username ?? 'unknown',
    branch: mr.source_branch,
    base_branch: mr.target_branch,
    head_sha: mr.sha ?? '',
    state: mr.state === 'merged' ? PrState.Merged : mr.state === 'opened' ? PrState.Open : PrState.Closed,
    review_state: PrReviewState.None,
    approved_by: [],
    checks: PrChecks.None,
    additions: 0,
    deletions: 0,
    body: mr.description ?? '',
    opened_at: mr.created_at,
    merged_at: mr.merged_at ?? null,
    comment_count: mr.user_notes_count ?? 0,
    resolved_count: 0,
    // `group/sub/project!12`.
    slug: mr.references.full.replace(/!\d+$/, ''),
  };
}

/**
 * GitLab merge requests through `glab api`: listed, and opened by the console. Everything else shows on GitLab. Errors
 * name the call only.
 */
export class GitlabHost implements GitHostAdapter {
  constructor(private readonly bin = 'glab') {}

  async list(slug: string, state: PrState): Promise<HostPullRequest[]> {
    const out = await this.json(
      `projects/${encodeURIComponent(slug)}/merge_requests?state=${STATES[state]}&per_page=100`,
    );
    return z
      .array(mrSchema)
      .parse(out)
      .map((mr) => {
        const { slug: _slug, ...pr } = toPullRequest(mr);
        return pr;
      });
  }

  async owners(): Promise<string[]> {
    const [user, groups] = await Promise.all([
      this.json('user'),
      this.json('groups?min_access_level=10&top_level_only=true&per_page=100'),
    ]);
    return [
      z.object({ username: z.string() }).parse(user).username,
      ...z
        .array(z.object({ full_path: z.string() }))
        .parse(groups)
        .map((group) => group.full_path),
    ];
  }

  async listOwner(owner: string, state: PrState): Promise<OwnedPullRequest[]> {
    const user = z.object({ username: z.string() }).parse(await this.json('user')).username;
    const where =
      owner === user
        ? `merge_requests?scope=all&author_username=${encodeURIComponent(owner)}`
        : `groups/${encodeURIComponent(owner)}/merge_requests?include_subgroups=true`;
    const out = await this.json(`${where}&state=${STATES[state]}&per_page=100`);
    return z.array(mrSchema).parse(out).map(toPullRequest);
  }

  private unsupported(): never {
    throw new ApiError(
      502,
      ErrorCode.UpstreamFailed,
      'GitLab merge requests open on GitLab; the console lists them only',
    );
  }

  async open(slug: string, pull: NewPullRequest): Promise<{ number: number; url: string }> {
    const made = z.object({ iid: z.number().int(), web_url: z.string() }).parse(
      await this.json(`projects/${encodeURIComponent(slug)}/merge_requests`, {
        title: pull.title,
        description: pull.body,
        source_branch: pull.head,
        target_branch: pull.base,
      }),
    );
    return { number: made.iid, url: made.web_url };
  }

  get = async () => this.unsupported();
  fileAt = async () => this.unsupported();
  deleteComment = async () => this.unsupported();
  postComment = async () => this.unsupported();
  setResolved = async () => this.unsupported();
  review = async () => this.unsupported();
  merge = async () => this.unsupported();

  /** A read, or with `fields` a POST that sends them as text. */
  private async json(path: string, fields?: Record<string, string>): Promise<unknown> {
    const args = ['api', path];
    if (fields) {
      args.push('-X', 'POST');
      for (const [key, value] of Object.entries(fields)) args.push('--raw-field', `${key}=${value}`);
    }
    try {
      const pending = run(this.bin, args, { maxBuffer: 20 * 1024 * 1024, timeout: 60_000 });
      pending.child.stdin?.end();
      return JSON.parse((await pending).stdout);
    } catch (error) {
      const { stderr } = error as { stderr?: unknown };
      if (typeof stderr === 'string' && /\b429\b|rate limit/i.test(stderr)) {
        throw new ApiError(429, ErrorCode.RateLimited, 'GitLab is rate limiting the console');
      }
      throw new ApiError(502, ErrorCode.UpstreamFailed, '`glab api` failed');
    }
  }
}
