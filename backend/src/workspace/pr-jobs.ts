import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ActionKind,
  ActionOutcome,
  AgentReviewStatus,
  type CommentPass,
  ErrorCode,
  type JobPlaybook,
  passThreadSchema,
  type ReplyCheck,
  SessionKind,
} from '@ops-console/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { ActionLogService } from '../action-log/action-log.service';
import { AgentRuntime } from '../agent/runtime';
import { SessionsService } from '../agent/sessions.service';
import { DATA_DIR } from '../common/data-dir';
import { ApiError } from '../common/errors';
import { StartupRecovery } from '../common/recovery';
import { agentComments, prAgentReviews, prCommentPasses, prReplyChecks, type repos, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GIT, Git, GitFailed } from '../repos/git';
import { GIT_HOSTS, type GitHosts, type HostComment } from './git-host';

type RepoRow = typeof repos.$inferSelect;
type ReplyCheckRow = typeof prReplyChecks.$inferSelect;
type CommentPassRow = typeof prCommentPasses.$inferSelect;

/** A pass thread as stored: the view's fields without `posted`, plus the reply's id once it is on the host. */
const storedThreadSchema = passThreadSchema.omit({ posted: true }).extend({ reply_comment_id: z.string().nullable() });

export type StoredThread = z.infer<typeof storedThreadSchema>;

/** A Comment pass's threads, read from its row. */
export const storedThreads = (row: { threads: string }): StoredThread[] =>
  z.array(storedThreadSchema).parse(JSON.parse(row.threads));

/** How long a reply in a thread waits between looks for the pull request's job to end. */
const IDLE_POLL_MS = 1000;

/** A job stops here; the message is the operator's to read. */
export class JobFailed extends Error {
  constructor(
    message: string,
    readonly canRetry: boolean,
  ) {
    super(message);
  }
}

export function toReplyCheck(row: ReplyCheckRow, playbook: JobPlaybook | null): ReplyCheck {
  return {
    id: row.id,
    repo_id: row.repoId,
    pr_number: row.prNumber,
    comment_id: row.commentId,
    head_sha: row.headSha,
    status: row.status,
    verdict: row.verdict,
    reply: row.reply,
    resolved: row.resolved,
    error: row.error,
    can_retry: row.status === AgentReviewStatus.Failed && row.canRetry,
    created_at: row.createdAt,
    started_at: row.startedAt ?? row.createdAt,
    finished_at: row.finishedAt,
    playbook,
  };
}

export function toCommentPass(row: CommentPassRow, headSha: string | null, playbook: JobPlaybook | null): CommentPass {
  const threads = storedThreads(row);
  return {
    id: row.id,
    repo_id: row.repoId,
    pr_number: row.prNumber,
    kind: row.kind,
    head_sha: row.headSha,
    status: row.status,
    commit_sha: row.commitSha,
    threads: threads.map(({ reply_comment_id, ...thread }) => ({ ...thread, posted: reply_comment_id !== null })),
    error: row.error,
    can_retry: row.status === AgentReviewStatus.Failed && row.canRetry,
    stale: headSha !== null && headSha !== row.headSha && headSha !== row.commitSha,
    created_at: row.createdAt,
    started_at: row.startedAt ?? row.createdAt,
    finished_at: row.finishedAt,
    playbook,
  };
}

/** A thread's root and its replies, oldest first. */
export function threadOf(comments: HostComment[], rootId: string): HostComment[] {
  return comments
    .filter((comment) => comment.id === rootId || comment.parent_id === rootId)
    .sort((a, b) => (a.id === rootId ? -1 : b.id === rootId ? 1 : a.created_at.localeCompare(b.created_at)));
}

export const threadText = (thread: HostComment[]) =>
  thread.map((comment) => `${comment.author}: ${comment.body}`).join('\n\n');

/** Where a thread sits: `file:line`, a file, or the pull request itself for a general comment. */
export const fileLine = (comment: { file_path: string | null; line: number | null }) =>
  comment.file_path ? `${comment.file_path}${comment.line ? `:${comment.line}` : ''}` : 'the pull request';

/**
 * What Agent Reviews, Reply checks and Comment passes share: the pull request's Session, one job at a time on it,
 * the scratch copy at its head commit, and the replies and resolves the console makes on the agent's behalf.
 */
@Injectable()
export class PrJobs {
  private readonly logger = new Logger('pr-jobs');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(GIT) private readonly git: Git,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
    @Inject(GIT_HOSTS) private readonly hosts: GitHosts,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('pull request jobs', () => this.recover());
  }

  /**
   * Start-up: a Reply check or Comment pass the last daemon left running failed as interrupted, and can retry once
   * it got as far as a scratch copy. Then only failed jobs keep theirs.
   */
  private async recover(): Promise<void> {
    this.store.write((tx, emit) => {
      for (const [kind, table] of [
        ['reply_check', prReplyChecks],
        ['comment_pass', prCommentPasses],
      ] as const) {
        const rows = tx
          .update(table)
          .set({
            status: AgentReviewStatus.Failed,
            error: 'interrupted',
            canRetry: isNotNull(table.scratchPath),
            finishedAt: new Date().toISOString(),
          })
          .where(eq(table.status, AgentReviewStatus.Running))
          .returning()
          .all();
        for (const row of rows) {
          emit('pull_request.job_changed', {
            repo_id: row.repoId,
            number: row.prNumber,
            kind,
            id: row.id,
            status: 'failed',
          });
        }
      }
    });
    await this.sweepScratch();
  }

  /** The pull request's one `pr_review` Session, made on first use. */
  session(repo: RepoRow, number: number): string {
    const existing = this.store.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.repoId, repo.id), eq(sessions.prNumber, number), eq(sessions.kind, SessionKind.PrReview)))
      .get();
    if (existing) return existing.id;
    const created = this.sessions.create({ kind: SessionKind.PrReview, repoId: repo.id, prNumber: number });
    this.sessions.update(created.id, { title: `${repo.name} #${number} review` });
    return created.id;
  }

  /** One job on a pull request at a time (Behavior 23): a job holds the Session between its steps too. */
  requireIdle(repo: RepoRow, number: number): string {
    const session = this.session(repo, number);
    if (this.busy(repo, number, session)) {
      throw new ApiError(409, ErrorCode.SessionBusy, 'The agent is working on this PR');
    }
    return session;
  }

  /** Resolves with the Session once no job or turn runs on the pull request; a reply in a thread waits here. */
  async whenIdle(repo: RepoRow, number: number): Promise<string> {
    const session = this.session(repo, number);
    while (this.busy(repo, number, session)) await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
    return session;
  }

  private busy(repo: RepoRow, number: number, session: string): boolean {
    const running = (table: typeof prAgentReviews | typeof prReplyChecks | typeof prCommentPasses) =>
      this.store.db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.repoId, repo.id), eq(table.prNumber, number), eq(table.status, AgentReviewStatus.Running)))
        .get() !== undefined;
    return this.runtime.busy(session) || running(prAgentReviews) || running(prReplyChecks) || running(prCommentPasses);
  }

  /** A scratch copy of the Repo at the pull request's head commit, fetched from its branch on `origin`. */
  async makeScratch(repo: RepoRow, branch: string, headSha: string, jobId: string): Promise<string> {
    const dir = path.join(this.dataDir, 'pr-scratch', jobId);
    try {
      await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
      await this.git.fetchBranch(repo.path, branch);
      await this.git.addWorktree(repo.path, dir, headSha);
    } catch (error) {
      const message = error instanceof GitFailed && error.message ? error.message : 'git failed';
      throw new JobFailed(`Could not make a scratch copy: ${message}`, false);
    }
    return dir;
  }

  async dropScratch(dir: string | null): Promise<void> {
    if (!dir) return;
    await this.git
      .removeWorktree(dir)
      .catch((error) =>
        this.logger.warn(`scratch copy not removed: ${error instanceof Error ? error.message : String(error)}`),
      );
  }

  /** Posts the agent's reply in a thread, with an Action Log row, and records it as the agent's. */
  async reply(repo: RepoRow, number: number, sessionId: string, rootId: string, body: string): Promise<string> {
    const slug = repo.remoteSlug as string;
    const row = this.actionLog.start({
      sessionId,
      kind: ActionKind.Pr,
      target: `${slug}#${number}`,
      command: `reply in thread ${rootId}`,
      isProd: false,
    });
    try {
      const posted = await this.adapter(repo).postComment(slug, number, { body, head_sha: '', parent_id: rootId });
      this.store.write((tx, emit) => {
        tx.insert(agentComments)
          .values({ repoId: repo.id, prNumber: number, commentId: posted.id, agentReviewId: null })
          .run();
        emit('pull_request.commented', { repo_id: repo.id, number, comment_id: posted.id, by_agent: true });
      });
      this.actionLog.finish(row, ActionOutcome.Ok);
      return posted.id;
    } catch (error) {
      this.actionLog.finish(row, ActionOutcome.Failed, error instanceof Error ? error.message : 'post failed');
      throw error;
    }
  }

  /** Pushes the scratch copy's commit to the pull request's branch, with an Action Log row first. */
  async push(repo: RepoRow, number: number, sessionId: string, dir: string, branch: string): Promise<void> {
    const row = this.actionLog.start({
      sessionId,
      kind: ActionKind.Git,
      target: `${repo.remoteSlug}#${number}`,
      command: `git push origin HEAD:refs/heads/${branch}`,
      isProd: false,
    });
    try {
      await this.git.pushHead(dir, branch);
      this.actionLog.finish(row, ActionOutcome.Ok);
    } catch (error) {
      this.actionLog.finish(row, ActionOutcome.Failed, error instanceof Error ? error.message : 'push failed');
      throw error;
    }
  }

  /** Resolves a thread, with an Action Log row. */
  async resolve(repo: RepoRow, number: number, sessionId: string, rootId: string): Promise<void> {
    const slug = repo.remoteSlug as string;
    const row = this.actionLog.start({
      sessionId,
      kind: ActionKind.Pr,
      target: `${slug}#${number}`,
      command: `resolve thread ${rootId}`,
      isProd: false,
    });
    try {
      await this.adapter(repo).setResolved(slug, number, rootId, true);
      this.actionLog.finish(row, ActionOutcome.Ok);
    } catch (error) {
      this.actionLog.finish(row, ActionOutcome.Failed, error instanceof Error ? error.message : 'resolve failed');
      throw error;
    }
  }

  /** Comment ids the agent wrote on this pull request. */
  agentCommentIds(repoId: string, number: number): Set<string> {
    return new Set(
      this.store.db
        .select({ id: agentComments.commentId })
        .from(agentComments)
        .where(and(eq(agentComments.repoId, repoId), eq(agentComments.prNumber, number)))
        .all()
        .map((row) => row.id),
    );
  }

  /**
   * Start-up: a scratch copy stays only for a failed Reply check or Comment pass, so Retry can use it. Every other
   * folder under `pr-scratch` goes.
   */
  private async sweepScratch(): Promise<void> {
    const kept = new Set<string>();
    for (const table of [prReplyChecks, prCommentPasses] as const) {
      const rows = this.store.db
        .select({ id: table.id, path: table.scratchPath, status: table.status })
        .from(table)
        .where(isNotNull(table.scratchPath))
        .all();
      for (const row of rows) {
        if (row.status === AgentReviewStatus.Failed) {
          kept.add(row.path as string);
          continue;
        }
        await this.dropScratch(row.path);
        this.store.write((tx) => tx.update(table).set({ scratchPath: null }).where(eq(table.id, row.id)).run());
      }
    }
    const folder = path.join(this.dataDir, 'pr-scratch');
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names) {
      const dir = path.join(folder, name);
      if (!kept.has(dir)) await this.dropScratch(dir);
    }
  }

  /**
   * Removes the scratch copies of these jobs, which then cannot retry: earlier failed jobs a new one replaces
   * (Behavior 25), or a job that failed for good. Never a running job's: the caller checked the pull request is idle.
   */
  async release(table: typeof prReplyChecks | typeof prCommentPasses, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = this.store.db
      .select({ id: table.id, path: table.scratchPath })
      .from(table)
      .where(and(inArray(table.id, ids), isNotNull(table.scratchPath)))
      .all();
    for (const row of rows) {
      await this.dropScratch(row.path);
      this.store.write((tx) =>
        tx.update(table).set({ scratchPath: null, canRetry: false }).where(eq(table.id, row.id)).run(),
      );
    }
  }

  private adapter(repo: RepoRow) {
    return this.hosts.for(repo.host);
  }
}
