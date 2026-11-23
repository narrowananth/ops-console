import { Inject, Injectable } from '@nestjs/common';
import { ActionKind, ActionOutcome } from '@ops-console/shared';
import { and, eq } from 'drizzle-orm';
import { ActionLogService } from '../action-log/action-log.service';
import { agentComments, type repos } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GIT, Git } from '../repos/git';
import { GIT_HOSTS, type GitHosts, type HostComment } from './git-host';

type RepoRow = typeof repos.$inferSelect;

/** Replies, resolves and finding posts a PR action Session sends to the Git host at once. */
export const POST_PARALLEL = 3;

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
 * What a PR action Session's tool call writes to the Git host on the agent's behalf: replies, resolves and the push.
 * Each is an Action Log row, made before it runs.
 */
@Injectable()
export class PrHostWrites {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
    @Inject(GIT_HOSTS) private readonly hosts: GitHosts,
  ) {}

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
      const posted = await this.hosts
        .for(repo.host)
        .postComment(slug, number, { body, head_sha: '', parent_id: rootId });
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

  /** Commits every change in the worktree as the operator, with an Action Log row first; null when nothing changed. */
  async commit(repo: RepoRow, number: number, sessionId: string, dir: string, message: string): Promise<string | null> {
    const row = this.actionLog.start({
      sessionId,
      kind: ActionKind.Git,
      target: `${repo.remoteSlug}#${number}`,
      command: `git commit -m ${JSON.stringify(message.split('\n')[0])}`,
      isProd: false,
    });
    try {
      const commit = await this.git.commitAll(dir, message);
      this.actionLog.finish(row, ActionOutcome.Ok);
      return commit;
    } catch (error) {
      this.actionLog.finish(row, ActionOutcome.Failed, error instanceof Error ? error.message : 'commit failed');
      throw error;
    }
  }

  /**
   * Pushes the worktree's commit to the pull request's branch, with an Action Log row first. A branch that moved
   * meanwhile is caught up with by rebasing the commit onto it.
   */
  async push(repo: RepoRow, number: number, sessionId: string, dir: string, branch: string): Promise<void> {
    const row = this.actionLog.start({
      sessionId,
      kind: ActionKind.Git,
      target: `${repo.remoteSlug}#${number}`,
      command: `git push origin HEAD:refs/heads/${branch}`,
      isProd: false,
    });
    try {
      await this.git.pushHeadRebasing(dir, branch);
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
      await this.hosts.for(repo.host).setResolved(slug, number, rootId, true);
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
}
