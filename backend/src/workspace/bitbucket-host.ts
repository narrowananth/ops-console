import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode, PrChecks, type PrFile, PrReviewEvent, PrReviewState, PrState } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import type {
  GitHostAdapter,
  HostComment,
  HostPullRequest,
  NewHostComment,
  NewPullRequest,
  OwnedPullRequest,
} from './git-host';
import { encodePath } from './github-host';

const run = promisify(execFile);

const STATES: Record<PrState, string> = {
  [PrState.Open]: 'OPEN',
  [PrState.Merged]: 'MERGED',
  [PrState.Closed]: 'DECLINED',
};

/** A workspace's repositories read for pull requests, most recently pushed first; older ones are left out. */
export const REPOS_PER_WORKSPACE = 300;
/** Repositories read at once. */
const PARALLEL = 6;
/**
 * A repository with no open pull request, and nothing pushed since the last read, is not read again for this long.
 * Reading all of a workspace's repositories each minute is what used up Bitbucket's quota.
 */
const QUIET_REPO_MS = 30 * 60_000;

/** What the last read of a repository found: when it was pushed to, when it was read, and whether it had any. */
type Seen = { updated: string | null; at: number; open: number };

const page = <T extends z.ZodType>(item: T) => z.object({ values: z.array(item), next: z.string().nullish() });

const prSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string(),
  author: z.object({ display_name: z.string().nullish(), nickname: z.string().nullish() }).nullish(),
  source: z.object({
    branch: z.object({ name: z.string() }),
    commit: z.object({ hash: z.string() }).nullish(),
  }),
  destination: z.object({ branch: z.object({ name: z.string() }) }),
  created_on: z.string(),
  updated_on: z.string().nullish(),
  comment_count: z.number().int().nullish(),
  participants: z
    .array(
      z.object({
        approved: z.boolean().nullish(),
        state: z.string().nullish(),
        user: z.object({ display_name: z.string().nullish(), nickname: z.string().nullish() }).nullish(),
      }),
    )
    .nullish(),
  links: z.object({ html: z.object({ href: z.string() }) }),
});

const commentSchema = z.object({
  id: z.number().int(),
  parent: z.object({ id: z.number().int() }).nullish(),
  user: z.object({ display_name: z.string().nullish(), nickname: z.string().nullish() }).nullish(),
  content: z.object({ raw: z.string() }),
  inline: z.object({ path: z.string(), to: z.number().int().nullish(), from: z.number().int().nullish() }).nullish(),
  resolution: z.unknown().nullish(),
  deleted: z.boolean().nullish(),
  created_on: z.string(),
});

const diffstatSchema = z.object({
  lines_added: z.number().int(),
  lines_removed: z.number().int(),
  new: z.object({ path: z.string() }).nullish(),
  old: z.object({ path: z.string() }).nullish(),
});

const statusSchema = z.object({ state: z.string() });

type BitbucketPr = z.infer<typeof prSchema>;

const who = (user: { display_name?: string | null; nickname?: string | null } | null | undefined) =>
  user?.nickname ?? user?.display_name ?? 'unknown';

function toPullRequest(pr: BitbucketPr): HostPullRequest {
  const states = (pr.participants ?? []).map((participant) => participant.state);
  return {
    number: pr.id,
    url: pr.links.html.href,
    title: pr.title,
    author: who(pr.author),
    branch: pr.source.branch.name,
    base_branch: pr.destination.branch.name,
    head_sha: pr.source.commit?.hash ?? '',
    state: pr.state === 'MERGED' ? PrState.Merged : pr.state === 'OPEN' ? PrState.Open : PrState.Closed,
    review_state: states.includes('changes_requested')
      ? PrReviewState.ChangesRequested
      : (pr.participants ?? []).some((participant) => participant.approved)
        ? PrReviewState.Approved
        : PrReviewState.None,
    approved_by: (pr.participants ?? [])
      .filter((participant) => participant.approved)
      .map((participant) => participant.user?.display_name ?? who(participant.user)),
    checks: PrChecks.None,
    additions: 0,
    deletions: 0,
    body: pr.description ?? '',
    opened_at: pr.created_on,
    merged_at: pr.state === 'MERGED' ? (pr.updated_on ?? null) : null,
    comment_count: pr.comment_count ?? 0,
    resolved_count: 0,
  };
}

function toComment(comment: z.infer<typeof commentSchema>): HostComment {
  return {
    id: String(comment.id),
    parent_id: comment.parent ? String(comment.parent.id) : null,
    author: who(comment.user),
    body: comment.content.raw,
    file_path: comment.inline?.path ?? null,
    line: comment.inline?.to ?? comment.inline?.from ?? null,
    resolved: comment.resolution != null,
    created_at: comment.created_on,
  };
}

/** A unified diff split per file, hunk lines only. */
export function diffFiles(diff: string, stats: z.infer<typeof diffstatSchema>[]): PrFile[] {
  const patches = new Map<string, PrFile['lines']>();
  let current: PrFile['lines'] | null = null;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = [];
      patches.set(header[2] ?? '', current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('@@')) {
      current.push({ sign: ' ', text: line });
      continue;
    }
    // Before the first hunk come `index`, `---` and `+++` headers; they carry no change.
    if (current.length === 0 || line === '' || line.startsWith('\\')) continue;
    const sign = line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : ' ';
    current.push({ sign, text: line.slice(1) });
  }
  return stats.map((stat) => {
    const name = stat.new?.path ?? stat.old?.path ?? '';
    return { name, additions: stat.lines_added, deletions: stat.lines_removed, lines: patches.get(name) ?? [] };
  });
}

/**
 * Bitbucket Cloud through `bkt api`, signed in as the operator (ADR 0005). `slug` is `workspace/repo`. Errors name
 * the call only: output may hold tokens.
 */
export class BitbucketHost implements GitHostAdapter {
  /** Per workspace and state: what the last read of each repository found. */
  private readonly seen = new Map<string, Map<string, Seen>>();

  constructor(private readonly bin = 'bkt') {}

  /** The next read of the workspace reads every repository. */
  forgetOwner(owner: string): void {
    for (const key of [...this.seen.keys()]) if (key.startsWith(`${owner.toLowerCase()}:`)) this.seen.delete(key);
  }

  async list(slug: string, state: PrState): Promise<HostPullRequest[]> {
    const out = await this.json(`/repositories/${slug}/pullrequests`, {
      state: STATES[state],
      pagelen: '50',
      fields: '+values.participants',
    });
    return page(prSchema).parse(out).values.map(toPullRequest);
  }

  async owners(): Promise<string[]> {
    const out = await this.json('/user/workspaces', { pagelen: '100' });
    return page(z.object({ workspace: z.object({ slug: z.string() }) }))
      .parse(out)
      .values.map((value) => value.workspace.slug);
  }

  async listOwner(owner: string, state: PrState): Promise<OwnedPullRequest[]> {
    const memory = this.seen.get(`${owner.toLowerCase()}:${state}`) ?? new Map<string, Seen>();
    const names: { name: string; updated: string | null }[] = [];
    for (let at = 1; names.length < REPOS_PER_WORKSPACE; at++) {
      const out = await this.json(`/repositories/${owner}`, {
        pagelen: '100',
        page: String(at),
        sort: '-updated_on',
        fields: 'next,values.slug,values.updated_on',
      });
      const read = page(z.object({ slug: z.string(), updated_on: z.string().nullish() })).parse(out);
      names.push(...read.values.map((value) => ({ name: value.slug, updated: value.updated_on ?? null })));
      if (!read.next) break;
    }
    const out: OwnedPullRequest[] = [];
    const next = new Map<string, Seen>();
    const queue = names.slice(0, REPOS_PER_WORKSPACE);
    // A repository with open pull requests is always read; a quiet one only when it was pushed to or is long unread.
    const skipped = (name: string, updated: string | null) => {
      const before = memory.get(name);
      return (
        before !== undefined &&
        before.open === 0 &&
        before.updated !== null &&
        before.updated === updated &&
        Date.now() - before.at < QUIET_REPO_MS
      );
    };
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        for (let one = queue.shift(); one !== undefined; one = queue.shift()) {
          const slug = `${owner}/${one.name}`;
          const before = memory.get(one.name);
          if (before && skipped(one.name, one.updated)) {
            next.set(one.name, before);
            continue;
          }
          try {
            const found = (await this.list(slug, state)).map((pr) => ({ ...pr, slug }));
            out.push(...found);
            next.set(one.name, { updated: one.updated, at: Date.now(), open: found.length });
          } catch (error) {
            // The read fails as a whole, so the other workers stop asking instead of finishing the queue.
            queue.length = 0;
            throw error;
          }
        }
      }),
    );
    // Kept only when the whole read worked: a failed one leaves the last good memory.
    this.seen.set(`${owner.toLowerCase()}:${state}`, next);
    return out;
  }

  async get(slug: string, number: number) {
    const base = `/repositories/${slug}/pullrequests/${number}`;
    // Five reads side by side: each `bkt` call is a process and a round trip, so in a row they add up.
    const [pr, stats, diff, comments, checks] = await Promise.all([
      this.json(base),
      this.json(`${base}/diffstat`, { pagelen: '500' }),
      this.exec(['api', `${base}/diff`], 'bkt api diff'),
      this.json(`${base}/comments`, { pagelen: '100' }),
      this.json(`${base}/statuses`, { pagelen: '100' }),
    ]);
    const parsed = prSchema.parse(pr);
    const files = diffFiles(diff, page(diffstatSchema).parse(stats).values);
    const all = page(commentSchema)
      .parse(comments)
      .values.filter((comment) => !comment.deleted)
      .map(toComment);
    const statuses = page(statusSchema)
      .parse(checks)
      .values.map((status) => status.state);
    return {
      pr: {
        ...toPullRequest(parsed),
        checks:
          statuses.length === 0
            ? PrChecks.None
            : statuses.some((state) => state === 'FAILED' || state === 'STOPPED')
              ? PrChecks.Failed
              : statuses.every((state) => state === 'SUCCESSFUL')
                ? PrChecks.Passed
                : PrChecks.Running,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        comment_count: all.length,
        resolved_count: all.filter((comment) => comment.resolved && comment.parent_id === null).length,
      },
      files,
      comments: all.sort((a, b) => a.created_at.localeCompare(b.created_at)),
    };
  }

  async postComment(slug: string, number: number, comment: NewHostComment): Promise<HostComment> {
    const body: Record<string, unknown> = { content: { raw: comment.body } };
    if (comment.parent_id) body.parent = { id: Number(comment.parent_id) };
    else if (comment.file_path && comment.line) body.inline = { path: comment.file_path, to: comment.line };
    const out = await this.json(`/repositories/${slug}/pullrequests/${number}/comments`, {}, 'POST', body);
    return toComment(commentSchema.parse(out));
  }

  async setResolved(slug: string, number: number, commentId: string, resolved: boolean): Promise<void> {
    const path = `/repositories/${slug}/pullrequests/${number}/comments/${commentId}/resolve`;
    await this.exec(['api', path, '-X', resolved ? 'POST' : 'DELETE'], 'bkt api resolve');
  }

  async deleteComment(slug: string, number: number, commentId: string): Promise<void> {
    const path = `/repositories/${slug}/pullrequests/${number}/comments/${commentId}`;
    await this.exec(['api', path, '-X', 'DELETE'], 'bkt api delete comment');
  }

  async review(slug: string, number: number, event: PrReviewEvent, body: string): Promise<void> {
    const base = `/repositories/${slug}/pullrequests/${number}`;
    if (event === PrReviewEvent.Approve) await this.exec(['api', `${base}/approve`, '-X', 'POST'], 'bkt api approve');
    if (event === PrReviewEvent.RequestChanges) {
      await this.exec(['api', `${base}/request-changes`, '-X', 'POST'], 'bkt api request-changes');
    }
    // Bitbucket's approval carries no text; the words go in as a comment.
    if (body.trim() !== '') await this.postComment(slug, number, { body, head_sha: '' });
  }

  async merge(slug: string, number: number): Promise<void> {
    await this.json(`/repositories/${slug}/pullrequests/${number}/merge`, {}, 'POST', {});
  }

  async open(slug: string, pull: NewPullRequest): Promise<{ number: number; url: string }> {
    const made = z.object({ id: z.number().int(), links: z.object({ html: z.object({ href: z.string() }) }) }).parse(
      await this.json(`/repositories/${slug}/pullrequests`, {}, 'POST', {
        title: pull.title,
        description: pull.body,
        source: { branch: { name: pull.head } },
        destination: { branch: { name: pull.base } },
      }),
    );
    return { number: made.id, url: made.links.html.href };
  }

  async fileAt(slug: string, ref: string, path: string): Promise<string | null> {
    try {
      return await this.exec(['api', `/repositories/${slug}/src/${ref}/${encodePath(path)}`], 'bkt api src');
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async json(
    path: string,
    params: Record<string, string> = {},
    method = 'GET',
    body?: object,
  ): Promise<unknown> {
    const args = ['api', path];
    for (const [key, value] of Object.entries(params)) args.push('-P', `${key}=${value}`);
    if (method !== 'GET') args.push('-X', method);
    if (body) args.push('-d', JSON.stringify(body));
    const out = await this.exec(args, `bkt api ${method}`);
    return out.trim() ? JSON.parse(out) : null;
  }

  private async exec(args: string[], what: string): Promise<string> {
    try {
      const pending = run(this.bin, args, { maxBuffer: 20 * 1024 * 1024, timeout: 60_000 });
      pending.child.stdin?.end();
      return (await pending).stdout;
    } catch (error) {
      const { stderr } = error as { stderr?: unknown };
      if (typeof stderr === 'string' && /\b429\b|rate limit/i.test(stderr)) {
        throw new ApiError(429, ErrorCode.RateLimited, 'Bitbucket is rate limiting the console');
      }
      if (typeof stderr === 'string' && /\b404\b|not found/i.test(stderr)) {
        throw new ApiError(404, ErrorCode.NotFound, `\`${what}\` found nothing`);
      }
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`${what}\` failed`);
    }
  }
}
