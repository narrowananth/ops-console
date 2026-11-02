import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AgentReviewStatus,
  type CommentPass,
  ErrorCode,
  PlaybookTrigger,
  PrState,
  ThreadOutcome,
} from '@ops-console/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { STOPPED } from '../agent/runs';
import { AgentRuntime, HOST_WRITE_DENIALS } from '../agent/runtime';
import { parseAgentJson } from '../common/agent-json';
import { ApiError, validationFailed } from '../common/errors';
import { prCommentPasses } from '../db/schema';
import { type Emit, STORE, type Store } from '../db/store';
import { JobSteps, jobPlaybook } from '../playbooks/job-steps';
import { PlaybooksService } from '../playbooks/playbooks.service';
import { BranchMoved, GIT, Git, GitFailed } from '../repos/git';
import type { HostComment, HostPullRequest } from './git-host';
import {
  fileLine,
  JobFailed,
  PrJobs,
  type StoredThread,
  storedThreads,
  threadOf,
  threadText,
  toCommentPass,
} from './pr-jobs';
import { PullRequestsService } from './pull-requests.service';

type Row = typeof prCommentPasses.$inferSelect;

const outcomesSchema = z.object({
  threads: z.array(
    z.object({
      comment_id: z.string(),
      outcome: z.enum([ThreadOutcome.Done, ThreadOutcome.Declined]),
      reply: z.string().trim().min(1),
    }),
  ),
});

const MOVED = 'The branch moved; run Address comments again.';

/** What the agent is told about the pull request and the ticked threads before its first step. */
export function commentPassBrief(slug: string, pr: HostPullRequest, threads: HostComment[][]): string {
  const listed = threads.map((thread) => {
    const root = thread[0] as HostComment;
    return `[comment_id ${root.id}] on ${fileLine(root)}:\n${threadText(thread)}`;
  });
  return `Address review comments on the operator's pull request #${pr.number} of ${slug}: "${pr.title}", ${pr.branch} into ${pr.base_branch}, at head commit ${pr.head_sha}. This folder is a scratch copy at that commit: change code only here.

The operator ticked these threads. Each one is a change request, as the console safety rules say:

${listed.join('\n\n')}

Do not commit, push or post comments: the console commits, pushes and posts your replies. The console sends the work as steps, one per turn.`;
}

/** The console's closing turn: each ticked thread, done or declined, with its reply. */
export const COMMENT_PASS_PROMPT = `Report each thread the operator ticked. Answer with one JSON block and nothing after it:

\`\`\`json
{ "threads": [{ "comment_id": "id", "outcome": "done | declined", "reply": "done: what you changed. declined: why not" }] }
\`\`\`

List every ticked thread once.`;

/** The commit's message: the pull request, then a line per done thread (Behavior 16). */
export function commitMessage(number: number, threads: StoredThread[]): string {
  const done = threads.filter((thread) => thread.outcome === ThreadOutcome.Done);
  return [`Address review comments on #${number}`, '', ...done.map((thread) => `- ${thread.file_path}:${thread.line}`)]
    .join('\n')
    .trim();
}

/** Address comments: the agent changes code for the ticked threads; the console commits, pushes, replies, resolves. */
@Injectable()
export class CommentPassesService {
  private readonly logger = new Logger('comment-passes');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
    @Inject(PullRequestsService) private readonly pulls: PullRequestsService,
    @Inject(PrJobs) private readonly jobs: PrJobs,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(PlaybooksService) private readonly playbooks: PlaybooksService,
    @Inject(JobSteps) private readonly steps: JobSteps,
  ) {}

  async start(repoId: string, number: number, commentIds: string[]): Promise<CommentPass> {
    const repo = this.pulls.hosted(repoId);
    const slug = repo.remoteSlug as string;
    const { pr, comments } = await this.pulls.adapter(repo).get(slug, number);
    if (pr.state !== PrState.Open) throw new ApiError(409, ErrorCode.InvalidState, 'The pull request is not open');
    if (!this.pulls.mine(repo, pr)) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Address comments works only on your own pull requests');
    }
    const threads = commentIds.map((id) => threadOf(comments, id));
    for (const [index, thread] of threads.entries()) {
      const root = thread[0];
      if (
        !root ||
        root.id !== commentIds[index] ||
        root.parent_id !== null ||
        root.resolved ||
        !root.file_path ||
        !root.line
      ) {
        throw validationFailed(`invalid body: ${commentIds[index]} is not an unresolved thread on a line`);
      }
    }
    const session = this.jobs.requireIdle(repo, number);
    const earlier = this.store.db
      .select({ id: prCommentPasses.id })
      .from(prCommentPasses)
      .where(and(eq(prCommentPasses.repoId, repoId), eq(prCommentPasses.prNumber, number)))
      .all()
      .map((row) => row.id);
    const copy = this.playbooks.copyFor(PlaybookTrigger.AddressComments);
    const stored: StoredThread[] = threads.map((thread) => {
      const root = thread[0] as HostComment;
      return {
        comment_id: root.id,
        file_path: root.file_path as string,
        line: root.line as number,
        author: root.author,
        excerpt: root.body.split('\n')[0]?.slice(0, 200) ?? '',
        outcome: ThreadOutcome.Pending,
        reply: null,
        resolved: false,
        reply_comment_id: null,
      };
    });
    const row = this.store.write((tx, emit) => {
      const created = tx
        .insert(prCommentPasses)
        .values({
          id: crypto.randomUUID(),
          repoId,
          prNumber: number,
          headSha: pr.head_sha,
          branch: pr.branch,
          threads: JSON.stringify(stored),
          playbookId: copy.id,
          playbookName: copy.name,
          playbookRules: copy.rules,
        })
        .returning()
        .get();
      this.steps.seed(tx, { kind: 'comment_pass', id: created.id }, copy.steps);
      this.announce(emit, created);
      return created;
    });
    // The running row is in before anything awaits, so a second start meets it as busy.
    await this.jobs.release(prCommentPasses, earlier);
    this.run(row.id, session, commentPassBrief(slug, pr, threads), false);
    return this.view(row, pr.head_sha);
  }

  /** From the failed step, the push, or only the replies and resolves left undone (Behavior 21). */
  async retry(id: string, skip = false): Promise<CommentPass> {
    const row = this.row(id);
    if (row.status !== AgentReviewStatus.Failed || !row.canRetry) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Only a failed Comment pass that can retry can run again');
    }
    const repo = this.pulls.hosted(row.repoId);
    const slug = repo.remoteSlug as string;
    const { pr, comments } = await this.pulls.adapter(repo).get(slug, row.prNumber);
    const session = this.jobs.requireIdle(repo, row.prNumber);
    const threads = storedThreads(row).map((thread) => threadOf(comments, thread.comment_id));
    const updated = this.store.write((tx, emit) => {
      if (skip) this.steps.skip(tx, emit, { kind: 'comment_pass', id });
      this.steps.reset(tx, emit, { kind: 'comment_pass', id });
      const next = tx
        .update(prCommentPasses)
        .set({ status: AgentReviewStatus.Running, error: null })
        .where(eq(prCommentPasses.id, id))
        .returning()
        .get() as Row;
      this.announce(emit, next);
      return next;
    });
    this.run(id, session, commentPassBrief(slug, { ...pr, head_sha: row.headSha }, threads), true);
    return this.view(updated, pr.head_sha);
  }

  private run(id: string, session: string, brief: string, retry: boolean): void {
    void this.execute(id, session, brief, retry).catch(async (error) => {
      const failed = error instanceof JobFailed ? error : null;
      if (!failed) this.logger.error(`comment pass ${id} failed: ${error instanceof Error ? error.message : error}`);
      const canRetry = failed?.canRetry ?? true;
      // A copy no Retry can use goes before the job reads as failed (Behavior 19).
      if (!canRetry) await this.jobs.release(prCommentPasses, [id]);
      this.fail(id, failed?.message ?? 'The Comment pass stopped', canRetry);
    });
  }

  private async execute(id: string, session: string, brief: string, retry: boolean): Promise<void> {
    let row = this.row(id);
    const repo = this.pulls.repoRow(row.repoId);
    if (!retry) {
      const dir = await this.jobs.makeScratch(repo, row.branch, row.headSha, id);
      row = this.update(id, { scratchPath: dir });
    }
    if (row.stage === 'steps') row = await this.work(row, session, brief);
    if (row.stage === 'push') row = await this.push(row, session);
    await this.post(row, session);
  }

  /** The steps, then the closing turn's outcome for each thread. */
  private async work(row: Row, session: string, brief: string): Promise<Row> {
    const cwd = row.scratchPath ?? undefined;
    const rules = row.playbookRules;
    const failure = await this.steps.run({
      job: { kind: 'comment_pass', id: row.id },
      sessionId: session,
      brief,
      rules,
      cwd,
      deny: HOST_WRITE_DENIALS,
    });
    if (failure) throw new JobFailed(failure, true);
    const closing = { rules, cwd, deny: HOST_WRITE_DENIALS };
    const summary = await this.runtime.runFor(session, COMMENT_PASS_PROMPT, null, closing).finished;
    if (summary.stopped) throw new JobFailed(`The threads were not reported: ${STOPPED}`, true);
    const answer = summary.ok ? parseAgentJson(summary.text, outcomesSchema) : null;
    const threads = storedThreads(row);
    const byId = new Map(answer?.threads.map((thread) => [thread.comment_id, thread]));
    if (!answer || threads.some((thread) => !byId.has(thread.comment_id))) {
      throw new JobFailed('The agent did not report every thread in a way the console could read', true);
    }
    const reported = threads.map((thread) => {
      const answered = byId.get(thread.comment_id) as z.infer<typeof outcomesSchema>['threads'][number];
      return { ...thread, outcome: answered.outcome, reply: answered.reply };
    });
    return this.update(row.id, { threads: JSON.stringify(reported), stage: 'push' });
  }

  /** One commit of every change, pushed to the branch without force; nothing when no thread is done (Behavior 18). */
  private async push(row: Row, session: string): Promise<Row> {
    const threads = storedThreads(row);
    const dir = row.scratchPath as string;
    if (!threads.some((thread) => thread.outcome === ThreadOutcome.Done)) {
      return this.update(row.id, { stage: 'post' });
    }
    try {
      // A retry after a failed push finds its commit already made, so the scratch copy's head is read back.
      const commit =
        (await this.git.commitAll(dir, commitMessage(row.prNumber, threads))) ?? (await this.git.head(dir));
      if (!commit || commit === row.headSha) return this.update(row.id, { stage: 'post' });
      await this.jobs.push(this.pulls.repoRow(row.repoId), row.prNumber, session, dir, row.branch);
      return this.update(row.id, { stage: 'post', commitSha: commit });
    } catch (error) {
      if (error instanceof BranchMoved) throw new JobFailed(MOVED, false);
      const message = error instanceof GitFailed && error.message ? error.message : 'git failed';
      throw new JobFailed(`Could not push: ${message}`, true);
    }
  }

  /** A reply in each thread, then a resolve for each done one; a retry does only what is left (Behavior 21). */
  private async post(row: Row, session: string): Promise<void> {
    const repo = this.pulls.repoRow(row.repoId);
    const threads = storedThreads(row);
    const short = row.commitSha?.slice(0, 7) ?? null;
    let misses: { count: number; first: string } | null = null;
    const miss = (error: unknown) => {
      const message = error instanceof Error ? error.message : 'the host refused';
      misses = { count: (misses?.count ?? 0) + 1, first: misses?.first ?? message };
    };
    for (const thread of threads) {
      if (thread.reply_comment_id === null) {
        const done = thread.outcome === ThreadOutcome.Done;
        const body = done && short ? `Done in ${short}. ${thread.reply}` : (thread.reply as string);
        try {
          thread.reply_comment_id = await this.jobs.reply(repo, row.prNumber, session, thread.comment_id, body);
        } catch (error) {
          miss(error);
          continue;
        }
      }
      if (thread.outcome === ThreadOutcome.Done && !thread.resolved) {
        try {
          await this.jobs.resolve(repo, row.prNumber, session, thread.comment_id);
          thread.resolved = true;
        } catch (error) {
          miss(error);
        }
      }
    }
    this.update(row.id, { threads: JSON.stringify(threads) });
    this.pulls.drop(row.repoId);
    const missed = misses as { count: number; first: string } | null;
    if (missed) {
      throw new JobFailed(
        `Could not post or resolve ${missed.count} thread${missed.count === 1 ? '' : 's'}: ${missed.first}`,
        true,
      );
    }
    // A ready job needs no scratch copy; it goes before the status says so.
    await this.jobs.dropScratch(row.scratchPath);
    this.store.write((tx, emit) => {
      const done = tx
        .update(prCommentPasses)
        .set({ status: AgentReviewStatus.Ready, scratchPath: null, error: null })
        .where(eq(prCommentPasses.id, row.id))
        .returning()
        .get() as Row;
      this.announce(emit, done);
    });
  }

  private fail(id: string, error: string, canRetry: boolean): void {
    this.store.write((tx, emit) => {
      const row = tx
        .update(prCommentPasses)
        .set({ status: AgentReviewStatus.Failed, error, canRetry })
        .where(eq(prCommentPasses.id, id))
        .returning()
        .get();
      if (row) this.announce(emit, row);
    });
  }

  view(row: Row, headSha: string | null): CommentPass {
    return toCommentPass(row, headSha, jobPlaybook(this.store.db, 'comment_pass', row));
  }

  private row(id: string): Row {
    const row = this.store.db.select().from(prCommentPasses).where(eq(prCommentPasses.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Comment pass');
    return row;
  }

  private update(id: string, values: Partial<typeof prCommentPasses.$inferInsert>): Row {
    return this.store.write((tx, emit) => {
      const row = tx.update(prCommentPasses).set(values).where(eq(prCommentPasses.id, id)).returning().get() as Row;
      this.announce(emit, row);
      return row;
    });
  }

  private announce(emit: Emit, row: Row): void {
    emit('pull_request.job_changed', {
      repo_id: row.repoId,
      number: row.prNumber,
      kind: 'comment_pass',
      id: row.id,
      status: row.status,
    });
  }
}
