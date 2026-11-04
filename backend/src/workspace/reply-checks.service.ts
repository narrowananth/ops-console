import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AgentReviewStatus,
  ErrorCode,
  PlaybookTrigger,
  PrState,
  type ReplyCheck,
  ReplyVerdict,
} from '@ops-console/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { STOPPED } from '../agent/runs';
import { AgentRuntime, HOST_WRITE_DENIALS } from '../agent/runtime';
import { parseAgentJson } from '../common/agent-json';
import { ApiError } from '../common/errors';
import { prReplyChecks } from '../db/schema';
import { type Emit, STORE, type Store } from '../db/store';
import { JobSteps, jobPlaybook } from '../playbooks/job-steps';
import { PlaybooksService } from '../playbooks/playbooks.service';
import type { HostComment, HostPullRequest } from './git-host';
import { fileLine, JobFailed, PrJobs, threadOf, threadText, toReplyCheck } from './pr-jobs';
import { PullRequestsService } from './pull-requests.service';

type Row = typeof prReplyChecks.$inferSelect;

const verdictSchema = z.object({ verdict: z.enum(ReplyVerdict), reply: z.string().trim().min(1) });

/** What the agent is told about the thread before its first step. */
export function replyCheckBrief(slug: string, pr: HostPullRequest, thread: HostComment[]): string {
  const root = thread[0] as HostComment;
  return `Check a review thread on pull request #${pr.number} of ${slug}: "${pr.title}" by ${pr.author}, ${pr.branch} into ${pr.base_branch}, at head commit ${pr.head_sha}. This folder is a scratch copy at that commit.

The thread, on ${fileLine(root)}:

${threadText(thread)}

Decide whether the code at the head commit does what the thread asked. Do not change anything and do not post comments: the console posts your reply. The console sends the check as steps, one per turn.`;
}

/** The console's closing turn: the verdict and the reply it posts. */
export const REPLY_CHECK_PROMPT = `Give your verdict on this thread. Answer with one JSON block and nothing after it:

\`\`\`json
{ "verdict": "fixed | partly_fixed | not_fixed", "reply": "a few sentences for the thread: what you checked, and what is left if anything" }
\`\`\``;

/** Check reply: the agent checks one thread against the head commit, and the console posts and resolves. */
@Injectable()
export class ReplyChecksService {
  private readonly logger = new Logger('reply-checks');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(PullRequestsService) private readonly pulls: PullRequestsService,
    @Inject(PrJobs) private readonly jobs: PrJobs,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(PlaybooksService) private readonly playbooks: PlaybooksService,
    @Inject(JobSteps) private readonly steps: JobSteps,
  ) {}

  async start(repoId: string, number: number, commentId: string): Promise<ReplyCheck> {
    const repo = this.pulls.hosted(repoId);
    const slug = repo.remoteSlug as string;
    const { pr, comments } = await this.pulls.adapter(repo).get(slug, number);
    if (pr.state !== PrState.Open) throw new ApiError(409, ErrorCode.InvalidState, 'The pull request is not open');
    const thread = threadOf(comments, commentId);
    const root = thread[0];
    if (!root || root.id !== commentId || root.parent_id !== null) {
      throw new ApiError(404, ErrorCode.NotFound, 'no such thread');
    }
    if (!root.file_path || !root.line) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Only a thread on a line can be checked');
    }
    if (root.resolved) throw new ApiError(409, ErrorCode.InvalidState, 'The thread is resolved');
    const last = thread.at(-1) as HostComment;
    if (this.jobs.agentCommentIds(repoId, number).has(last.id)) {
      throw new ApiError(409, ErrorCode.InvalidState, 'The last comment in the thread is the agent’s');
    }
    const session = this.jobs.requireIdle(repo, number);
    const earlier = this.store.db
      .select({ id: prReplyChecks.id })
      .from(prReplyChecks)
      .where(
        and(
          eq(prReplyChecks.repoId, repoId),
          eq(prReplyChecks.prNumber, number),
          eq(prReplyChecks.commentId, commentId),
        ),
      )
      .all()
      .map((row) => row.id);
    const copy = this.playbooks.copyFor(PlaybookTrigger.CheckReply);
    const row = this.store.write((tx, emit) => {
      const created = tx
        .insert(prReplyChecks)
        .values({
          id: crypto.randomUUID(),
          repoId,
          prNumber: number,
          commentId,
          headSha: pr.head_sha,
          playbookId: copy.id,
          playbookName: copy.name,
          playbookRules: copy.rules,
        })
        .returning()
        .get();
      this.steps.seed(tx, { kind: 'reply_check', id: created.id }, copy.steps);
      this.announce(emit, created);
      return created;
    });
    // The running row is in before anything awaits, so a second start meets it as busy.
    await this.jobs.release(prReplyChecks, earlier);
    this.run(row.id, session, replyCheckBrief(slug, pr, thread), pr.branch, false);
    return this.view(row);
  }

  /** From the failed step, or only the post or resolve left undone (Behavior 11). */
  async retry(id: string, skip = false): Promise<ReplyCheck> {
    const row = this.row(id);
    if (row.status !== AgentReviewStatus.Failed || !row.canRetry) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Only a failed Reply check that can retry can run again');
    }
    const repo = this.pulls.hosted(row.repoId);
    const slug = repo.remoteSlug as string;
    const { pr, comments } = await this.pulls.adapter(repo).get(slug, row.prNumber);
    const session = this.jobs.requireIdle(repo, row.prNumber);
    const updated = this.store.write((tx, emit) => {
      if (skip) this.steps.skip(tx, emit, { kind: 'reply_check', id });
      this.steps.reset(tx, emit, { kind: 'reply_check', id });
      const next = tx
        .update(prReplyChecks)
        .set({ status: AgentReviewStatus.Running, error: null, startedAt: new Date().toISOString(), finishedAt: null })
        .where(eq(prReplyChecks.id, id))
        .returning()
        .get() as Row;
      this.announce(emit, next);
      return next;
    });
    const brief = replyCheckBrief(slug, { ...pr, head_sha: row.headSha }, threadOf(comments, row.commentId));
    this.run(id, session, brief, pr.branch, true);
    return this.view(updated);
  }

  private run(id: string, session: string, brief: string, branch: string, retry: boolean): void {
    void this.execute(id, session, brief, branch, retry).catch(async (error) => {
      const failed = error instanceof JobFailed ? error : null;
      if (!failed) this.logger.error(`reply check ${id} failed: ${error instanceof Error ? error.message : error}`);
      const canRetry = failed?.canRetry ?? true;
      // A copy no Retry can use goes before the job reads as failed.
      if (!canRetry) await this.jobs.release(prReplyChecks, [id]);
      this.fail(id, failed?.message ?? 'The Reply check stopped', canRetry);
    });
  }

  private async execute(id: string, session: string, brief: string, branch: string, retry: boolean): Promise<void> {
    let row = this.row(id);
    const repo = this.pulls.repoRow(row.repoId);
    if (!retry) {
      const dir = await this.jobs.makeScratch(repo, branch, row.headSha, id);
      row = this.update(id, { scratchPath: dir });
    }
    const cwd = row.scratchPath ?? undefined;
    const rules = row.playbookRules;
    if (row.verdict === null) {
      const job = { kind: 'reply_check', id } as const;
      const failure = await this.steps.run({ job, sessionId: session, brief, rules, cwd, deny: HOST_WRITE_DENIALS });
      if (failure) throw new JobFailed(failure, true);
      const closing = { rules, cwd, deny: HOST_WRITE_DENIALS };
      const summary = await this.runtime.runFor(session, REPLY_CHECK_PROMPT, null, closing).finished;
      if (summary.stopped) throw new JobFailed(`The verdict was not given: ${STOPPED}`, true);
      if (summary.failure) throw new JobFailed(summary.failure, true);
      const answer = summary.ok ? parseAgentJson(summary.text, verdictSchema) : null;
      if (!answer) throw new JobFailed('The agent did not give a verdict the console could read', true);
      row = this.update(id, { verdict: answer.verdict, reply: answer.reply });
    }
    if (row.replyCommentId === null) {
      try {
        const posted = await this.jobs.reply(repo, row.prNumber, session, row.commentId, row.reply as string);
        row = this.update(id, { replyCommentId: posted });
      } catch (error) {
        throw new JobFailed(
          `Could not post the reply: ${error instanceof Error ? error.message : 'post failed'}`,
          true,
        );
      }
    }
    if (row.verdict === ReplyVerdict.Fixed && !row.resolved) {
      try {
        await this.jobs.resolve(repo, row.prNumber, session, row.commentId);
        row = this.update(id, { resolved: true });
      } catch (error) {
        throw new JobFailed(
          `Could not resolve the thread: ${error instanceof Error ? error.message : 'resolve failed'}`,
          true,
        );
      }
    }
    this.pulls.drop(row.repoId);
    // A ready job needs no scratch copy; it goes before the status says so.
    await this.jobs.dropScratch(row.scratchPath);
    this.store.write((tx, emit) => {
      const done = tx
        .update(prReplyChecks)
        .set({ status: AgentReviewStatus.Ready, scratchPath: null, error: null, finishedAt: new Date().toISOString() })
        .where(eq(prReplyChecks.id, id))
        .returning()
        .get() as Row;
      this.announce(emit, done);
    });
  }

  private fail(id: string, error: string, canRetry: boolean): void {
    this.store.write((tx, emit) => {
      const row = tx
        .update(prReplyChecks)
        .set({ status: AgentReviewStatus.Failed, error, canRetry, finishedAt: new Date().toISOString() })
        .where(eq(prReplyChecks.id, id))
        .returning()
        .get();
      if (row) this.announce(emit, row);
    });
  }

  view(row: Row): ReplyCheck {
    return toReplyCheck(row, jobPlaybook(this.store.db, 'reply_check', row));
  }

  private row(id: string): Row {
    const row = this.store.db.select().from(prReplyChecks).where(eq(prReplyChecks.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Reply check');
    return row;
  }

  private update(id: string, values: Partial<typeof prReplyChecks.$inferInsert>): Row {
    return this.store.write((tx, emit) => {
      const row = tx.update(prReplyChecks).set(values).where(eq(prReplyChecks.id, id)).returning().get() as Row;
      this.announce(emit, row);
      return row;
    });
  }

  private announce(emit: Emit, row: Row): void {
    emit('pull_request.job_changed', {
      repo_id: row.repoId,
      number: row.prNumber,
      kind: 'reply_check',
      id: row.id,
      status: row.status,
    });
  }
}
