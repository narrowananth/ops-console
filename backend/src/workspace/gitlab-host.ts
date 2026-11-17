import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode, PrChecks, PrReviewState, PrState } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { hostCliPool } from '../common/spawn-pool';
import type { GitHostAdapter, HostPullRequest, NewPullRequest, OwnedPullRequest } from './git-host';

const run = promisify(execFile);

const STATES: Record<PrState, string> = {
  [PrState.Open]: 'opened',
  [PrState.Merged]: 'merged',
  [PrState.Closed]: 'closed',
};

/** Merge requests a page asks for, the most GitLab gives. */
const PER_PAGE = 100;
/** Pages one read follows: a bound on a runaway list, far above any merge request count. */
const MAX_PAGES = 40;

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
    const found = await this.mergeRequests(
      `projects/${encodeURIComponent(slug)}/merge_requests?state=${STATES[state]}`,
      state,
    );
    return found.map((mr) => {
      const { slug: _slug, ...pr } = toPullRequest(mr);
      return pr;
    });
  }

  async owners(): Promise<string[]> {
    const [user, groups] = await Promise.all([
      this.username(),
      this.json('groups?min_access_level=10&top_level_only=true&per_page=100'),
    ]);
    return [
      user,
      ...z
        .array(z.object({ full_path: z.string() }))
        .parse(groups)
        .map((group) => group.full_path),
    ];
  }

  async listOwner(owner: string, state: PrState): Promise<OwnedPullRequest[]> {
    const user = await this.username();
    const where =
      owner === user
        ? `merge_requests?scope=all&author_username=${encodeURIComponent(owner)}`
        : `groups/${encodeURIComponent(owner)}/merge_requests?include_subgroups=true`;
    return (await this.mergeRequests(`${where}&state=${STATES[state]}`, state)).map(toPullRequest);
  }

  private userRead: Promise<string> | null = null;

  /** The signed-in username, read once. */
  private username(): Promise<string> {
    this.userRead ??= this.json('user')
      .then((user) => z.object({ username: z.string() }).parse(user).username)
      .catch((error) => {
        this.userRead = null;
        throw error;
      });
    return this.userRead;
  }

  /** Every merge request of a list, a page at a time until one comes back short. */
  private async mergeRequests(path: string, state: PrState): Promise<z.infer<typeof mrSchema>[]> {
    const rows: z.infer<typeof mrSchema>[] = [];
    // Merged and closed lists are recent history: one page of them is read.
    for (let at = 1; at <= (state === PrState.Open ? MAX_PAGES : 1); at++) {
      const read = z.array(mrSchema).parse(await this.json(`${path}&per_page=${PER_PAGE}&page=${at}`));
      rows.push(...read);
      if (read.length < PER_PAGE) break;
    }
    return rows;
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

  find = async () => null;
  get = async () => this.unsupported();
  headRef = (_number: number, branch: string) => `refs/heads/${branch}`;
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
      return JSON.parse(
        await hostCliPool.run(async () => {
          const pending = run(this.bin, args, { maxBuffer: 20 * 1024 * 1024, timeout: 60_000 });
          pending.child.stdin?.end();
          return (await pending).stdout;
        }),
      );
    } catch (error) {
      const { stderr } = error as { stderr?: unknown };
      if (typeof stderr === 'string' && /\b429\b|rate limit/i.test(stderr)) {
        throw new ApiError(429, ErrorCode.RateLimited, 'GitLab is rate limiting the console');
      }
      throw new ApiError(502, ErrorCode.UpstreamFailed, '`glab api` failed');
    }
  }
}
