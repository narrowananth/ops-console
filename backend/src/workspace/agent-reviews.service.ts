import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ActionKind,
  ActionOutcome,
  AgentReviewStatus,
  checklistItemSchema,
  ErrorCode,
  type Finding,
  FindingSeverity,
  PlaybookTrigger,
  type PrAgentReview,
  type PrComment,
  type PrFile,
  toolUseSchema,
} from '@ops-console/shared';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ActionLogService } from '../action-log/action-log.service';
import type { RunSummary } from '../agent/runs';
import { AgentRuntime } from '../agent/runtime';
import { SessionsService } from '../agent/sessions.service';
import { ApiError } from '../common/errors';
import { StartupRecovery } from '../common/recovery';
import { agentComments, prAgentReviews } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { JobSteps, jobPlaybook } from '../playbooks/job-steps';
import { PlaybooksService } from '../playbooks/playbooks.service';
import type { HostComment, HostPullRequest } from './git-host';
import { PrJobs } from './pr-jobs';
import { PullRequestsService, toAgentReview } from './pull-requests.service';

const outputSchema = z.object({
  verdict: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(FindingSeverity),
      file: z.string().nullish(),
      line: z.number().int().nullish(),
      text: z.string().min(1),
    }),
  ),
  checklist: z.array(checklistItemSchema).default([]),
  tools: z.array(toolUseSchema).default([]),
});

/** Patches past this size are left out of the prompt; the agent still has the file list. */
const PATCH_BUDGET = 60_000;

/** Open threads, so the agent does not raise a point someone, itself included, already made. */
function openThreads(comments: HostComment[]): string {
  const open = comments.filter((comment) => comment.parent_id === null && !comment.resolved);
  if (open.length === 0) return '';
  const lines = open.map(
    (comment) =>
      `- ${comment.author}${comment.file_path ? ` on ${comment.file_path}${comment.line ? `:${comment.line}` : ''}` : ''}: ${comment.body.replace(/\s+/g, ' ').slice(0, 400)}`,
  );
  return `\n\nOpen comment threads already on this pull request:\n${lines.join('\n')}\n\nDo not repeat a point these threads already make, in other words or on another line. Report only what they miss.`;
}

/** What the agent is told about the pull request before its first step. */
export function reviewBrief(slug: string, pr: HostPullRequest, files: PrFile[], comments: HostComment[] = []): string {
  let budget = PATCH_BUDGET;
  const patches = files.map((file) => {
    const text = file.lines
      .map((line) => (line.text.startsWith('@@') ? line.text : `${line.sign}${line.text}`))
      .join('\n');
    if (text.length > budget)
      return `### ${file.name} (+${file.additions} -${file.deletions})\n(patch left out: too large)`;
    budget -= text.length;
    return `### ${file.name} (+${file.additions} -${file.deletions})\n${text}`;
  });
  return `Review pull request #${pr.number} of ${slug}: "${pr.title}" by ${pr.author}, ${pr.branch} into ${pr.base_branch}, at commit ${pr.head_sha}.

${pr.body || '(no description)'}

${patches.join('\n\n')}${openThreads(comments)}

Do not change anything and do not post comments: the console posts your findings. The console sends the review as steps, one per turn.`;
}

/** The console's closing turn: findings, checklist and verdict, in the shape it posts. */
export const REVIEW_PROMPT = `Write your review of this pull request from what you found. Answer with one JSON block and nothing after it:

\`\`\`json
{
  "verdict": "one sentence",
  "findings": [{ "severity": "blocker | suggestion | nit", "file": "path or null", "line": 0, "text": "what is wrong and what to do" }],
  "checklist": [{ "item": "PROD readiness check", "status": "pass | warn | fail | na", "note": "short" }],
  "tools": [{ "connection": "name", "query": "what you ran", "result": "what it showed" }]
}
\`\`\`

The checklist covers PROD readiness: migrations, config and secrets, backwards compatibility, rollback, tests. "tools" lists the Connections you queried, and stays empty when you queried none.`;

export function parseReview(text: string): z.infer<typeof outputSchema> | null {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const parsed = outputSchema.safeParse(JSON.parse(candidate));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const findingText = (finding: { severity: string; text: string }) => `**${finding.severity}**: ${finding.text}`;

@Injectable()
export class AgentReviewsService {
  private readonly logger = new Logger('agent-reviews');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(PullRequestsService) private readonly pulls: PullRequestsService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
    @Inject(PlaybooksService) private readonly playbooks: PlaybooksService,
    @Inject(JobSteps) private readonly steps: JobSteps,
    @Inject(PrJobs) private readonly jobs: PrJobs,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('pull request agent reviews', () => this.recover());
  }

  /** Start-up recovery: a review the last daemon left `running` did not finish; it would block the next one. */
  private recover(): void {
    const running = this.store.db
      .select()
      .from(prAgentReviews)
      .where(eq(prAgentReviews.status, AgentReviewStatus.Running))
      .all();
    for (const review of running) {
      this.finish(review.id, review.repoId, review.prNumber, { status: AgentReviewStatus.Failed }, 0, 0);
    }
  }

  async list(repoId: string, number: number): Promise<PrAgentReview[]> {
    const repo = this.pulls.hosted(repoId);
    const { pr } = await this.pulls.detail(repo, number);
    return this.store.db
      .select()
      .from(prAgentReviews)
      .where(and(eq(prAgentReviews.repoId, repoId), eq(prAgentReviews.prNumber, number)))
      .orderBy(desc(prAgentReviews.createdAt), desc(prAgentReviews.id))
      .all()
      .map((row) => toAgentReview(row, pr.head_sha, jobPlaybook(this.store.db, 'agent_review', row)));
  }

  /**
   * Stores a `running` review and answers; the agent runs on, and `pull_request.reviewed` reports the end. A commit
   * already reviewed is not reviewed again: its findings are on the host.
   */
  async start(repoId: string, number: number): Promise<PrAgentReview> {
    const repo = this.pulls.hosted(repoId);
    const slug = repo.remoteSlug as string;
    const { pr, files, comments } = await this.pulls.adapter(repo).get(slug, number);
    const reviewed = this.store.db
      .select({ id: prAgentReviews.id })
      .from(prAgentReviews)
      .where(
        and(
          eq(prAgentReviews.repoId, repoId),
          eq(prAgentReviews.prNumber, number),
          eq(prAgentReviews.headSha, pr.head_sha),
          eq(prAgentReviews.status, AgentReviewStatus.Ready),
        ),
      )
      .get();
    if (reviewed)
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        'The agent already reviewed this commit; push a change to review again',
      );
    const session = this.jobs.requireIdle(repo, number);
    const copy = this.playbooks.copyFor(PlaybookTrigger.ReviewPr);
    const row = this.store.write((tx) => {
      const created = tx
        .insert(prAgentReviews)
        .values({
          id: crypto.randomUUID(),
          repoId,
          prNumber: number,
          headSha: pr.head_sha,
          playbookId: copy.id,
          playbookName: copy.name,
          playbookRules: copy.rules,
        })
        .returning()
        .get();
      this.steps.seed(tx, { kind: 'agent_review', id: created.id }, copy.steps);
      return created;
    });
    this.launch(row, session, slug, pr.head_sha, reviewBrief(slug, pr, files, comments));
    return toAgentReview(row, pr.head_sha, jobPlaybook(this.store.db, 'agent_review', row));
  }

  /**
   * A failed review runs again in its Session from its failed step, or only its closing turn when no step failed.
   * `skip` passes over the failed step. A pull request with new commits is reviewed afresh instead.
   */
  async retry(id: string, skip = false): Promise<PrAgentReview> {
    const row = this.store.db.select().from(prAgentReviews).where(eq(prAgentReviews.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Agent Review');
    if (row.status !== AgentReviewStatus.Failed) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Only a failed Agent Review can run again');
    }
    const repo = this.pulls.hosted(row.repoId);
    const slug = repo.remoteSlug as string;
    const { pr, files, comments } = await this.pulls.adapter(repo).get(slug, row.prNumber);
    if (pr.head_sha !== row.headSha) {
      throw new ApiError(409, ErrorCode.InvalidState, 'The pull request has new commits; review it again');
    }
    const session = this.jobs.requireIdle(repo, row.prNumber);
    const job = { kind: 'agent_review', id } as const;
    const updated = this.store.write((tx, emit) => {
      if (skip) this.steps.skip(tx, emit, job);
      this.steps.reset(tx, emit, job);
      return tx
        .update(prAgentReviews)
        .set({ status: AgentReviewStatus.Running })
        .where(eq(prAgentReviews.id, id))
        .returning()
        .get() as typeof row;
    });
    this.launch(updated, session, slug, pr.head_sha, reviewBrief(slug, pr, files, comments));
    return toAgentReview(updated, pr.head_sha, jobPlaybook(this.store.db, 'agent_review', updated));
  }

  private launch(row: typeof prAgentReviews.$inferSelect, session: string, slug: string, head: string, brief: string) {
    void this.execute(row.id, session, slug, head, brief, row.playbookRules ?? '').catch((error) => {
      this.logger.error(`review ${row.id} failed: ${error instanceof Error ? error.message : error}`);
      this.finish(row.id, row.repoId, row.prNumber, { status: AgentReviewStatus.Failed }, 0, 0);
    });
  }

  /** The Playbook's steps, one turn each, then the closing turn the console posts from (Behavior 16). */
  private async execute(
    reviewId: string,
    sessionId: string,
    slug: string,
    headSha: string,
    brief: string,
    rules: string,
  ): Promise<void> {
    const job = { kind: 'agent_review', id: reviewId } as const;
    const hasSteps = this.steps.rows(job).length > 0;
    const failure = await this.steps.run({ job, sessionId, brief, rules });
    if (failure) {
      const review = this.store.db.select().from(prAgentReviews).where(eq(prAgentReviews.id, reviewId)).get();
      if (review) this.finish(reviewId, review.repoId, review.prNumber, { status: AgentReviewStatus.Failed }, 0, 0);
      return;
    }
    const closing = hasSteps ? REVIEW_PROMPT : `${brief}\n\n${REVIEW_PROMPT}`;
    const summary = await this.runtime.runFor(sessionId, closing, null, { rules }).finished;
    await this.complete(reviewId, sessionId, slug, headSha, summary);
  }

  /** After the operator posts a reply: a thread the agent started wakes the agent. */
  afterReply(repoId: string, number: number, reply: PrComment): void {
    const root = reply.parent_id;
    if (root === null || !this.isAgentComment(repoId, number, root)) return;
    void this.answerThread(repoId, number, root).catch((error) =>
      this.logger.warn(`thread answer failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  private async answerThread(repoId: string, number: number, root: string): Promise<void> {
    const repo = this.pulls.hosted(repoId);
    const slug = repo.remoteSlug as string;
    const { pr, comments } = await this.pulls.adapter(repo).get(slug, number);
    const thread = comments.filter((comment) => comment.id === root || comment.parent_id === root);
    const rootComment = thread.find((comment) => comment.id === root);
    // A job on the pull request holds its Session between steps; the answer waits for it to end.
    const session = await this.jobs.whenIdle(repo, number);
    const { rules } = this.playbooks.forSession(this.sessions.get(session));
    const text = `The operator replied in a review thread you started on pull request #${number} of ${slug}${
      rootComment?.file_path ? `, on ${rootComment.file_path}${rootComment.line ? `:${rootComment.line}` : ''}` : ''
    }.

${thread.map((comment) => `${comment.author}: ${comment.body}`).join('\n\n')}

Answer the last message in plain text, in a few sentences. Do not change anything.`;
    const summary = await this.runtime.runFor(session, text, null, { rules }).finished;
    if (!summary.ok || !summary.text.trim()) return;
    const row = this.actionLog.start({
      sessionId: session,
      kind: ActionKind.Pr,
      target: `${slug}#${number}`,
      command: `reply in thread ${root}`,
      isProd: false,
    });
    try {
      const posted = await this.pulls
        .adapter(repo)
        .postComment(slug, number, { body: summary.text.trim(), head_sha: pr.head_sha, parent_id: root });
      this.record(repoId, number, posted.id, null);
      this.actionLog.finish(row, ActionOutcome.Ok);
      this.pulls.drop(repoId);
      this.store.write((_tx, emit) =>
        emit('pull_request.commented', { repo_id: repoId, number, comment_id: posted.id, by_agent: true }),
      );
    } catch (error) {
      this.actionLog.finish(row, ActionOutcome.Failed, error instanceof Error ? error.message : 'post failed');
      throw error;
    }
  }

  private async complete(
    reviewId: string,
    sessionId: string,
    slug: string,
    headSha: string,
    summary: RunSummary,
  ): Promise<void> {
    const review = this.store.db.select().from(prAgentReviews).where(eq(prAgentReviews.id, reviewId)).get();
    if (!review) return;
    const output = summary.ok ? parseReview(summary.text) : null;
    if (!output) {
      this.finish(reviewId, review.repoId, review.prNumber, { status: AgentReviewStatus.Failed }, 0, 0);
      return;
    }
    const repo = this.pulls.repoRow(review.repoId);
    const adapter = this.pulls.adapter(repo);
    const earlier = await this.openAgentThreads(review.repoId, review.prNumber, slug);
    const findings: Finding[] = [];
    let posted = 0;
    for (const found of output.findings) {
      const inline = found.file && found.line ? { file_path: found.file, line: found.line } : {};
      const finding: Finding = {
        severity: found.severity,
        file: found.file ?? null,
        line: found.line ?? null,
        text: found.text,
        comment_id: null,
        post_error: null,
      };
      // An earlier review's open thread on the same line already says it; point the finding there.
      const same = found.file && found.line ? earlier.get(`${found.file}:${found.line}`) : undefined;
      if (same) {
        finding.comment_id = same;
        findings.push(finding);
        continue;
      }
      const row = this.actionLog.start({
        sessionId,
        kind: ActionKind.Pr,
        target: `${slug}#${review.prNumber}`,
        command: `comment on ${found.file && found.line ? `${found.file}:${found.line}` : 'the pull request'}`,
        isProd: false,
      });
      try {
        const comment = await adapter.postComment(slug, review.prNumber, {
          body: findingText(found),
          head_sha: headSha,
          ...inline,
        });
        this.record(review.repoId, review.prNumber, comment.id, reviewId);
        finding.comment_id = comment.id;
        posted++;
        this.actionLog.finish(row, ActionOutcome.Ok);
        this.store.write((_tx, emit) =>
          emit('pull_request.commented', {
            repo_id: review.repoId,
            number: review.prNumber,
            comment_id: comment.id,
            by_agent: true,
          }),
        );
      } catch (error) {
        finding.post_error = error instanceof Error ? error.message : 'post failed';
        this.actionLog.finish(row, ActionOutcome.Failed, finding.post_error);
      }
      findings.push(finding);
    }
    this.pulls.drop(review.repoId);
    this.finish(
      reviewId,
      review.repoId,
      review.prNumber,
      {
        status: AgentReviewStatus.Ready,
        verdict: output.verdict,
        findings: JSON.stringify(findings),
        checklist: JSON.stringify(output.checklist),
        tools: JSON.stringify(output.tools),
      },
      posted,
      findings.length - posted,
    );
  }

  private finish(
    id: string,
    repoId: string,
    number: number,
    values: Partial<typeof prAgentReviews.$inferInsert> & { status: AgentReviewStatus },
    posted: number,
    postFailed: number,
  ): void {
    this.store.write((tx, emit) => {
      tx.update(prAgentReviews).set(values).where(eq(prAgentReviews.id, id)).run();
      emit('pull_request.reviewed', {
        repo_id: repoId,
        number,
        agent_review_id: id,
        status: values.status === AgentReviewStatus.Ready ? 'ready' : 'failed',
        posted,
        post_failed: postFailed,
      });
    });
  }

  /** `file:line` to the id of an open thread the agent started there. A host that cannot be read gives none. */
  private async openAgentThreads(repoId: string, number: number, slug: string): Promise<Map<string, string>> {
    const ours = new Set(
      this.store.db
        .select({ id: agentComments.commentId })
        .from(agentComments)
        .where(and(eq(agentComments.repoId, repoId), eq(agentComments.prNumber, number)))
        .all()
        .map((row) => row.id),
    );
    if (ours.size === 0) return new Map();
    try {
      const { comments } = await this.pulls.adapter(this.pulls.repoRow(repoId)).get(slug, number);
      return new Map(
        comments
          .filter((c) => c.parent_id === null && !c.resolved && c.file_path && c.line && ours.has(c.id))
          .map((c) => [`${c.file_path}:${c.line}`, c.id]),
      );
    } catch {
      return new Map();
    }
  }

  private record(repoId: string, number: number, commentId: string, reviewId: string | null): void {
    this.store.write((tx) => {
      tx.insert(agentComments).values({ repoId, prNumber: number, commentId, agentReviewId: reviewId }).run();
    });
  }

  private isAgentComment(repoId: string, number: number, commentId: string): boolean {
    return (
      this.store.db
        .select({ id: agentComments.commentId })
        .from(agentComments)
        .where(
          and(
            eq(agentComments.repoId, repoId),
            eq(agentComments.prNumber, number),
            eq(agentComments.commentId, commentId),
          ),
        )
        .get() !== undefined
    );
  }
}
