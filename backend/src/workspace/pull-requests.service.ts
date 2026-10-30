import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ActionActor,
  ActionKind,
  ActionOutcome,
  ConnectorId,
  ErrorCode,
  type Finding,
  GitHost,
  HealthStatus,
  PR_HOSTS,
  type PrAgentReview,
  type PrComment,
  PrReviewEvent,
  PrReviewState,
  PrState,
  type PullRequest,
  type PullRequestDetail,
  SessionKind,
} from '@ops-console/shared';
import { and, desc, eq } from 'drizzle-orm';
import { ActionLogService } from '../action-log/action-log.service';
import { ApiError, validationFailed } from '../common/errors';
import { ConnectorsService } from '../connectors/connectors.service';
import { agentComments, connectors, prAgentReviews, repos, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import type { OpenPrBranches } from '../repos/open-pr-branches';
import { GIT_HOSTS, type GitHosts, type HostComment, type HostPullRequest } from './git-host';

type RepoRow = typeof repos.$inferSelect;
type ReviewRow = typeof prAgentReviews.$inferSelect;

/** A list read this recently is served from memory. */
export const LIST_TTL_MS = 60_000;

type Entry = { at: number; prs: HostPullRequest[] };

export function toAgentReview(row: ReviewRow, headSha: string | null): PrAgentReview {
  return {
    id: row.id,
    repo_id: row.repoId,
    pr_number: row.prNumber,
    head_sha: row.headSha,
    status: row.status,
    verdict: row.verdict,
    findings: JSON.parse(row.findings) as Finding[],
    checklist: JSON.parse(row.checklist),
    tools: JSON.parse(row.tools),
    created_at: row.createdAt,
    stale: headSha !== null && row.headSha !== headSha,
  };
}

/** A Git host's Connector shares its name. */
const CONNECTOR_OF: Partial<Record<GitHost, ConnectorId>> = {
  [GitHost.Github]: ConnectorId.Github,
  [GitHost.Gitlab]: ConnectorId.Gitlab,
  [GitHost.Bitbucket]: ConnectorId.Bitbucket,
};

const signature = (pr: HostPullRequest) =>
  [pr.head_sha, pr.state, pr.review_state, pr.checks, pr.comment_count, pr.resolved_count].join('|');

/** Pull requests live on the Git host. This keeps list reads in memory for 60 seconds and adds what only the console knows. */
@Injectable()
export class PullRequestsService implements OpenPrBranches {
  private readonly logger = new Logger('pull-requests');
  private readonly cache = new Map<string, Entry>();
  private readonly refreshListeners: (() => void)[] = [];

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT_HOSTS) private readonly hosts: GitHosts,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
  ) {}

  async list(query: {
    repo_id?: string;
    state: PrState;
    mine?: boolean;
    q?: string;
  }): Promise<{ data: PullRequest[]; meta: { synced_at: string | null; stale: boolean; next_cursor: null } }> {
    const wanted = query.repo_id === undefined ? this.hostedRepos() : [this.repoRow(query.repo_id)];
    let stale = false;
    let oldest: number | null = null;
    const data: PullRequest[] = [];
    for (const repo of wanted) {
      if (query.repo_id === undefined && !this.connected(repo.host)) continue;
      const read = await this.read(repo, query.state);
      stale ||= read.stale;
      oldest = oldest === null ? read.at : Math.min(oldest, read.at);
      data.push(...this.decorate(repo, read.prs));
    }
    const q = query.q?.trim().toLowerCase();
    const shown = data
      .filter((pr) => query.mine !== true || pr.is_mine)
      .filter(
        (pr) =>
          !q || [pr.title, pr.author, pr.branch, `#${pr.number}`].some((field) => field.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.opened_at.localeCompare(a.opened_at));
    return {
      data: shown,
      meta: { synced_at: oldest === null ? null : new Date(oldest).toISOString(), stale, next_cursor: null },
    };
  }

  /** Drops the memory and reads again in the background; `pull_request.refreshed` reports it. */
  refresh(repoId: string | undefined): void {
    const wanted = repoId === undefined ? this.hostedRepos() : [this.repoRow(repoId)];
    const before = new Map<string, Entry | undefined>();
    for (const repo of wanted) {
      before.set(repo.id, this.cache.get(this.key(repo.id, PrState.Open)));
      this.drop(repo.id);
    }
    void this.refreshAll(wanted, before, repoId ?? null);
  }

  /** Branches with an open pull request; empty when the host cannot be read. */
  async forRepo(repoId: string): Promise<Set<string>> {
    const repo = this.repoRow(repoId);
    if (!PR_HOSTS.includes(repo.host) || repo.remoteSlug === null || !this.connected(repo.host)) return new Set();
    try {
      return new Set((await this.read(repo, PrState.Open)).prs.map((pr) => pr.branch));
    } catch {
      return new Set();
    }
  }

  async get(repoId: string, number: number): Promise<PullRequestDetail> {
    const repo = this.hosted(repoId);
    const { pr, files, comments } = await this.adapter(repo).get(repo.remoteSlug as string, number);
    return {
      ...(this.decorate(repo, [pr])[0] as PullRequest),
      files,
      comments: this.markComments(repo.id, number, comments),
    };
  }

  async comment(
    repoId: string,
    number: number,
    input: { body: string; file_path?: string; line?: number; parent_id?: string },
  ): Promise<PrComment> {
    const repo = this.hosted(repoId);
    const adapter = this.adapter(repo);
    const slug = repo.remoteSlug as string;
    // An inline comment attaches to the commit the pull request is at now.
    const headSha = input.file_path ? (await adapter.get(slug, number)).pr.head_sha : '';
    const posted = await adapter.postComment(slug, number, { ...input, head_sha: headSha });
    this.drop(repo.id);
    return this.markComments(repo.id, number, [posted])[0] as PrComment;
  }

  async resolve(repoId: string, number: number, commentId: string, resolved: boolean): Promise<PrComment> {
    const repo = this.hosted(repoId);
    const adapter = this.adapter(repo);
    const slug = repo.remoteSlug as string;
    const found = (await adapter.get(slug, number)).comments.find((comment) => comment.id === commentId);
    if (!found) throw new ApiError(404, ErrorCode.NotFound, 'no such comment');
    if (found.parent_id !== null) throw new ApiError(409, ErrorCode.InvalidState, 'only a thread can be resolved');
    await adapter.setResolved(slug, number, commentId, resolved);
    this.drop(repo.id);
    const after = (await adapter.get(slug, number)).comments;
    return this.markComments(repo.id, number, after).find((comment) => comment.id === commentId) as PrComment;
  }

  /** Approve and request changes are refused on the operator's own pull request. */
  async review(
    repoId: string,
    number: number,
    event: PrReviewEvent,
    body: string | undefined,
  ): Promise<PullRequestDetail> {
    if (event !== PrReviewEvent.Approve && !body) throw validationFailed('invalid body: body');
    const repo = this.hosted(repoId);
    const adapter = this.adapter(repo);
    const slug = repo.remoteSlug as string;
    if (event !== PrReviewEvent.Comment) {
      const { pr } = await adapter.get(slug, number);
      const login = this.login(repo.host);
      if (login !== null && pr.author === login) {
        throw new ApiError(409, ErrorCode.InvalidState, 'You cannot review your own pull request');
      }
    }
    await adapter.review(slug, number, event, body ?? '');
    this.drop(repo.id);
    return this.get(repoId, number);
  }

  /** The operator's merge: the host's review state must read `approved`. The agent has no such path (ADR 0002). */
  async merge(repoId: string, number: number): Promise<PullRequestDetail> {
    const repo = this.hosted(repoId);
    const adapter = this.adapter(repo);
    const slug = repo.remoteSlug as string;
    const { pr } = await adapter.get(slug, number);
    if (pr.state !== PrState.Open || pr.review_state !== PrReviewState.Approved) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Only an open, approved pull request can be merged');
    }
    const row = this.actionLog.start({
      sessionId: null,
      kind: ActionKind.Pr,
      target: `${slug}#${number}`,
      command: `merge ${slug}#${number}`,
      isProd: false,
      actor: ActionActor.Operator,
    });
    try {
      await adapter.merge(slug, number);
    } catch (error) {
      this.actionLog.finish(row, ActionOutcome.Failed, error instanceof Error ? error.message : 'merge failed');
      throw error instanceof ApiError && error.code === ErrorCode.RateLimited
        ? error
        : new ApiError(502, ErrorCode.UpstreamFailed, 'The host rejected the merge');
    }
    this.actionLog.finish(row, ActionOutcome.Ok);
    this.drop(repo.id);
    return this.get(repoId, number);
  }

  /** The signed-in login on the host's Connector. */
  login(host: GitHost): string | null {
    const id = CONNECTOR_OF[host];
    if (id === undefined) return null;
    return (
      this.store.db.select({ login: connectors.login }).from(connectors).where(eq(connectors.id, id)).get()?.login ??
      null
    );
  }

  repoRow(id: string): RepoRow {
    const row = this.store.db.select().from(repos).where(eq(repos.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Repo');
    return row;
  }

  /** A Repo on a host that serves pull requests, whose Connector is connected. */
  hosted(repoId: string): RepoRow {
    const repo = this.repoRow(repoId);
    if (!PR_HOSTS.includes(repo.host) || repo.remoteSlug === null) {
      throw new ApiError(409, ErrorCode.InvalidState, `${repo.name} has no Git host with pull requests`);
    }
    this.connectors.require(CONNECTOR_OF[repo.host] as ConnectorId);
    return repo;
  }

  adapter(repo: RepoRow) {
    return this.hosts.for(repo.host);
  }

  /** Forget what was read for a Repo, so the next list reads the host. */
  drop(repoId: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${repoId}:`)) this.cache.delete(key);
  }

  markComments(repoId: string, number: number, comments: HostComment[]): PrComment[] {
    const mine = new Set(
      this.store.db
        .select({ id: agentComments.commentId })
        .from(agentComments)
        .where(and(eq(agentComments.repoId, repoId), eq(agentComments.prNumber, number)))
        .all()
        .map((row) => row.id),
    );
    return comments.map((comment) => ({
      ...comment,
      by_agent: mine.has(comment.id),
      reply_count: comments.filter((other) => other.parent_id === comment.id).length,
    }));
  }

  private key(repoId: string, state: PrState): string {
    return `${repoId}:${state}`;
  }

  private hostedRepos(): RepoRow[] {
    return this.store.db
      .select()
      .from(repos)
      .all()
      .filter((repo) => PR_HOSTS.includes(repo.host) && repo.remoteSlug !== null);
  }

  private connected(host: GitHost): boolean {
    const id = CONNECTOR_OF[host];
    if (id === undefined) return false;
    return (
      this.store.db.select({ status: connectors.status }).from(connectors).where(eq(connectors.id, id)).get()
        ?.status === HealthStatus.Ok
    );
  }

  /** The cached list, or a fresh one; a failed read falls back to the cache and says it is stale. */
  private async read(repo: RepoRow, state: PrState): Promise<{ at: number; prs: HostPullRequest[]; stale: boolean }> {
    const key = this.key(repo.id, state);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return { ...hit, stale: false };
    try {
      this.hosted(repo.id);
      const entry = { at: Date.now(), prs: await this.adapter(repo).list(repo.remoteSlug as string, state) };
      this.cache.set(key, entry);
      return { ...entry, stale: false };
    } catch (error) {
      if (hit) return { ...hit, stale: true };
      throw error;
    }
  }

  private async refreshAll(wanted: RepoRow[], before: Map<string, Entry | undefined>, repoId: string | null) {
    let status: 'ok' | 'rate_limited' | 'failed' = 'ok';
    const changed: { repo_id: string; number: number }[] = [];
    for (const repo of wanted) {
      try {
        const now = await this.read(repo, PrState.Open);
        const old = new Map((before.get(repo.id)?.prs ?? []).map((pr) => [pr.number, signature(pr)]));
        for (const pr of now.prs) {
          if (old.get(pr.number) !== signature(pr)) changed.push({ repo_id: repo.id, number: pr.number });
        }
      } catch (error) {
        this.logger.warn(`refresh of ${repo.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        status = error instanceof ApiError && error.code === ErrorCode.RateLimited ? 'rate_limited' : 'failed';
      }
    }
    this.store.write((_tx, emit) => emit('pull_request.refreshed', { repo_id: repoId, status, changed }));
    for (const listener of this.refreshListeners) listener();
  }

  /** Runs after every PR refresh, once `pull_request.refreshed` has gone out. */
  onRefreshed(listener: () => void): void {
    this.refreshListeners.push(listener);
  }

  /** Adds what only the console knows: whose it is, which Session and which Agent Review belong to it. */
  private decorate(repo: RepoRow, prs: HostPullRequest[]): PullRequest[] {
    const login = this.login(repo.host);
    const rows = this.store.db.select().from(sessions).where(eq(sessions.repoId, repo.id)).all();
    const worked = new Set(rows.filter((row) => row.kind === SessionKind.Repo).map((row) => row.branch));
    const reviewSession = new Map(
      rows.filter((row) => row.kind === SessionKind.PrReview).map((row) => [row.prNumber, row.id]),
    );
    const latest = new Map<number, ReviewRow>();
    const reviews = this.store.db
      .select()
      .from(prAgentReviews)
      .where(eq(prAgentReviews.repoId, repo.id))
      .orderBy(desc(prAgentReviews.createdAt), desc(prAgentReviews.id))
      .all();
    for (const review of reviews) if (!latest.has(review.prNumber)) latest.set(review.prNumber, review);
    return prs.map((pr) => {
      const review = latest.get(pr.number);
      return {
        repo_id: repo.id,
        ...pr,
        // The agent opened it when a Session of its own worked on the branch.
        by_agent: worked.has(pr.branch),
        is_mine: (login !== null && pr.author === login) || worked.has(pr.branch),
        agent_session_id: reviewSession.get(pr.number) ?? null,
        latest_agent_review: review ? toAgentReview(review, pr.head_sha) : null,
      };
    });
  }
}
