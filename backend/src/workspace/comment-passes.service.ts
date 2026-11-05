import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AgentReviewStatus,
  type CommentPass,
  CommentPassKind,
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
import { parseSkillCopies, skillCopiesJson } from '../playbooks/skills.service';
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

const verdictsSchema = z.object({
  threads: z.array(
    z.object({
      comment_id: z.string(),
      verdict: z.enum([ThreadOutcome.Fixed, ThreadOutcome.PartlyFixed, ThreadOutcome.NotFixed]),
      reply: z.string().trim().min(1),
    }),
  ),
});

const MOVED = 'The branch moved; run Address comments again.';

/** What the agent is told before Check replies' first step: every replied thread, to check against the head commit. */
export function checkRepliesBrief(slug: string, pr: HostPullRequest, threads: HostComment[][]): string {
  const listed = threads.map((thread) => {
    const root = thread[0] as HostComment;
    return `[comment_id ${root.id}] on ${fileLine(root)}:\n${threadText(thread)}`;
  });
  return `Check the replies in review threads on pull request #${pr.number} of ${slug}: "${pr.title}" by ${pr.author}, ${pr.branch} into ${pr.base_branch}, at head commit ${pr.head_sha}. This folder is a scratch copy at that commit.

Each thread below has a reply after its comment. For each one, decide whether the code at the head commit does what the thread asked:

${listed.join('\n\n')}

Do not change anything and do not post comments: the console posts your replies. The console sends the check as steps, one per turn.`;
}

/** Check replies' closing turn: a verdict and a reply for every thread. */
export const CHECK_REPLIES_PROMPT = `Give your verdict on each thread. Answer with one JSON block and nothing after it:

\`\`\`json
{ "threads": [{ "comment_id": "id", "verdict": "fixed | partly_fixed | not_fixed", "reply": "a few sentences for the thread: what you checked, and what is left if anything" }] }
\`\`\`

List every thread once.`;

/** What the agent is told about the pull request and the ticked threads before its first step. */
export function commentPassBrief(slug: string, pr: HostPullRequest, threads: HostComment[][]): string {
  const listed = threads.map((thread) => {
    const root = thread[0] as HostComment;
    return `[comment_id ${root.id}] on ${fileLine(root)}:\n${threadText(thread)}`;
  });
  return `Address review comments on pull request #${pr.number} of ${slug}: "${pr.title}", ${pr.branch} into ${pr.base_branch}, at head commit ${pr.head_sha}. This folder is a scratch copy at that commit: change code only here.

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
  const lines = done.map((thread) =>
    thread.file_path ? `- ${fileLine(thread)}` : `- ${thread.author}'s comment on the pull request`,
  );
  return [`Address review comments on #${number}`, '', ...lines].join('\n').trim();
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
    const threads = commentIds.map((id) => threadOf(comments, id));
    for (const [index, thread] of threads.entries()) {
      const root = thread[0];
      if (!root || root.id !== commentIds[index] || root.parent_id !== null || root.resolved) {
        throw validationFailed(`invalid body: ${commentIds[index]} is not an unresolved thread`);
      }
    }
    const session = this.jobs.requireIdle(repo, number);
    const earlier = this.earlier(repoId, number);
    const copy = this.playbooks.copyFor(PlaybookTrigger.AddressComments);
    const row = this.insert(repoId, pr, CommentPassKind.Address, threads, copy);
    // The running row is in before anything awaits, so a second start meets it as busy.
    await this.jobs.release(prCommentPasses, earlier);
    this.run(row.id, session, commentPassBrief(slug, pr, threads), false);
    return this.view(row, pr.head_sha);
  }

  private earlier(repoId: string, number: number): string[] {
    return this.store.db
      .select({ id: prCommentPasses.id })
      .from(prCommentPasses)
      .where(and(eq(prCommentPasses.repoId, repoId), eq(prCommentPasses.prNumber, number)))
      .all()
      .map((row) => row.id);
  }

  /** The running row and its steps, in before anything awaits, so a second start meets it as busy. */
  private insert(
    repoId: string,
    pr: HostPullRequest,
    kind: CommentPassKind,
    threads: HostComment[][],
    copy: ReturnType<PlaybooksService['copyFor']>,
  ): Row {
    const stored: StoredThread[] = threads.map((thread) => {
      const root = thread[0] as HostComment;
      return {
        comment_id: root.id,
        file_path: root.file_path,
        line: root.line,
        author: root.author,
        excerpt: root.body.split('\n')[0]?.slice(0, 200) ?? '',
        outcome: ThreadOutcome.Pending,
        reply: null,
        resolved: false,
        reply_comment_id: null,
      };
    });
    return this.store.write((tx, emit) => {
      const created = tx
        .insert(prCommentPasses)
        .values({
          id: crypto.randomUUID(),
          repoId,
          prNumber: pr.number,
          headSha: pr.head_sha,
          branch: pr.branch,
          kind,
          threads: JSON.stringify(stored),
          playbookId: copy.id,
          playbookName: copy.name,
          playbookRules: copy.rules,
          playbookSkills: skillCopiesJson(copy.skills),
        })
        .returning()
        .get();
      this.steps.seed(tx, { kind: 'comment_pass', id: created.id }, copy.steps);
      this.announce(emit, created);
      return created;
    });
  }

  /**
   * Check replies: one pass over every unresolved thread with a reply whose last comment is not the agent's. The
   * agent gives each a verdict; the console replies in each and resolves the fixed ones.
   */
  async startCheck(repoId: string, number: number): Promise<CommentPass> {
    const repo = this.pulls.hosted(repoId);
    const slug = repo.remoteSlug as string;
    const { pr, comments } = await this.pulls.adapter(repo).get(slug, number);
    if (pr.state !== PrState.Open) throw new ApiError(409, ErrorCode.InvalidState, 'The pull request is not open');
    const agents = this.jobs.agentCommentIds(repoId, number);
    const threads = comments
      .filter((comment) => comment.parent_id === null && !comment.resolved)
      .map((root) => threadOf(comments, root.id))
      .filter((thread) => thread.length > 1 && !agents.has((thread.at(-1) as HostComment).id));
    if (threads.length === 0) {
      throw new ApiError(409, ErrorCode.InvalidState, 'No open thread has a reply to check');
    }
    const session = this.jobs.requireIdle(repo, number);
    const earlier = this.earlier(repoId, number);
    const copy = this.playbooks.copyFor(PlaybookTrigger.CheckReply);
    const row = this.insert(repoId, pr, CommentPassKind.Check, threads, copy);
    await this.jobs.release(prCommentPasses, earlier);
    this.run(row.id, session, checkRepliesBrief(slug, pr, threads), false);
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
        .set({ status: AgentReviewStatus.Running, error: null, startedAt: new Date().toISOString(), finishedAt: null })
        .where(eq(prCommentPasses.id, id))
        .returning()
        .get() as Row;
      this.announce(emit, next);
      return next;
    });
    const brief = row.kind === CommentPassKind.Check ? checkRepliesBrief : commentPassBrief;
    this.run(id, session, brief(slug, { ...pr, head_sha: row.headSha }, threads), true);
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
    const skills = parseSkillCopies(row.playbookSkills);
    const failure = await this.steps.run({
      job: { kind: 'comment_pass', id: row.id },
      sessionId: session,
      brief,
      rules,
      skills,
      cwd,
      deny: HOST_WRITE_DENIALS,
    });
    if (failure) throw new JobFailed(failure, true);
    const closing = { rules, skills, cwd, deny: HOST_WRITE_DENIALS };
    const check = row.kind === CommentPassKind.Check;
    const prompt = check ? CHECK_REPLIES_PROMPT : COMMENT_PASS_PROMPT;
    const summary = await this.runtime.runFor(session, prompt, null, closing).finished;
    if (summary.stopped) throw new JobFailed(`The threads were not reported: ${STOPPED}`, true);
    if (summary.failure) throw new JobFailed(summary.failure, true);
    const answered = summary.ok ? readOutcomes(summary.text, check) : null;
    const threads = storedThreads(row);
    const byId = new Map(answered?.map((thread) => [thread.comment_id, thread]));
    if (!answered || threads.some((thread) => !byId.has(thread.comment_id))) {
      throw new JobFailed('The agent did not report every thread in a way the console could read', true);
    }
    const reported = threads.map((thread) => {
      const answer = byId.get(thread.comment_id) as { outcome: ThreadOutcome; reply: string };
      return { ...thread, outcome: answer.outcome, reply: answer.reply };
    });
    // Check replies changes nothing, so there is nothing to commit or push.
    return this.update(row.id, { threads: JSON.stringify(reported), stage: check ? 'post' : 'push' });
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
      // A general comment has no thread to resolve on the hosts; its reply is the answer.
      const settled = thread.outcome === ThreadOutcome.Done || thread.outcome === ThreadOutcome.Fixed;
      if (settled && !thread.resolved && thread.file_path !== null) {
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
        .set({ status: AgentReviewStatus.Ready, scratchPath: null, error: null, finishedAt: new Date().toISOString() })
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
        .set({ status: AgentReviewStatus.Failed, error, canRetry, finishedAt: new Date().toISOString() })
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

/** The closing turn's answer as outcomes: Address comments' done or declined, or Check replies' verdicts. */
function readOutcomes(
  text: string,
  check: boolean,
): { comment_id: string; outcome: ThreadOutcome; reply: string }[] | null {
  if (!check) return parseAgentJson(text, outcomesSchema)?.threads ?? null;
  return (
    parseAgentJson(text, verdictsSchema)?.threads.map(({ comment_id, verdict, reply }) => ({
      comment_id,
      outcome: verdict,
      reply,
    })) ?? null
  );
}
