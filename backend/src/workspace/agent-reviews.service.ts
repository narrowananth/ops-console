import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ActionKind,
  ActionOutcome,
  AgentReviewStatus,
  checklistItemSchema,
  type Finding,
  FindingSeverity,
  type PrAgentReview,
  type PrComment,
  type PrFile,
  SessionKind,
  toolUseSchema,
} from '@ops-console/shared';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ActionLogService } from '../action-log/action-log.service';
import { AgentRuntime } from '../agent/runtime';
import { SessionsService } from '../agent/sessions.service';
import { agentComments, prAgentReviews, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import type { HostPullRequest } from './git-host';
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

export function reviewPrompt(slug: string, pr: HostPullRequest, files: PrFile[]): string {
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

${patches.join('\n\n')}

Read the change as a careful reviewer would. Do not change anything and do not post comments: the console posts your findings. Answer with one JSON block and nothing after it:

\`\`\`json
{
  "verdict": "one sentence",
  "findings": [{ "severity": "blocker | suggestion | nit", "file": "path or null", "line": 0, "text": "what is wrong and what to do" }],
  "checklist": [{ "item": "PROD readiness check", "status": "pass | warn | fail | na", "note": "short" }],
  "tools": [{ "connection": "name", "query": "what you ran", "result": "what it showed" }]
}
\`\`\`

The checklist covers PROD readiness: migrations, config and secrets, backwards compatibility, rollback, tests. "tools" lists the Connections you queried, and stays empty when you queried none.`;
}

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
  ) {}

  async list(repoId: string, number: number): Promise<PrAgentReview[]> {
    const repo = this.pulls.hosted(repoId);
    const { pr } = await this.pulls.adapter(repo).get(repo.remoteSlug as string, number);
    return this.store.db
      .select()
      .from(prAgentReviews)
      .where(and(eq(prAgentReviews.repoId, repoId), eq(prAgentReviews.prNumber, number)))
      .orderBy(desc(prAgentReviews.createdAt), desc(prAgentReviews.id))
      .all()
      .map((row) => toAgentReview(row, pr.head_sha));
  }

  /** Stores a `running` review and answers; the agent runs on, and `pull_request.reviewed` reports the end. */
  async start(repoId: string, number: number): Promise<PrAgentReview> {
    const repo = this.pulls.hosted(repoId);
    const slug = repo.remoteSlug as string;
    const { pr, files } = await this.pulls.adapter(repo).get(slug, number);
    const session = this.reviewSession(repoId, number, `${repo.name} #${number} review`);
    const { finished } = this.runtime.runFor(session, reviewPrompt(slug, pr, files));
    const row = this.store.write((tx) =>
      tx
        .insert(prAgentReviews)
        .values({ id: crypto.randomUUID(), repoId, prNumber: number, headSha: pr.head_sha })
        .returning()
        .get(),
    );
    void finished
      .then((summary) => this.complete(row.id, session, slug, pr.head_sha, summary))
      .catch((error) =>
        this.logger.error(`review ${row.id} failed: ${error instanceof Error ? error.message : error}`),
      );
    return toAgentReview(row, pr.head_sha);
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
    const session = this.reviewSession(repoId, number, `${repo.name} #${number} review`);
    const text = `The operator replied in a review thread you started on pull request #${number} of ${slug}${
      rootComment?.file_path ? `, on ${rootComment.file_path}${rootComment.line ? `:${rootComment.line}` : ''}` : ''
    }.

${thread.map((comment) => `${comment.author}: ${comment.body}`).join('\n\n')}

Answer the last message in plain text, in a few sentences. Do not change anything.`;
    const summary = await this.runtime.runFor(session, text).finished;
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
    summary: { ok: boolean; text: string },
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

  /** The pull request's one `pr_review` Session, made on first use. */
  private reviewSession(repoId: string, number: number, title: string): string {
    const existing = this.store.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.repoId, repoId), eq(sessions.prNumber, number), eq(sessions.kind, SessionKind.PrReview)))
      .get();
    if (existing) return existing.id;
    const created = this.sessions.create({ kind: SessionKind.PrReview, repoId, prNumber: number });
    this.sessions.update(created.id, { title });
    return created.id;
  }
}
