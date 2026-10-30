import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode, PrChecks, type PrFile, type PrReviewEvent, PrReviewState, PrState } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import type { GitHostAdapter, HostComment, HostPullRequest, NewHostComment } from './git-host';

const run = promisify(execFile);

const PR_FIELDS = `
  number title url body state author { login } headRefName baseRefName headRefOid additions deletions createdAt
  mergedAt reviewDecision comments { totalCount }
  reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { totalCount nodes { databaseId } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

const nodeSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  author: z.object({ login: z.string() }).nullable(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
  reviewDecision: z.string().nullable(),
  comments: z.object({ totalCount: z.number().int() }),
  reviewThreads: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        isResolved: z.boolean(),
        comments: z.object({
          totalCount: z.number().int(),
          nodes: z.array(z.object({ databaseId: z.number().int().nullable() })),
        }),
      }),
    ),
  }),
  commits: z.object({
    nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })),
  }),
});

type Node = z.infer<typeof nodeSchema>;

const restFileSchema = z.object({
  filename: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  patch: z.string().optional(),
});

const restCommentSchema = z.object({
  id: z.number().int(),
  user: z.object({ login: z.string() }).nullable(),
  body: z.string(),
  created_at: z.string(),
  path: z.string().optional(),
  line: z.number().int().nullish(),
  original_line: z.number().int().nullish(),
  in_reply_to_id: z.number().int().nullish(),
});

const STATES: Record<PrState, string> = {
  [PrState.Open]: 'OPEN',
  [PrState.Merged]: 'MERGED',
  [PrState.Closed]: 'CLOSED',
};

/** Issue comments and review comments count ids separately; issue comments carry this prefix. */
const ISSUE = 'i';

const EVENTS: Record<PrReviewEvent, string> = {
  approve: 'APPROVE',
  request_changes: 'REQUEST_CHANGES',
  comment: 'COMMENT',
};

/** GitHub through `gh api`. Errors name the call only: output may hold tokens. */
export class GithubHost implements GitHostAdapter {
  constructor(private readonly bin = 'gh') {}

  async list(slug: string, state: PrState): Promise<HostPullRequest[]> {
    const [owner, name] = splitSlug(slug);
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
      pullRequests(first: 50, states: [${STATES[state]}], orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes { ${PR_FIELDS} } } } }`;
    const out = await this.graphql(query, { owner, name });
    const parsed = z
      .object({ repository: z.object({ pullRequests: z.object({ nodes: z.array(nodeSchema) }) }) })
      .parse(out);
    return parsed.repository.pullRequests.nodes.map(toPullRequest);
  }

  async get(slug: string, number: number) {
    const [owner, name] = splitSlug(slug);
    const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { ${PR_FIELDS} } } }`;
    const [graph, files, review, issue] = await Promise.all([
      this.graphql(query, { owner, name }, { number }),
      this.rest(`repos/${slug}/pulls/${number}/files?per_page=100`),
      this.rest(`repos/${slug}/pulls/${number}/comments?per_page=100`),
      this.rest(`repos/${slug}/issues/${number}/comments?per_page=100`),
    ]);
    const node = z.object({ repository: z.object({ pullRequest: nodeSchema }) }).parse(graph).repository.pullRequest;
    const resolved = new Map(
      node.reviewThreads.nodes.map((thread) => [String(thread.comments.nodes[0]?.databaseId), thread.isResolved]),
    );
    const reviewComments = z
      .array(restCommentSchema)
      .parse(review)
      .map((comment): HostComment => {
        const id = String(comment.id);
        return {
          id,
          parent_id: comment.in_reply_to_id == null ? null : String(comment.in_reply_to_id),
          author: comment.user?.login ?? 'ghost',
          body: comment.body,
          file_path: comment.path ?? null,
          line: comment.line ?? comment.original_line ?? null,
          resolved: resolved.get(id) ?? false,
          created_at: comment.created_at,
        };
      });
    const issueComments = z
      .array(restCommentSchema)
      .parse(issue)
      .map(
        (comment): HostComment => ({
          id: `${ISSUE}${comment.id}`,
          parent_id: null,
          author: comment.user?.login ?? 'ghost',
          body: comment.body,
          file_path: null,
          line: null,
          resolved: false,
          created_at: comment.created_at,
        }),
      );
    const comments = [...reviewComments, ...issueComments].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return {
      pr: toPullRequest(node),
      files: z.array(restFileSchema).parse(files).map(toFile),
      comments,
    };
  }

  async postComment(slug: string, number: number, comment: NewHostComment): Promise<HostComment> {
    const { parent_id: parent, file_path: file, line } = comment;
    let out: unknown;
    if (parent && !parent.startsWith(ISSUE)) {
      out = await this.rest(`repos/${slug}/pulls/${number}/comments/${parent}/replies`, 'POST', { body: comment.body });
    } else if (!parent && file && line) {
      out = await this.rest(`repos/${slug}/pulls/${number}/comments`, 'POST', {
        body: comment.body,
        commit_id: comment.head_sha,
        path: file,
        line,
        side: 'RIGHT',
      });
    } else {
      const issue = await this.rest(`repos/${slug}/issues/${number}/comments`, 'POST', { body: comment.body });
      const parsed = restCommentSchema.parse(issue);
      return {
        id: `${ISSUE}${parsed.id}`,
        parent_id: null,
        author: parsed.user?.login ?? 'ghost',
        body: parsed.body,
        file_path: null,
        line: null,
        resolved: false,
        created_at: parsed.created_at,
      };
    }
    const parsed = restCommentSchema.parse(out);
    return {
      id: String(parsed.id),
      parent_id: parsed.in_reply_to_id == null ? null : String(parsed.in_reply_to_id),
      author: parsed.user?.login ?? 'ghost',
      body: parsed.body,
      file_path: parsed.path ?? null,
      line: parsed.line ?? parsed.original_line ?? null,
      resolved: false,
      created_at: parsed.created_at,
    };
  }

  async setResolved(slug: string, number: number, commentId: string, resolved: boolean): Promise<void> {
    const [owner, name] = splitSlug(slug);
    const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id comments(first: 1) { nodes { databaseId } } } } } } }`;
    const out = await this.graphql(query, { owner, name }, { number });
    const threads = z
      .object({
        repository: z.object({
          pullRequest: z.object({
            reviewThreads: z.object({
              nodes: z.array(
                z.object({
                  id: z.string(),
                  comments: z.object({ nodes: z.array(z.object({ databaseId: z.number().int().nullable() })) }),
                }),
              ),
            }),
          }),
        }),
      })
      .parse(out).repository.pullRequest.reviewThreads.nodes;
    const thread = threads.find((candidate) => String(candidate.comments.nodes[0]?.databaseId) === commentId);
    if (!thread) throw new ApiError(404, ErrorCode.NotFound, 'no such thread');
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    await this.graphql(`mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { id } } }`, {
      id: thread.id,
    });
  }

  async review(slug: string, number: number, event: PrReviewEvent, body: string): Promise<void> {
    await this.rest(`repos/${slug}/pulls/${number}/reviews`, 'POST', { event: EVENTS[event], body });
  }

  async merge(slug: string, number: number): Promise<void> {
    await this.rest(`repos/${slug}/pulls/${number}/merge`, 'PUT', {});
  }

  private async graphql(
    query: string,
    strings: Record<string, string>,
    ints: Record<string, number> = {},
  ): Promise<unknown> {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(strings)) args.push('-f', `${key}=${value}`);
    for (const [key, value] of Object.entries(ints)) args.push('-F', `${key}=${value}`);
    const out = z.object({ data: z.unknown() }).parse(JSON.parse(await this.exec(args, 'gh api graphql')));
    return out.data;
  }

  private async rest(path: string, method = 'GET', body?: object): Promise<unknown> {
    const args = ['api', '-X', method, path];
    if (body) args.push('--input', '-');
    const out = await this.exec(args, `gh api ${method}`, body ? JSON.stringify(body) : undefined);
    return out.trim() ? JSON.parse(out) : null;
  }

  private async exec(args: string[], what: string, input?: string): Promise<string> {
    try {
      const pending = run(this.bin, args, { maxBuffer: 20 * 1024 * 1024, timeout: 60_000 });
      pending.child.stdin?.end(input);
      return (await pending).stdout;
    } catch (error) {
      const { stderr } = error as { stderr?: unknown };
      if (typeof stderr === 'string' && /rate limit/i.test(stderr)) {
        throw new ApiError(429, ErrorCode.RateLimited, 'GitHub is rate limiting the console');
      }
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`${what}\` failed`);
    }
  }
}

function splitSlug(slug: string): [string, string] {
  const [owner = '', name = ''] = slug.split('/');
  return [owner, name];
}

function toPullRequest(node: Node): HostPullRequest {
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup?.state;
  return {
    number: node.number,
    url: node.url,
    title: node.title,
    author: node.author?.login ?? 'ghost',
    branch: node.headRefName,
    base_branch: node.baseRefName,
    head_sha: node.headRefOid,
    state: node.state === 'MERGED' ? PrState.Merged : node.state === 'CLOSED' ? PrState.Closed : PrState.Open,
    review_state:
      node.reviewDecision === 'APPROVED'
        ? PrReviewState.Approved
        : node.reviewDecision === 'CHANGES_REQUESTED'
          ? PrReviewState.ChangesRequested
          : PrReviewState.None,
    checks:
      rollup === undefined
        ? PrChecks.None
        : rollup === 'SUCCESS'
          ? PrChecks.Passed
          : rollup === 'FAILURE' || rollup === 'ERROR'
            ? PrChecks.Failed
            : PrChecks.Running,
    additions: node.additions,
    deletions: node.deletions,
    body: node.body ?? '',
    opened_at: node.createdAt,
    merged_at: node.mergedAt,
    comment_count:
      node.comments.totalCount + node.reviewThreads.nodes.reduce((sum, thread) => sum + thread.comments.totalCount, 0),
    resolved_count: node.reviewThreads.nodes.filter((thread) => thread.isResolved).length,
  };
}

function toFile(file: z.infer<typeof restFileSchema>): PrFile {
  const lines = (file.patch ?? '')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('\\'))
    .map((line) => {
      const sign = line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : ' ';
      return { sign: sign as '+' | '-' | ' ', text: line.startsWith('@@') ? line : line.slice(1) };
    });
  return { name: file.filename, additions: file.additions, deletions: file.deletions, lines };
}
