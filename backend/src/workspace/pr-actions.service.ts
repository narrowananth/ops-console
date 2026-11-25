import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ErrorCode,
  PlaybookTrigger,
  PrAction,
  PrActionState,
  PrState,
  ReplyVerdict,
  type Session,
  SessionKind,
  type StartPrAction,
  ThreadOutcome,
} from '@ops-console/shared';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  PR_ACTION_TOOLS,
  type PrActionTools,
  type ReviewOutput,
  submitReplyVerdictsInputSchema,
  submitReviewInputSchema,
  submitThreadResultsInputSchema,
} from '../agent/pull-request-tool';
import { AgentRuntime } from '../agent/runtime';
import { type SessionRow, SessionsService, toSession, turnRunning } from '../agent/sessions.service';
import { DATA_DIR } from '../common/data-dir';
import { ApiError, validationFailed } from '../common/errors';
import { mapLimit } from '../common/map-limit';
import { StartupRecovery } from '../common/recovery';
import { sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { PlaybooksService } from '../playbooks/playbooks.service';
import { BranchMoved, GIT, Git, GitFailed, RebaseConflict } from '../repos/git';
import { AgentReviewsService, REVIEW_GUIDE, type ReviewStart, reviewBrief } from './agent-reviews.service';
import type { HostComment } from './git-host';
import { addressBrief, checkBrief, openingPrompt, prSessionTitle, ROUND_NAME } from './pr-action-prompt';
import { fileLine, POST_PARALLEL, PrHostWrites, threadOf } from './pr-host-writes';
import { PullRequestsService } from './pull-requests.service';
import { WorkspaceSessionsService } from './workspace-sessions.service';

const TRIGGER: Record<PrAction, PlaybookTrigger> = {
  [PrAction.AddressComments]: PlaybookTrigger.AddressComments,
  [PrAction.CheckReplies]: PlaybookTrigger.CheckReply,
  [PrAction.Review]: PlaybookTrigger.ReviewPr,
};

/** A thread as the Session keeps it: what the tool call said and what is posted for it. */
const storedThreadSchema = z.object({
  comment_id: z.string(),
  file_path: z.string().nullable(),
  line: z.number().int().nullable(),
  author: z.string(),
  excerpt: z.string(),
  outcome: z.enum(ThreadOutcome),
  reply: z.string().nullable(),
  reply_comment_id: z.string().nullable(),
  resolved: z.boolean(),
});

type StoredThread = z.infer<typeof storedThreadSchema>;

const storedThreads = (row: SessionRow): StoredThread[] =>
  z.array(storedThreadSchema).parse(JSON.parse(row.prActionThreads ?? '[]'));

const reviewStartSchema = z.object({
  note: z.string().nullable(),
  base_branch: z.string().nullable(),
  base_sha: z.string().nullable(),
});

const VERDICT_OUTCOME: Record<ReplyVerdict, ThreadOutcome> = {
  [ReplyVerdict.Fixed]: ThreadOutcome.Fixed,
  [ReplyVerdict.PartlyFixed]: ThreadOutcome.PartlyFixed,
  [ReplyVerdict.NotFixed]: ThreadOutcome.NotFixed,
};

const MOVED = 'The branch moved and the rebase conflicts with the new commits.';

/** The commit's message: the pull request, then a line per done thread. */
export function commitMessage(number: number, threads: StoredThread[]): string {
  const lines = threads
    .filter((thread) => thread.outcome === ThreadOutcome.Done)
    .map((thread) => (thread.file_path ? `- ${fileLine(thread)}` : `- ${thread.author}'s comment on the pull request`));
  return [`Address review comments on #${number}`, '', ...lines].join('\n').trim();
}

/**
 * The three buttons on a pull request: Address comments, Check replies and Review with agent. A pull request has one
 * PR Session, a `repo` Session in a detached worktree at the head commit. Each press starts a Round in it, which ends
 * in one console tool call that the console turns into the commit, push, replies, resolves and review comments, as the
 * operator.
 */
@Injectable()
export class PrActionsService implements PrActionTools {
  private readonly logger = new Logger('pr-actions');
  /** Presses being handled, by pull request, so two presses make the one Session once. */
  private readonly starting = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(GIT) private readonly git: Git,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(PullRequestsService) private readonly pulls: PullRequestsService,
    @Inject(WorkspaceSessionsService) private readonly workspace: WorkspaceSessionsService,
    @Inject(PlaybooksService) private readonly playbooks: PlaybooksService,
    @Inject(PrHostWrites) private readonly writes: PrHostWrites,
    @Inject(AgentReviewsService) private readonly reviews: AgentReviewsService,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    runtime.setPrActionTools(this);
    recovery.register('pull request scratch copies', () => this.sweepScratch());
  }

  /** Start-up: the folders left under `pr-scratch` go, removed in the background so a big copy never delays the port. */
  private async sweepScratch(): Promise<void> {
    const folder = path.join(this.dataDir, 'pr-scratch');
    const names = await readdir(folder).catch(() => [] as string[]);
    void (async () => {
      for (const name of names) {
        await this.git
          .removeWorktree(path.join(folder, name))
          .catch((error) =>
            this.logger.warn(`scratch copy not removed: ${error instanceof Error ? error.message : error}`),
          );
      }
    })();
  }

  async start(repoId: string, number: number, input: StartPrAction): Promise<Session> {
    const { action } = input;
    if (action === PrAction.AddressComments ? !input.comment_ids?.length : input.comment_ids?.length === 0) {
      throw validationFailed('invalid body: comment_ids needs at least one thread');
    }
    if (action === PrAction.Review && input.comment_ids !== undefined) {
      throw validationFailed('invalid body: comment_ids is for Address comments and Check replies');
    }
    if (action !== PrAction.Review && input.note !== undefined) {
      throw validationFailed('invalid body: note is for Review with agent only');
    }
    return this.locked(`${repoId}#${number}`, () => this.round(repoId, number, input));
  }

  /** Presses on one pull request go one after another: the second finds the Session the first made. */
  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const turn = (this.starting.get(key) ?? Promise.resolve()).then(work);
    const tail = turn.catch(() => undefined);
    this.starting.set(key, tail);
    try {
      return await turn;
    } finally {
      if (this.starting.get(key) === tail) this.starting.delete(key);
    }
  }

  /** Starts a Round in the pull request's PR Session, which the first Round makes. */
  private async round(repoId: string, number: number, input: StartPrAction): Promise<Session> {
    const { action } = input;
    const repo = this.pulls.hosted(repoId);
    const slug = repo.remoteSlug as string;
    const { pr, files, comments } = await this.pulls.recent(repo, number);
    if (pr.state !== PrState.Open) throw new ApiError(409, ErrorCode.InvalidState, 'The pull request is not open');
    const existing = this.prSession(repoId, number);
    if (existing && turnRunning(existing.state)) {
      throw new ApiError(409, ErrorCode.SessionBusy, 'The Session is working on this pull request');
    }
    const agents = this.writes.agentCommentIds(repoId, number);
    let threads: HostComment[][] = [];
    if (action === PrAction.AddressComments) {
      const ids = [...new Set(input.comment_ids)];
      threads = ids.map((id) => threadOf(comments, id));
      for (const [index, thread] of threads.entries()) {
        const root = thread[0];
        if (!root) throw new ApiError(404, ErrorCode.NotFound, `no comment ${ids[index]} on this pull request`);
        if (root.id !== ids[index] || root.parent_id !== null || root.resolved) {
          throw validationFailed(`invalid body: ${ids[index]} is not an unresolved thread`);
        }
      }
    } else if (action === PrAction.CheckReplies) {
      const replied = comments
        .filter((comment) => comment.parent_id === null && !comment.resolved)
        .map((root) => threadOf(comments, root.id))
        .filter((thread) => thread.length > 1 && !agents.has((thread.at(-1) as HostComment).id));
      if (input.comment_ids === undefined) {
        threads = replied;
        if (threads.length === 0)
          throw new ApiError(409, ErrorCode.InvalidState, 'No open thread has a reply to check');
      } else {
        for (const id of new Set(input.comment_ids)) {
          if (!comments.some((comment) => comment.id === id)) {
            throw new ApiError(404, ErrorCode.NotFound, `no comment ${id} on this pull request`);
          }
          const thread = replied.find((candidate) => candidate[0]?.id === id);
          if (!thread) throw validationFailed(`invalid body: ${id} is not an open thread with a reply to check`);
          threads.push(thread);
        }
      }
    } else if (this.reviews.reviewed(repoId, number, pr.head_sha)) {
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        'The agent already reviewed this commit; push a change to review again',
      );
    }
    // The head commit must be in the Repo before a worktree can move or start there.
    try {
      await this.git.fetchBranch(repo.path, pr.branch);
    } catch (error) {
      const why = error instanceof GitFailed && error.message ? error.message : 'git failed';
      throw new ApiError(502, ErrorCode.UpstreamFailed, `Could not fetch the branch from origin: ${why}`);
    }
    const copy = this.playbooks.copyFor(TRIGGER[action]);
    let brief: string;
    let kept: string | null;
    if (action === PrAction.Review) {
      const start = await this.reviewStart(repo.path, pr.base_branch, input.note);
      kept = JSON.stringify(start);
      brief = reviewBrief(slug, pr, files, comments, agents, await this.place(repo.path, pr, start), start.note);
    } else {
      kept = JSON.stringify(threads.map((thread) => this.pending(thread[0] as HostComment)));
      brief = (action === PrAction.AddressComments ? addressBrief : checkBrief)(slug, pr, threads);
    }
    let moved = false;
    if (existing) {
      try {
        moved = await this.workspace.moveToCommit(existing, pr.head_sha);
      } catch (error) {
        const why = error instanceof ApiError ? error.message : 'git failed';
        throw new ApiError(502, ErrorCode.UpstreamFailed, `Could not move the worktree to the head commit: ${why}`);
      }
    }
    const row = existing ?? this.open(repoId, number, action, pr.head_sha, kept);
    if (!moved) {
      try {
        // A Session whose worktree is gone gets one at the new head commit; its Round is not replaced yet.
        await this.workspace.ensure({ ...row, prActionHeadSha: pr.head_sha }, false);
      } catch (error) {
        if (!existing) this.sessions.remove(row.id);
        const why = error instanceof ApiError ? error.message : 'git failed';
        throw new ApiError(502, ErrorCode.UpstreamFailed, `Could not make a worktree at the head commit: ${why}`);
      }
    }
    const current = existing ? this.nextRound(existing.id, action, pr.head_sha, kept) : row;
    this.sessions.update(row.id, { title: prSessionTitle(number) });
    this.announce(current, PrActionState.Working);
    this.runtime.send(
      row.id,
      openingPrompt(action, brief, copy, action === PrAction.Review ? REVIEW_GUIDE : '', existing !== undefined),
    );
    return toSession(this.sessions.get(row.id), []);
  }

  /** The pull request's PR Session: its newest Session opened by a button. */
  private prSession(repoId: string, number: number): SessionRow | undefined {
    return this.store.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.repoId, repoId), eq(sessions.prNumber, number), isNotNull(sessions.prAction)))
      .orderBy(desc(sessions.createdAt), desc(sessions.id))
      .get();
  }

  /** The press replaces the PR Session's Round: the last one's threads, commit and submit go. */
  private nextRound(id: string, action: PrAction, headSha: string, threads: string | null): SessionRow {
    this.keep(id, {
      prAction: action,
      prActionHeadSha: headSha,
      prActionThreads: threads,
      prActionCommitSha: null,
      prActionSubmittedAt: null,
    });
    return this.sessions.get(id);
  }

  private open(repoId: string, number: number, action: PrAction, headSha: string, threads: string | null): SessionRow {
    return this.sessions.create({
      kind: SessionKind.Repo,
      repoId,
      prNumber: number,
      prAction: { action, headSha, threads },
    });
  }

  private pending(root: HostComment): StoredThread {
    return {
      comment_id: root.id,
      file_path: root.file_path,
      line: root.line,
      author: root.author,
      excerpt: root.body.split('\n')[0]?.slice(0, 200) ?? '',
      outcome: ThreadOutcome.Pending,
      reply: null,
      reply_comment_id: null,
      resolved: false,
    };
  }

  /** The target branch's commit at the start, and the operator's note, for the review the Session submits. */
  private async reviewStart(dir: string, baseBranch: string, note: string | undefined): Promise<ReviewStart> {
    const sha = await this.git.remoteHead(dir, baseBranch).catch(() => null);
    return { note: note || null, base_branch: sha ? baseBranch : null, base_sha: sha };
  }

  private async place(dir: string, pr: { base_branch: string }, start: ReviewStart) {
    const production = await this.git.defaultBranch(dir).catch(() => null);
    const productionSha =
      production && production !== pr.base_branch ? await this.git.remoteHead(dir, production).catch(() => null) : null;
    return {
      base: start.base_branch && start.base_sha ? { branch: start.base_branch, sha: start.base_sha } : null,
      production: production && productionSha ? { branch: production, sha: productionSha } : null,
    };
  }

  /** The tool call that ends a Round of `action`; throws an `ApiError` the agent reads. */
  async submit(sessionId: string, action: PrAction, input: unknown): Promise<string> {
    const row = this.sessions.get(sessionId);
    if (row.prAction === null) throw new ApiError(409, ErrorCode.InvalidState, 'This Session has nothing to submit');
    if (row.prAction !== action) {
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        `Nothing was posted. This Round is ${ROUND_NAME[row.prAction]}: call ${PR_ACTION_TOOLS[row.prAction]}.`,
      );
    }
    if (row.prActionSubmittedAt !== null) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Already submitted: this Round posted its results.');
    }
    switch (row.prAction) {
      case PrAction.AddressComments:
        return this.submitThreads(row, submitThreadResultsInputSchema.parse(input).threads);
      case PrAction.CheckReplies:
        return this.submitThreads(
          row,
          submitReplyVerdictsInputSchema.parse(input).threads.map(({ comment_id, verdict, reply }) => ({
            comment_id,
            outcome: VERDICT_OUTCOME[verdict],
            reply,
          })),
        );
      case PrAction.Review:
        return this.submitReview(row, submitReviewInputSchema.parse(input));
    }
  }

  /** Address comments and Check replies: commit and push (Address only), then a reply in each thread and a resolve for each settled one. */
  private async submitThreads(
    row: SessionRow,
    given: { comment_id: string; outcome: ThreadOutcome; reply: string }[],
  ): Promise<string> {
    const check = row.prAction === PrAction.CheckReplies;
    const threads = storedThreads(row);
    const ids = new Set(threads.map((thread) => thread.comment_id));
    const byId = new Map(given.map((thread) => [thread.comment_id, thread]));
    const missing = [...ids].filter((id) => !byId.has(id));
    const extra = [...byId.keys()].filter((id) => !ids.has(id));
    if (missing.length > 0 || extra.length > 0 || byId.size !== given.length) {
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        `Nothing was posted. Give every thread exactly once. ${missing.length > 0 ? `Missing: ${missing.join(', ')}. ` : ''}${extra.length > 0 ? `Not ticked: ${extra.join(', ')}.` : ''}`.trim(),
      );
    }
    for (const thread of threads) {
      const answer = byId.get(thread.comment_id);
      if (thread.reply_comment_id === null && answer) {
        thread.outcome = answer.outcome;
        thread.reply = answer.reply;
      }
    }
    const repo = this.pulls.repoRow(row.repoId as string);
    const number = row.prNumber as number;
    let commitSha = row.prActionCommitSha;
    this.keep(row.id, { prActionThreads: JSON.stringify(threads) });
    if (!check && commitSha === null && threads.some((thread) => thread.outcome === ThreadOutcome.Done)) {
      commitSha = await this.commitAndPush(row, repo, number, threads);
      if (commitSha !== null) this.keep(row.id, { prActionCommitSha: commitSha });
    }
    const short = commitSha?.slice(0, 7) ?? null;
    let misses: { count: number; first: string } | null = null;
    const miss = (error: unknown) => {
      const message = error instanceof Error ? error.message : 'the host refused';
      misses = { count: (misses?.count ?? 0) + 1, first: misses?.first ?? message };
    };
    // A few threads at a time: each reply and resolve is a host round trip. The threads keep their order.
    await mapLimit(threads, POST_PARALLEL, async (thread) => {
      if (thread.reply_comment_id === null) {
        const done = thread.outcome === ThreadOutcome.Done;
        const body = done && short ? `Done in ${short}. ${thread.reply}` : (thread.reply as string);
        try {
          thread.reply_comment_id = await this.writes.reply(repo, number, row.id, thread.comment_id, body);
        } catch (error) {
          miss(error);
          return;
        }
      }
      // A general comment has no thread to resolve on the hosts; its reply is the answer.
      const settled = this.settled(thread);
      if (settled && !thread.resolved && thread.file_path !== null) {
        try {
          await this.writes.resolve(repo, number, row.id, thread.comment_id);
          thread.resolved = true;
        } catch (error) {
          miss(error);
        }
      }
    });
    this.keep(row.id, { prActionThreads: JSON.stringify(threads) });
    this.pulls.wrote(repo.id, number);
    const missed = misses as { count: number; first: string } | null;
    if (missed) {
      const left = threads
        .filter(
          (thread) =>
            thread.reply_comment_id === null || (this.settled(thread) && !thread.resolved && thread.file_path !== null),
        )
        .map((thread) => thread.comment_id);
      throw new ApiError(
        409,
        ErrorCode.UpstreamFailed,
        `Could not post or resolve ${missed.count} thread${missed.count === 1 ? '' : 's'}: ${missed.first}. Still without a reply or a resolve: ${left.join(', ')}. Call again to post only those.`,
      );
    }
    this.submitted(row.id);
    const resolved = threads.filter((thread) => thread.resolved).length;
    return `Posted ${threads.length} repl${threads.length === 1 ? 'y' : 'ies'} and resolved ${resolved}.${short ? ` Pushed ${short} to the pull request's branch.` : ''}`;
  }

  private settled = (thread: StoredThread) =>
    thread.outcome === ThreadOutcome.Done ||
    thread.outcome === ThreadOutcome.AlreadyAddressed ||
    thread.outcome === ThreadOutcome.Fixed;

  /** One commit of every uncommitted change, pushed to the branch without force; null when there is nothing new. */
  private async commitAndPush(
    row: SessionRow,
    repo: ReturnType<PullRequestsService['repoRow']>,
    number: number,
    threads: StoredThread[],
  ): Promise<string | null> {
    const dir = this.workspace.worktreeDir(row.id);
    const { pr } = await this.pulls.adapter(repo).get(repo.remoteSlug as string, number);
    try {
      // A run wrote in this folder: the daemon's `git` runs here only while it is still the worktree the console made.
      await this.git.requireWorktree(dir, repo.path);
      const commit =
        (await this.writes.commit(repo, number, row.id, dir, commitMessage(number, threads))) ??
        (await this.git.head(dir));
      if (!commit || commit === row.prActionHeadSha) return null;
      await this.writes.push(repo, number, row.id, dir, pr.branch);
      // A branch that moved is caught up with by a rebase, which gives the commit a new sha.
      return (await this.git.head(dir)) ?? commit;
    } catch (error) {
      if (error instanceof RebaseConflict)
        throw new ApiError(409, ErrorCode.InvalidState, `Nothing was posted. ${MOVED}`);
      if (error instanceof BranchMoved) {
        throw new ApiError(
          409,
          ErrorCode.InvalidState,
          'Nothing was posted. The branch moved again while pushing: call again.',
        );
      }
      const message = error instanceof GitFailed && error.message ? error.message : 'git failed';
      throw new ApiError(502, ErrorCode.UpstreamFailed, `Nothing was posted. Could not push: ${message}`);
    }
  }

  private async submitReview(row: SessionRow, output: ReviewOutput): Promise<string> {
    const start = reviewStartSchema.parse(JSON.parse(row.prActionThreads ?? '{}'));
    const { posted, failed } = await this.reviews.submit(row, output, start);
    this.submitted(row.id);
    return `Posted ${posted} finding${posted === 1 ? '' : 's'} and the summary.${failed > 0 ? ` ${failed} finding${failed === 1 ? '' : 's'} could not be posted.` : ''}`;
  }

  private keep(id: string, values: Partial<typeof sessions.$inferInsert>): void {
    this.store.write((tx) => tx.update(sessions).set(values).where(eq(sessions.id, id)).run());
  }

  private submitted(id: string): void {
    const row = this.store.write((tx) =>
      tx
        .update(sessions)
        .set({ prActionSubmittedAt: new Date().toISOString() })
        .where(eq(sessions.id, id))
        .returning()
        .get(),
    );
    if (row) this.announce(row, PrActionState.Submitted);
  }

  private announce(row: SessionRow, state: PrActionState): void {
    this.store.write((_tx, emit) =>
      emit('pull_request.action_changed', {
        repo_id: row.repoId as string,
        number: row.prNumber as number,
        action: row.prAction as PrAction,
        session_id: row.id,
        state,
      }),
    );
  }
}
