import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ActionActor,
  ActionKind,
  ActionOutcome,
  ConnectorId,
  ErrorCode,
  type Finding,
  FindingSeverity,
  GitHost,
  HealthStatus,
  PR_HOSTS,
  type PrAction,
  type PrActionSession,
  PrActionState,
  type PrAgentReview,
  PrChecks,
  type PrComment,
  type PrConflicts,
  type PrFileContent,
  PrMergeState,
  PrReviewEvent,
  PrReviewState,
  PrState,
  type PullRequestDetail,
  type PullRequestSummary,
  SessionKind,
  SessionState,
} from '@ops-console/shared';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { ActionLogService } from '../action-log/action-log.service';
import { ApiError, validationFailed } from '../common/errors';
import { asBackground } from '../common/spawn-pool';
import { ConnectorsService } from '../connectors/connectors.service';
import { agentComments, connectors, prAgentReviews, repos, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GIT, Git } from '../repos/git';
import type { OpenPrBranches } from '../repos/open-pr-branches';
import {
  GIT_HOSTS,
  type GitHostAdapter,
  type GitHosts,
  type HostComment,
  type HostPullRequest,
  type OwnedPullRequest,
} from './git-host';

type RepoRow = typeof repos.$inferSelect;
type ReviewRow = typeof prAgentReviews.$inferSelect;

/**
 * A list read this recently is served from memory. Older, it is still served at once while a new read runs. The
 * Refresh button reads at once.
 */
export const LIST_TTL_MS = 30 * 60_000;

/** A read that failed is tried again after this, or after the list's own TTL when that is shorter. */
const FAILED_RETRY_MS = 5 * 60_000;

/** Repos a refresh reads at once. */
const REFRESH_PARALLEL = 6;

/** A pull request found by number on a host is kept this long, so typing or a refetch does not ask again. */
const LOOKUP_TTL_MS = 60_000;

/**
 * After a host answers 429, no list read of it starts for this long, and the kept lists are served as stale. Each read
 * spends the quota whose shortage caused the 429, so reading on every minute kept the limit up.
 */
export const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;

/** A pull request's detail read this recently is served from memory; older, like a list. */
const DETAIL_TTL_MS = 15_000;

/** A merge check at the same head commit is kept this long; the base may move under it, so not for long. */
const CONFLICTS_TTL_MS = 2 * 60_000;

/** `failed`: the last background read failed, so what is kept may be out of date. `tried`: when that read ran. */
type Kept = { at: number; failed?: boolean; tried?: number };
type Entry = Kept & { prs: HostPullRequest[] };
type OwnerEntry = Kept & { prs: OwnedPullRequest[] };
type HostDetail = Awaited<ReturnType<GitHostAdapter['get']>>;
type DetailEntry = Kept & { value: HostDetail };

const expired = (entry: Kept, ttl: number) =>
  Date.now() - Math.max(entry.at, entry.tried ?? 0) >= (entry.failed ? Math.min(ttl, FAILED_RETRY_MS) : ttl);

/** A search of just a number, with or without `#`: it asks the Git host. */
const asNumber = (q: string): number | null => (/^#?\d{1,9}$/.test(q) ? Number(q.replace('#', '')) : null);

/** How long the list of owners a host lets the operator read is kept. */
const OWNERS_TTL_MS = 10 * 60_000;

/** Pull requests added, gone or changed between two reads of a list, by number. */
function changedNumbers<T extends HostPullRequest>(
  before: T[],
  after: T[],
  scope: (pr: T) => string = () => '',
): number[] {
  const old = new Map(before.map((pr) => [`${scope(pr)}#${pr.number}`, signature(pr)]));
  const now = new Map(after.map((pr) => [`${scope(pr)}#${pr.number}`, signature(pr)]));
  const out = new Set<number>();
  for (const pr of after) if (old.get(`${scope(pr)}#${pr.number}`) !== signature(pr)) out.add(pr.number);
  for (const pr of before) if (!now.has(`${scope(pr)}#${pr.number}`)) out.add(pr.number);
  return [...out];
}

/** Mine searches a pull request's number, its title and the operator's login; All, its number, title and author. */
const matches = (pr: PullRequestSummary, q: string, who: string | null) =>
  [`#${pr.number}`, String(pr.number), pr.title, who ?? ''].some((field) => field.toLowerCase().includes(q));

const sameSlug = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Severities reviews stored before the five levels, read as the nearest level. */
const LEGACY_SEVERITY: Record<string, FindingSeverity> = {
  blocker: FindingSeverity.High,
  suggestion: FindingSeverity.Medium,
  nit: FindingSeverity.Info,
};

export function toAgentReview(row: ReviewRow, headSha: string | null): PrAgentReview {
  const findings = (JSON.parse(row.findings) as Finding[]).map((finding) => ({
    ...finding,
    severity: LEGACY_SEVERITY[finding.severity] ?? finding.severity,
  }));
  return {
    id: row.id,
    repo_id: row.repoId,
    pr_number: row.prNumber,
    head_sha: row.headSha,
    session_id: row.sessionId,
    decision: row.decision,
    verdict: row.verdict,
    base_branch: row.baseBranch,
    base_sha: row.baseSha,
    report: row.report,
    findings,
    created_at: row.createdAt,
    stale: headSha !== null && row.headSha !== headSha,
    note: row.note,
  };
}

/** A PR action Session as the pull request view lists it. */
export function toPrActionSession(row: typeof sessions.$inferSelect, headSha: string | null): PrActionSession {
  const state =
    row.prActionSubmittedAt !== null
      ? PrActionState.Submitted
      : row.state === SessionState.Working
        ? PrActionState.Working
        : PrActionState.NotSubmitted;
  return {
    session_id: row.id,
    action: row.prAction as PrAction,
    state,
    commit_sha: row.prActionCommitSha,
    stale:
      headSha !== null &&
      headSha !== row.prActionHeadSha &&
      (row.prActionCommitSha === null || headSha !== row.prActionCommitSha),
    created_at: row.createdAt,
  };
}

/** A Git host's Connector shares its name. */
const CONNECTOR_OF: Partial<Record<GitHost, ConnectorId>> = {
  [GitHost.Github]: ConnectorId.Github,
  [GitHost.Gitlab]: ConnectorId.Gitlab,
  [GitHost.Bitbucket]: ConnectorId.Bitbucket,
};

const signature = (pr: HostPullRequest) =>
  [
    pr.head_sha,
    pr.state,
    pr.review_state,
    pr.approved_by.join(','),
    pr.checks,
    pr.comment_count,
    pr.resolved_count,
  ].join('|');

/** What a read of one pull request alone gives right on every host; the rest of a kept copy stays as it was. */
const readFields = (pr: HostPullRequest) => ({
  title: pr.title,
  state: pr.state,
  review_state: pr.review_state,
  approved_by: pr.approved_by,
  head_sha: pr.head_sha,
  merged_at: pr.merged_at,
  comment_count: pr.comment_count,
});

/** Whether a background read of a pull request brought something the UI shows: its head, counts or comments. */
const detailChanged = (before: HostDetail, after: HostDetail) =>
  signature(before.pr) !== signature(after.pr) ||
  before.comments.length !== after.comments.length ||
  before.commits.length !== after.commits.length ||
  before.files.length !== after.files.length ||
  before.comments.some((comment, at) => {
    const other = after.comments[at];
    return other === undefined || other.id !== comment.id || other.resolved !== comment.resolved;
  });

/** Pull requests live on the Git host. This keeps list reads in memory for 30 minutes and adds what only the console knows. */
@Injectable()
export class PullRequestsService implements OpenPrBranches {
  private readonly logger = new Logger('pull-requests');
  private readonly cache = new Map<string, Entry>();
  private readonly ownerCache = new Map<string, OwnerEntry>();
  private readonly details = new Map<string, DetailEntry>();
  private readonly conflicts = new Map<string, { at: number; head: string; value: PrConflicts }>();
  private readonly found = new Map<string, { at: number; pr: HostPullRequest | null }>();
  /** Background reads under way, one per cache key. */
  private readonly reading = new Map<string, Promise<void>>();
  private readonly ownersOf = new Map<GitHost, { at: number; owners: string[] }>();
  /** When each rate limited host may be read again. */
  private readonly coolingUntil = new Map<GitHost, number>();
  private readonly refreshListeners: (() => void)[] = [];

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT_HOSTS) private readonly hosts: GitHosts,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
    @Inject(GIT) private readonly git: Git,
  ) {}

  async list(query: {
    repo_id?: string;
    state: PrState;
    mine?: boolean;
    q?: string;
  }): Promise<{ data: PullRequestSummary[]; meta: { synced_at: string | null; stale: boolean; next_cursor: null } }> {
    let stale = false;
    let oldest: number | null = null;
    const data: PullRequestSummary[] = [];
    const seen = (at: number, wasStale: boolean) => {
      stale ||= wasStale;
      oldest = oldest === null ? at : Math.min(oldest, at);
    };
    if (query.repo_id !== undefined) {
      const repo = this.repoRow(query.repo_id);
      const read = await this.read(repo, query.state);
      seen(read.at, read.stale);
      data.push(...this.decorate(repo, repo.host, repo.remoteSlug ?? '', read.prs));
    } else {
      const imported = this.hostedRepos();
      const covered = new Set<string>();
      // Every repository of every owner the operator can read on each connected host.
      // Hosts and owners are read side by side; the list is put together in their order.
      const hosts = PR_HOSTS.filter((one) => this.hosts.supports(one) && this.connected(one));
      const reads = await Promise.all(
        hosts.map(async (host) => {
          const owners = await this.owners(host, imported);
          return Promise.all(
            owners.map(async (owner) => ({
              host,
              owner,
              read: await this.readOwner(host, owner, query.state).catch((error) => {
                // The host answered that the owner is not there (a renamed or deleted organization): nothing to read.
                if (error instanceof ApiError && error.status === 404) {
                  this.logger.debug(`${host} ${owner}: ${error.message}`);
                  return { at: Date.now(), prs: [] as OwnedPullRequest[], stale: false };
                }
                this.logger.warn(`${host} ${owner}: ${error instanceof Error ? error.message : String(error)}`);
                return null;
              }),
            })),
          );
        }),
      );
      this.followMovedRepos(
        imported,
        reads
          .flat()
          .flatMap(({ host, read }) => (read === null ? [] : read.prs.map((pr) => ({ host, slug: pr.slug })))),
      );
      for (const { host, owner, read } of reads.flat()) {
        if (read === null) {
          stale = true;
          continue;
        }
        covered.add(`${host}:${owner.toLowerCase()}`);
        seen(read.at, read.stale);
        const bySlug = new Map<string, OwnedPullRequest[]>();
        for (const pr of read.prs) bySlug.set(pr.slug, [...(bySlug.get(pr.slug) ?? []), pr]);
        for (const [slug, prs] of bySlug) {
          const repo = imported.find((one) => one.host === host && sameSlug(one.remoteSlug ?? '', slug)) ?? null;
          // The Repo's own list is this read too, so a Refresh compares against it.
          if (repo && !read.stale) this.cache.set(this.key(repo.id, query.state), { at: read.at, prs });
          data.push(...this.decorate(repo, host, slug, prs));
        }
      }
      // An imported Repo under an owner no list covered is read on its own.
      const alone = imported.filter((repo) => {
        const owner = (repo.remoteSlug ?? '').split('/')[0]?.toLowerCase() ?? '';
        return this.connected(repo.host) && !covered.has(`${repo.host}:${owner}`);
      });
      const own = await Promise.all(alone.map((repo) => this.read(repo, query.state).catch(() => null)));
      for (const [index, repo] of alone.entries()) {
        const read = own[index] ?? null;
        if (read === null) {
          stale = true;
          continue;
        }
        seen(read.at, read.stale);
        data.push(...this.decorate(repo, repo.host, repo.remoteSlug ?? '', read.prs));
      }
    }
    const q = query.q?.trim().toLowerCase() ?? '';
    const number = asNumber(q);
    if (number !== null && query.repo_id === undefined) {
      const looked = await this.lookup(number, data);
      stale ||= looked.failed;
      // The host answers in any state; the search keeps the list's own, so a merged or closed one stays out.
      data.push(...looked.found.filter((pr) => pr.state === query.state));
    }
    const mine = query.mine === true;
    const logins = new Map<GitHost, string | null>();
    const loginOf = (host: GitHost) => {
      if (!logins.has(host)) logins.set(host, this.login(host));
      return logins.get(host) ?? null;
    };
    const shown = data
      .filter((pr) => !mine || pr.is_mine)
      .filter(
        (pr) =>
          q === '' || (number === null ? matches(pr, q, mine ? loginOf(pr.host) : pr.author) : pr.number === number),
      )
      .sort((a, b) => b.opened_at.localeCompare(a.opened_at));
    return {
      data: shown,
      meta: { synced_at: oldest === null ? null : new Date(oldest).toISOString(), stale, next_cursor: null },
    };
  }

  /**
   * Pull request `number` asked of the host in every project the list knows and every imported Repo, so one on a page
   * the list did not read is found too. `failed` when a host could not be asked.
   */
  private async lookup(
    number: number,
    listed: PullRequestSummary[],
  ): Promise<{ found: PullRequestSummary[]; failed: boolean }> {
    const imported = this.hostedRepos();
    const places = new Map<string, { host: GitHost; slug: string; repo: RepoRow | null }>();
    for (const pr of listed) {
      if (pr.host === GitHost.Local) continue;
      places.set(`${pr.host}:${pr.slug.toLowerCase()}`, {
        host: pr.host,
        slug: pr.slug,
        repo: imported.find((one) => one.host === pr.host && sameSlug(one.remoteSlug ?? '', pr.slug)) ?? null,
      });
    }
    for (const repo of imported) {
      const slug = repo.remoteSlug ?? '';
      if (this.connected(repo.host)) places.set(`${repo.host}:${slug.toLowerCase()}`, { host: repo.host, slug, repo });
    }
    let failed = false;
    const out: PullRequestSummary[] = [];
    await Promise.all(
      [...places.entries()].map(async ([where, place]) => {
        const key = `${where}#${number}`;
        let hit = this.found.get(key);
        if (!hit || Date.now() - hit.at >= LOOKUP_TTL_MS) {
          try {
            const pr = await this.asking(place.host, () => this.hosts.for(place.host).find(place.slug, number));
            hit = { at: Date.now(), pr };
            this.found.set(key, hit);
          } catch (error) {
            this.logger.warn(
              `${place.host} ${place.slug}#${number}: ${error instanceof Error ? error.message : String(error)}`,
            );
            failed = true;
            return;
          }
        }
        if (hit.pr) out.push(...this.decorate(place.repo, place.host, place.slug, [hit.pr]));
      }),
    );
    // A pull request the list already has is not added twice.
    const have = new Set(listed.map((pr) => `${pr.host}:${pr.slug.toLowerCase()}#${pr.number}`));
    const fresh = out.filter((pr) => !have.has(`${pr.host}:${pr.slug.toLowerCase()}#${pr.number}`));
    return { found: fresh, failed };
  }

  /** Drops the memory and reads again in the background; `pull_request.refreshed` reports it. */
  refresh(repoId: string | undefined): void {
    const wanted = repoId === undefined ? this.hostedRepos() : [this.repoRow(repoId)];
    this.found.clear();
    if (repoId === undefined) {
      // A rate limited host keeps what was read: asking again would fail and leave the list empty.
      for (const key of [...this.ownerCache.keys()]) {
        const [host, owner] = key.split(':') as [GitHost, string];
        if (this.cooling(host)) continue;
        this.ownerCache.delete(key);
        // Refresh is the operator asking for everything again, so an adapter's own memory of quiet repositories goes too.
        this.hosts.for(host).forgetOwner?.(owner);
      }
      for (const host of [...this.ownersOf.keys()]) if (!this.cooling(host)) this.ownersOf.delete(host);
    }
    const before = new Map<string, Entry | undefined>();
    for (const repo of wanted) {
      before.set(repo.id, this.cache.get(this.key(repo.id, PrState.Open)));
      if (!this.cooling(repo.host)) this.drop(repo.id);
    }
    void asBackground(() => this.refreshAll(wanted, before, repoId ?? null));
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
    const { pr, files, comments, commits } = await this.detail(repo, number);
    const actions = this.store.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.repoId, repo.id), eq(sessions.prNumber, number), isNotNull(sessions.prAction)))
      .orderBy(desc(sessions.createdAt), desc(sessions.id))
      .all();
    const review = this.store.db
      .select()
      .from(prAgentReviews)
      .where(and(eq(prAgentReviews.repoId, repo.id), eq(prAgentReviews.prNumber, number)))
      .orderBy(desc(prAgentReviews.createdAt), desc(prAgentReviews.id))
      .get();
    return {
      ...(this.decorate(repo, repo.host, repo.remoteSlug as string, [pr])[0] as PullRequestSummary),
      body: pr.body,
      latest_agent_review: review ? toAgentReview(review, pr.head_sha) : null,
      repo_id: repo.id,
      files,
      comments: this.markComments(repo.id, number, comments),
      action_sessions: actions.map((row) => toPrActionSession(row, pr.head_sha)),
      commits,
      conflicts: this.conflictsOf(repo, pr),
    };
  }

  /**
   * Whether an open pull request's branch merges into its base, as last checked at its head commit. A missing or old
   * check starts one in the background and says `checking`; when it lands, the UI is told to read again.
   */
  private conflictsOf(repo: RepoRow, pr: HostPullRequest): PrConflicts | null {
    if (pr.state !== PrState.Open) return null;
    const key = `${repo.id}:#${pr.number}`;
    const hit = this.conflicts.get(key);
    const same = hit?.head === pr.head_sha;
    if (!same || Date.now() - (hit?.at ?? 0) >= CONFLICTS_TTL_MS) {
      this.inBackground(`conflicts:${key}`, async () => {
        const value = await this.checkConflicts(repo, pr);
        const before = this.conflicts.get(key);
        this.conflicts.set(key, { at: Date.now(), head: pr.head_sha, value });
        const changed =
          before?.head !== pr.head_sha ||
          before.value.state !== value.state ||
          `${before.value.files}` !== `${value.files}`;
        try {
          if (changed) this.announce(repo.id, [{ repo_id: repo.id, number: pr.number }]);
        } catch {
          // The daemon stopped while git ran: nobody is left to tell.
        }
      });
    }
    return same && hit ? hit.value : { state: PrMergeState.Checking, files: [], checked_at: null };
  }

  /** Fetches the base and the head from origin into the Repo's folder, then asks `git merge-tree`. */
  private async checkConflicts(repo: RepoRow, pr: HostPullRequest): Promise<PrConflicts> {
    const checkedAt = new Date().toISOString();
    try {
      const base = await this.git.remoteHead(repo.path, pr.base_branch, true);
      if (!(await this.git.hasCommit(repo.path, pr.head_sha))) {
        await this.git.fetchRef(repo.path, this.adapter(repo).headRef(pr.number, pr.branch), true);
      }
      const files = await this.git.mergeConflicts(repo.path, base, pr.head_sha);
      if (files === null) return { state: PrMergeState.Unknown, files: [], checked_at: checkedAt };
      return { state: files.length > 0 ? PrMergeState.Conflict : PrMergeState.Clean, files, checked_at: checkedAt };
    } catch {
      return { state: PrMergeState.Unknown, files: [], checked_at: checkedAt };
    }
  }

  /** One file of the pull request at `ref`, read from the host. */
  async file(repoId: string, path: string, ref: string): Promise<PrFileContent> {
    const repo = this.hosted(repoId);
    return { path, ref, text: await this.adapter(repo).fileAt(repo.remoteSlug as string, ref, path) };
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
    const headSha = input.file_path ? (await this.detail(repo, number)).pr.head_sha : '';
    const posted = await adapter.postComment(slug, number, { ...input, head_sha: headSha });
    this.patch(
      repo,
      number,
      (pr) => ({ ...pr, comment_count: pr.comment_count + 1 }),
      (value) => ({
        ...value,
        comments: [...value.comments, posted].sort((a, b) => a.created_at.localeCompare(b.created_at)),
      }),
    );
    return this.markComments(repo.id, number, [posted])[0] as PrComment;
  }

  async resolve(repoId: string, number: number, commentId: string, resolved: boolean): Promise<PrComment> {
    const repo = this.hosted(repoId);
    const adapter = this.adapter(repo);
    const slug = repo.remoteSlug as string;
    // The kept read is what the operator clicked on; the host is asked again only for a comment it has not seen.
    let comments = (await this.detail(repo, number)).comments;
    if (!comments.some((comment) => comment.id === commentId)) comments = (await adapter.get(slug, number)).comments;
    const found = comments.find((comment) => comment.id === commentId);
    if (!found) throw new ApiError(404, ErrorCode.NotFound, 'no such comment');
    if (found.parent_id !== null) throw new ApiError(409, ErrorCode.InvalidState, 'only a thread can be resolved');
    const moved = found.resolved === resolved ? 0 : resolved ? 1 : -1;
    await adapter.setResolved(slug, number, commentId, resolved);
    const after = comments.map((comment) => (comment.id === commentId ? { ...comment, resolved } : comment));
    this.patch(
      repo,
      number,
      (pr) => ({ ...pr, resolved_count: Math.max(0, pr.resolved_count + moved) }),
      (value) => ({ ...value, comments: after }),
    );
    return this.markComments(repo.id, number, after).find((comment) => comment.id === commentId) as PrComment;
  }

  /** Deletes a comment the operator or the agent wrote; anyone else's is refused before the host is asked. */
  async deleteComment(repoId: string, number: number, commentId: string): Promise<void> {
    const repo = this.hosted(repoId);
    const adapter = this.adapter(repo);
    const slug = repo.remoteSlug as string;
    let comments = (await this.detail(repo, number)).comments;
    if (!comments.some((comment) => comment.id === commentId)) comments = (await adapter.get(slug, number)).comments;
    const found = this.markComments(repo.id, number, comments).find((comment) => comment.id === commentId);
    if (!found) throw new ApiError(404, ErrorCode.NotFound, 'no such comment');
    if (!found.is_mine) throw new ApiError(409, ErrorCode.InvalidState, 'You can delete only your own comments');
    await adapter.deleteComment(slug, number, commentId);
    this.store.write((tx) => {
      tx.delete(agentComments)
        .where(
          and(
            eq(agentComments.repoId, repo.id),
            eq(agentComments.prNumber, number),
            eq(agentComments.commentId, commentId),
          ),
        )
        .run();
    });
    this.patch(
      repo,
      number,
      (pr) => ({
        ...pr,
        comment_count: Math.max(0, pr.comment_count - 1),
        resolved_count: Math.max(0, pr.resolved_count - (found.parent_id === null && found.resolved ? 1 : 0)),
      }),
      (value) => ({ ...value, comments: value.comments.filter((comment) => comment.id !== commentId) }),
    );
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
      const { pr } = await this.detail(repo, number);
      const login = this.login(repo.host);
      if (login !== null && pr.author === login) {
        throw new ApiError(409, ErrorCode.InvalidState, 'You cannot review your own pull request');
      }
    }
    await adapter.review(slug, number, event, body ?? '');
    await this.reload(repo, number);
    return this.get(repoId, number);
  }

  /** The operator's merge: the host's review state must read `approved`. The agent has no such path (ADR 0002). */
  async merge(repoId: string, number: number): Promise<PullRequestDetail> {
    const repo = this.hosted(repoId);
    const adapter = this.adapter(repo);
    const slug = repo.remoteSlug as string;
    const { pr } = await this.recent(repo, number);
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
    await this.reload(repo, number);
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
    const row = this.store.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.removedAt)))
      .get();
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

  /** The host's adapter when it has landed; null for a host the console cannot read yet. */
  adapterFor(host: GitHost): GitHostAdapter | null {
    return this.hosts.supports(host) ? this.hosts.for(host) : null;
  }

  /**
   * A pull request as the host has it, kept like a list. Writes read the host themselves; this is for showing it.
   */
  async detail(repo: RepoRow, number: number): Promise<HostDetail> {
    const key = `${repo.id}:#${number}`;
    const read = () => this.adapter(repo).get(repo.remoteSlug as string, number);
    const hit = this.details.get(key);
    if (!hit) {
      const value = await read();
      this.details.set(key, { at: Date.now(), value });
      return value;
    }
    if (expired(hit, DETAIL_TTL_MS)) {
      this.inBackground(key, async () => {
        try {
          const value = await read();
          if (this.details.get(key) !== hit) return;
          this.details.set(key, { at: Date.now(), value });
          if (detailChanged(hit.value, value)) {
            this.announce(repo.id, [{ repo_id: repo.id, number }]);
          }
        } catch {
          if (this.details.get(key) === hit) this.details.set(key, { ...hit, failed: true, tried: Date.now() });
        }
      });
    }
    return hit.value;
  }

  private cooling(host: GitHost): boolean {
    return (this.coolingUntil.get(host) ?? 0) > Date.now();
  }

  /** Runs a read of `host`; a 429 starts its cooldown, and a read inside one is refused without asking the host. */
  private async asking<T>(host: GitHost, ask: () => Promise<T>): Promise<T> {
    if (this.cooling(host)) throw new ApiError(429, ErrorCode.RateLimited, `${host} is rate limiting the console`);
    try {
      return await ask();
    } catch (error) {
      if (error instanceof ApiError && error.code === ErrorCode.RateLimited) {
        this.coolingUntil.set(host, Date.now() + RATE_LIMIT_COOLDOWN_MS);
      }
      throw error;
    }
  }

  /** Runs `work` unless a background read for `key` is already under way. */
  private inBackground(key: string, work: () => Promise<void>): void {
    if (this.reading.has(key)) return;
    this.reading.set(
      key,
      asBackground(work).finally(() => this.reading.delete(key)),
    );
  }

  /** Tells the UI that a background read brought something new, so it reads again; the read is served from memory. */
  private announce(repoId: string | null, changed: { repo_id: string; number: number }[]): void {
    this.store.write((_tx, emit) => emit('pull_request.refreshed', { repo_id: repoId, status: 'ok', changed }));
  }

  /** Forget what was read for a Repo, so the next list reads the host. */
  drop(repoId: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${repoId}:`)) this.cache.delete(key);
    for (const key of this.details.keys()) if (key.startsWith(`${repoId}:`)) this.details.delete(key);
    for (const key of this.conflicts.keys()) if (key.startsWith(`${repoId}:`)) this.conflicts.delete(key);
    // The owner's list holds the Repo's pull requests too.
    const repo = this.store.db.select().from(repos).where(eq(repos.id, repoId)).get();
    const owner = repo?.remoteSlug?.split('/')[0]?.toLowerCase();
    if (!repo || !owner) return;
    for (const key of this.ownerCache.keys()) if (key.startsWith(`${repo.host}:${owner}:`)) this.ownerCache.delete(key);
  }

  /**
   * After the console wrote on a pull request outside a button (an agent's comment, a job's push): reads it again in
   * the background and puts the result in the kept lists and detail, so the next read needs no cold host call.
   */
  wrote(repoId: string, number: number): void {
    const repo = this.store.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, repoId), isNull(repos.removedAt)))
      .get();
    if (!repo || repo.remoteSlug === null || !this.hosts.supports(repo.host)) return;
    const key = `${repo.id}:#${number}`;
    this.inBackground(`wrote:${key}`, async () => {
      try {
        const before = this.details.get(key)?.value;
        const after = await this.reload(repo, number);
        if (before === undefined || detailChanged(before, after))
          this.announce(repo.id, [{ repo_id: repo.id, number }]);
      } catch {
        // The kept copy stands; the next read of the host brings it up to date.
        this.drop(repo.id);
      }
    });
  }

  /** A pull request the console just opened, put in the kept lists so the next list read needs no host call. */
  noteOpened(
    repoId: string,
    opened: { number: number; url: string; title: string; body: string; branch: string; base: string; head: string },
  ): void {
    const repo = this.repoRow(repoId);
    this.place(repo, {
      number: opened.number,
      url: opened.url,
      title: opened.title,
      author: this.login(repo.host) ?? 'unknown',
      branch: opened.branch,
      base_branch: opened.base,
      head_sha: opened.head,
      state: PrState.Open,
      review_state: PrReviewState.None,
      approved_by: [],
      checks: PrChecks.None,
      additions: 0,
      deletions: 0,
      body: opened.body,
      opened_at: new Date().toISOString(),
      merged_at: null,
      comment_count: 0,
      resolved_count: 0,
    });
  }

  /** The pull request as the host has it now: replaces the kept detail and updates the kept lists. */
  private async reload(repo: RepoRow, number: number): Promise<HostDetail> {
    const value = await this.asking(repo.host, () => this.adapter(repo).get(repo.remoteSlug as string, number));
    this.details.set(`${repo.id}:#${number}`, { at: Date.now(), value });
    this.place(repo, value.pr);
    return value;
  }

  /**
   * The pull request for a write or a job start. A kept detail is reused after one read of the pull request alone
   * confirms its head commit and state, which is one host call where a full read is six; otherwise it is read in full.
   */
  async recent(repo: RepoRow, number: number): Promise<HostDetail> {
    const hit = this.details.get(`${repo.id}:#${number}`);
    if (hit && !hit.failed && Date.now() - hit.at < DETAIL_TTL_MS) {
      const now = await this.asking(repo.host, () => this.adapter(repo).find(repo.remoteSlug as string, number)).catch(
        () => null,
      );
      if (now && now.head_sha === hit.value.pr.head_sha && now.state === hit.value.pr.state) {
        return { ...hit.value, pr: { ...hit.value.pr, ...readFields(now) } };
      }
    }
    return this.reload(repo, number);
  }

  /** Changes a pull request in every kept list that holds it and in its kept detail. */
  private patch(
    repo: RepoRow,
    number: number,
    change: (pr: HostPullRequest) => HostPullRequest,
    detail: (value: HostDetail) => HostDetail = (value) => value,
  ): void {
    const slug = repo.remoteSlug as string;
    const owner = slug.split('/')[0]?.toLowerCase() ?? '';
    for (const [key, entry] of this.cache) {
      if (key.startsWith(`${repo.id}:`)) entry.prs = entry.prs.map((pr) => (pr.number === number ? change(pr) : pr));
    }
    for (const [key, entry] of this.ownerCache) {
      if (!key.startsWith(`${repo.host}:${owner}:`)) continue;
      entry.prs = entry.prs.map((pr) =>
        pr.number === number && sameSlug(pr.slug, slug) ? { ...change(pr), slug: pr.slug } : pr,
      );
    }
    const key = `${repo.id}:#${number}`;
    const hit = this.details.get(key);
    if (hit) this.details.set(key, { ...hit, value: { ...detail(hit.value), pr: change(hit.value.pr) } });
  }

  /**
   * Puts a pull request just read from the host into the kept lists of its state, drops it from the lists of the
   * others, and brings the kept detail's fields up to date. A list nobody has read yet is left for its first read.
   */
  private place(repo: RepoRow, pr: HostPullRequest): void {
    const slug = repo.remoteSlug as string;
    const owner = slug.split('/')[0]?.toLowerCase() ?? '';
    const put = <T extends HostPullRequest>(
      prs: T[],
      state: PrState,
      make: () => T,
      same: (one: T) => boolean,
    ): T[] => {
      const found = prs.find((one) => one.number === pr.number && same(one));
      if (pr.state !== state) return found ? prs.filter((one) => one !== found) : prs;
      if (!found) return [...prs, make()];
      return prs.map((one) => (one === found ? { ...one, ...readFields(pr) } : one));
    };
    for (const state of Object.values(PrState)) {
      const entry = this.cache.get(this.key(repo.id, state));
      if (entry)
        entry.prs = put(
          entry.prs,
          state,
          () => pr,
          () => true,
        );
      const owned = this.ownerCache.get(`${repo.host}:${owner}:${state}`);
      if (owned)
        owned.prs = put(
          owned.prs,
          state,
          () => ({ ...pr, slug }),
          (one) => sameSlug(one.slug, slug),
        );
    }
    const key = `${repo.id}:#${pr.number}`;
    const hit = this.details.get(key);
    if (hit) this.details.set(key, { ...hit, value: { ...hit.value, pr: { ...hit.value.pr, ...readFields(pr) } } });
  }

  markComments(repoId: string, number: number, comments: HostComment[]): PrComment[] {
    const login = this.login(this.repoRow(repoId).host);
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
      is_mine: mine.has(comment.id) || (login !== null && comment.author === login),
      reply_count: comments.filter((other) => other.parent_id === comment.id).length,
    }));
  }

  private key(repoId: string, state: PrState): string {
    return `${repoId}:${state}`;
  }

  /**
   * A repository the host lists under an owner no imported Repo has, while one unmatched imported Repo has the same
   * name, is that Repo after the host moved it (an organization renamed). The Repo takes the host's `owner/name`;
   * its folder's `origin` is left as it is. Two candidates on either side map nothing.
   */
  private followMovedRepos(imported: RepoRow[], listed: { host: GitHost; slug: string }[]): void {
    const nameOf = (slug: string) => slug.split('/').at(-1)?.toLowerCase() ?? '';
    const unmatched = new Map<string, { host: GitHost; slug: string }[]>();
    for (const one of listed) {
      if (imported.some((repo) => repo.host === one.host && sameSlug(repo.remoteSlug ?? '', one.slug))) continue;
      const key = `${one.host}:${nameOf(one.slug)}`;
      const seen = unmatched.get(key) ?? [];
      if (!seen.some((other) => other.slug === one.slug)) seen.push(one);
      unmatched.set(key, seen);
    }
    for (const [key, found] of unmatched) {
      if (found.length !== 1) continue;
      const [one] = found as [{ host: GitHost; slug: string }];
      const candidates = imported.filter(
        (repo) =>
          repo.host === one.host &&
          repo.remoteSlug !== null &&
          nameOf(repo.remoteSlug) === key.slice(one.host.length + 1) &&
          !listed.some((other) => other.host === repo.host && sameSlug(other.slug, repo.remoteSlug ?? '')),
      );
      const [repo] = candidates;
      if (candidates.length !== 1 || repo === undefined) continue;
      this.store.write((tx) => {
        tx.update(repos).set({ remoteSlug: one.slug }).where(eq(repos.id, repo.id)).run();
      });
      repo.remoteSlug = one.slug;
    }
  }

  /** Repos a list across Repos reads: a host with no adapter yet would fail the whole list. */
  private hostedRepos(): RepoRow[] {
    return this.store.db
      .select()
      .from(repos)
      .where(isNull(repos.removedAt))
      .all()
      .filter((repo) => PR_HOSTS.includes(repo.host) && repo.remoteSlug !== null && this.hosts.supports(repo.host));
  }

  private connected(host: GitHost): boolean {
    const id = CONNECTOR_OF[host];
    if (id === undefined) return false;
    return (
      this.store.db.select({ status: connectors.status }).from(connectors).where(eq(connectors.id, id)).get()
        ?.status === HealthStatus.Ok
    );
  }

  /**
   * The kept list, read again in the background once it is a minute old; with nothing kept, a fresh one. A failed
   * background read leaves the list kept and marks it stale.
   */
  private async read(repo: RepoRow, state: PrState): Promise<{ at: number; prs: HostPullRequest[]; stale: boolean }> {
    const key = this.key(repo.id, state);
    const fetch = async () => {
      this.hosted(repo.id);
      return {
        at: Date.now(),
        prs: await this.asking(repo.host, () => this.adapter(repo).list(repo.remoteSlug as string, state)),
      };
    };
    const hit = this.cache.get(key);
    if (!hit) {
      const entry = await fetch();
      this.cache.set(key, entry);
      return { ...entry, stale: false };
    }
    if (expired(hit, LIST_TTL_MS)) {
      this.inBackground(key, async () => {
        try {
          const entry = await fetch();
          if (this.cache.get(key) !== hit) return;
          this.cache.set(key, entry);
          if (changedNumbers(hit.prs, entry.prs).length > 0) {
            this.announce(
              repo.id,
              changedNumbers(hit.prs, entry.prs).map((number) => ({ repo_id: repo.id, number })),
            );
          }
        } catch {
          if (this.cache.get(key) === hit) this.cache.set(key, { ...hit, failed: true, tried: Date.now() });
        }
      });
    }
    return { at: hit.at, prs: hit.prs, stale: hit.failed === true };
  }

  private async refreshAll(wanted: RepoRow[], before: Map<string, Entry | undefined>, repoId: string | null) {
    let status: 'ok' | 'rate_limited' | 'failed' = 'ok';
    const changed: { repo_id: string; number: number }[] = [];
    const queue = [...wanted];
    // Each Repo is a host call of about a second: a few at a time, not one after another.
    await Promise.all(
      Array.from({ length: Math.min(REFRESH_PARALLEL, queue.length) }, async () => {
        for (let repo = queue.shift(); repo; repo = queue.shift()) {
          try {
            const now = await this.read(repo, PrState.Open);
            const old = new Map((before.get(repo.id)?.prs ?? []).map((pr) => [pr.number, signature(pr)]));
            for (const pr of now.prs) {
              if (old.get(pr.number) !== signature(pr)) changed.push({ repo_id: repo.id, number: pr.number });
            }
          } catch (error) {
            this.logger.warn(
              `refresh of ${repo.name} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            status = error instanceof ApiError && error.code === ErrorCode.RateLimited ? 'rate_limited' : 'failed';
          }
        }
      }),
    );
    if (status === 'ok' && wanted.some((repo) => this.cooling(repo.host))) status = 'rate_limited';
    this.store.write((_tx, emit) => emit('pull_request.refreshed', { repo_id: repoId, status, changed }));
    for (const listener of this.refreshListeners) listener();
  }

  /** Runs after every PR refresh, once `pull_request.refreshed` has gone out. */
  onRefreshed(listener: () => void): void {
    this.refreshListeners.push(listener);
  }

  /**
   * The owners to list on a host: those the host says the operator can read, the Connector's own (a Bitbucket
   * workspace, a GitHub org), and the owners of imported Repos there. Kept 10 minutes.
   */
  private async owners(host: GitHost, imported: RepoRow[]): Promise<string[]> {
    const kept = this.ownersOf.get(host);
    let owners = kept && Date.now() - kept.at < OWNERS_TTL_MS ? kept.owners : null;
    if (owners === null) {
      owners = await this.hosts
        .for(host)
        .owners()
        .catch((error) => {
          this.logger.warn(`${host} owners: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        });
      // An empty answer is kept too: asking again on every list would add the host's delay to each one.
      this.ownersOf.set(host, { at: Date.now(), owners });
    }
    const out: string[] = [];
    const add = (owner: string | null | undefined) => {
      if (owner && !out.some((one) => sameSlug(one, owner))) out.push(owner);
    };
    for (const owner of owners) add(owner);
    const config = this.connectorConfig(host);
    add(typeof config.workspace === 'string' ? config.workspace : null);
    add(typeof config.org === 'string' ? config.org : null);
    for (const repo of imported) if (repo.host === host) add(repo.remoteSlug?.split('/')[0]);
    return out;
  }

  private connectorConfig(host: GitHost): Record<string, unknown> {
    const id = CONNECTOR_OF[host];
    if (id === undefined) return {};
    const raw = this.store.db.select({ config: connectors.config }).from(connectors).where(eq(connectors.id, id)).get();
    try {
      return JSON.parse(raw?.config ?? '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** One owner's pull requests, cached like a Repo's; a failed read falls back to the cache and says so. */
  private async readOwner(
    host: GitHost,
    owner: string,
    state: PrState,
  ): Promise<{ at: number; prs: OwnedPullRequest[]; stale: boolean }> {
    const key = `${host}:${owner.toLowerCase()}:${state}`;
    const fetch = async () => ({
      at: Date.now(),
      prs: await this.asking(host, () => this.hosts.for(host).listOwner(owner, state)),
    });
    const hit = this.ownerCache.get(key);
    if (!hit) {
      const entry = await fetch();
      this.ownerCache.set(key, entry);
      return { ...entry, stale: false };
    }
    if (expired(hit, LIST_TTL_MS)) {
      this.inBackground(key, async () => {
        try {
          const entry = await fetch();
          if (this.ownerCache.get(key) !== hit) return;
          this.ownerCache.set(key, entry);
          if (changedNumbers(hit.prs, entry.prs, (pr) => pr.slug).length > 0) this.announce(null, []);
        } catch {
          if (this.ownerCache.get(key) === hit) this.ownerCache.set(key, { ...hit, failed: true, tried: Date.now() });
        }
      });
    }
    return { at: hit.at, prs: hit.prs, stale: hit.failed === true };
  }

  /**
   * Adds what only the console knows: whose it is, which Session and which Agent Review belong to it. A list row has no
   * description and only the brief of its newest Agent Review.
   */
  private decorate(repo: RepoRow | null, host: GitHost, slug: string, prs: HostPullRequest[]): PullRequestSummary[] {
    const login = this.login(host);
    const listed = (pr: HostPullRequest) => {
      const { slug: _slug, body: _body, ...fields } = pr as OwnedPullRequest;
      return fields;
    };
    if (repo === null) {
      return prs.map((pr) => ({
        ...listed(pr),
        repo_id: null,
        host,
        slug,
        by_agent: false,
        is_mine: login !== null && pr.author === login,
        agent_session_id: null,
        latest_agent_review: null,
      }));
    }
    const rows = this.store.db
      .select({ id: sessions.id, kind: sessions.kind, branch: sessions.branch, prNumber: sessions.prNumber })
      .from(sessions)
      .where(eq(sessions.repoId, repo.id))
      .all();
    const worked = new Set(rows.filter((row) => row.kind === SessionKind.Repo).map((row) => row.branch));
    const reviewSession = new Map(
      rows.filter((row) => row.kind === SessionKind.PrReview).map((row) => [row.prNumber, row.id]),
    );
    const latest = this.latestReviews(repo.id);
    return prs.map((pr) => {
      const review = latest.get(pr.number);
      return {
        ...listed(pr),
        repo_id: repo.id,
        host,
        slug,
        // The agent opened it when a Session of its own worked on the branch.
        by_agent: worked.has(pr.branch),
        is_mine: (login !== null && pr.author === login) || worked.has(pr.branch),
        agent_session_id: reviewSession.get(pr.number) ?? null,
        latest_agent_review: review ? { decision: review.decision, stale: review.headSha !== pr.head_sha } : null,
      };
    });
  }

  /** The newest Agent Review of each pull request of a Repo, in one query. */
  private latestReviews(repoId: string) {
    const ranked = this.store.db
      .select({
        prNumber: prAgentReviews.prNumber,
        decision: prAgentReviews.decision,
        headSha: prAgentReviews.headSha,
        rank: sql<number>`row_number() over (partition by ${prAgentReviews.prNumber} order by ${prAgentReviews.createdAt} desc, ${prAgentReviews.id} desc)`.as(
          'rank',
        ),
      })
      .from(prAgentReviews)
      .where(eq(prAgentReviews.repoId, repoId))
      .as('ranked');
    const rows = this.store.db.select().from(ranked).where(eq(ranked.rank, 1)).all();
    return new Map(rows.map((row) => [row.prNumber, row]));
  }
}
