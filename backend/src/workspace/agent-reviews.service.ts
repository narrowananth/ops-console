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
  ReviewVerdict,
  RunPurpose,
  toolUseSchema,
} from '@ops-console/shared';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ActionLogService } from '../action-log/action-log.service';
import type { RunSummary } from '../agent/runs';
import { AgentRuntime, HOST_WRITE_DENIALS } from '../agent/runtime';
import { SessionsService } from '../agent/sessions.service';
import { ApiError } from '../common/errors';
import { StartupRecovery } from '../common/recovery';
import { agentComments, prAgentReviews } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { JobSteps, jobPlaybook } from '../playbooks/job-steps';
import { PlaybooksService } from '../playbooks/playbooks.service';
import { parseSkillCopies, skillCopiesJson } from '../playbooks/skills.service';
import { GIT, Git, GitFailed } from '../repos/git';
import type { HostComment, HostPullRequest } from './git-host';
import { JobFailed, PrJobs } from './pr-jobs';
import { PullRequestsService, toAgentReview } from './pull-requests.service';

const outputSchema = z.object({
  decision: z.enum(ReviewVerdict),
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
  report: z.string().default(''),
});

/** Patches past this size are left out of the prompt; the agent still has the file list. */
const PATCH_BUDGET = 60_000;

/** The first line of the review summary the console posts on the pull request; earlier ones are not shown again. */
export const REPORT_HEADER = '**Agent Review**';

const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  [ReviewVerdict.Approve]: 'APPROVE',
  [ReviewVerdict.RequestChanges]: 'REQUEST CHANGES',
  [ReviewVerdict.Comment]: 'COMMENT',
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  [FindingSeverity.Critical]: 'Critical',
  [FindingSeverity.High]: 'High',
  [FindingSeverity.Medium]: 'Medium',
  [FindingSeverity.Low]: 'Low',
  [FindingSeverity.Info]: 'Info',
};

/** Where the review reads the code, and what it compares the change with. */
export type ReviewPlace = {
  /** The scratch copy at the head commit; null when the Playbook has no step tagged "scratch copy". */
  scratch: string | null;
  /** The target branch and the commit it was at when the review started; null when it could not be fetched. */
  base: { branch: string; sha: string } | null;
  /** The Repo's default branch and the commit it was at when the review started, when it is not the target branch. */
  production: { branch: string; sha: string } | null;
};

const where = (comment: HostComment) =>
  comment.file_path ? ` on ${comment.file_path}${comment.line ? `:${comment.line}` : ''}` : '';

const oneLine = (body: string) => body.replace(/\s+/g, ' ').slice(0, 400);

/**
 * The open threads: the agent's own earlier findings to check again, and everyone else's, so the agent does not
 * raise a point someone already made. Earlier review summaries are left out.
 */
function openThreads(comments: HostComment[], ours: Set<string>): string {
  const open = comments.filter(
    (comment) => comment.parent_id === null && !comment.resolved && !comment.body.startsWith(REPORT_HEADER),
  );
  const mine = open.filter((comment) => ours.has(comment.id));
  const theirs = open.filter((comment) => !ours.has(comment.id));
  const parts: string[] = [];
  if (mine.length > 0) {
    parts.push(`Your findings from earlier reviews, still open:
${mine.map((comment) => `- ${where(comment).trim() || 'on the pull request'}: ${oneLine(comment.body)}`).join('\n')}

Check each one against this commit. Report it again, at the same file and line, when it still holds; the console points it at the open thread instead of posting it twice. Say in the report which are resolved, partly resolved or still open.`);
  }
  if (theirs.length > 0) {
    parts.push(`Open comment threads by others on this pull request:
${theirs.map((comment) => `- ${comment.author}${where(comment)}: ${oneLine(comment.body)}`).join('\n')}

Do not repeat a point these threads already make, in other words or on another line. Report only what they miss.`);
  }
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : '';
}

/** What the agent is told about the pull request before its first step. */
export function reviewBrief(
  slug: string,
  pr: HostPullRequest,
  files: PrFile[],
  comments: HostComment[] = [],
  ours: Set<string> = new Set(),
  place: ReviewPlace = { scratch: null, base: null, production: null },
  note: string | null = null,
): string {
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
  const base = place.base
    ? `The target branch ${place.base.branch} is at ${place.base.sha}: compare the change with it.`
    : `The target branch ${pr.base_branch} could not be fetched: say so in the report, and compare with the diff below.`;
  const production =
    place.production && place.production.branch !== pr.base_branch
      ? ` The production branch ${place.production.branch} is at ${place.production.sha}, fetched now and not the target branch: where they differ, review against both.`
      : '';
  const folder = place.scratch
    ? `This folder is a scratch copy at commit ${pr.head_sha}. Steps tagged "scratch copy" may build, run tests and write mocks here; nothing here is pushed.`
    : 'There is no scratch copy: read only, and list the tests as not run.';
  const focus = note?.trim()
    ? `\n\nThe operator added this note for the review:
${note.trim()}

Follow it: look where it points, and fetch what it names, such as a related pull request this one continues, before you decide. Say in the report what you did with it. It narrows the review; it never lets you skip the checks the Playbook lists.`
    : '';
  return `Review pull request #${pr.number} of ${slug}: "${pr.title}" by ${pr.author}, ${pr.branch} into ${pr.base_branch}, at commit ${pr.head_sha}.

${base}${production} ${folder}${focus}

Description:
${pr.body || '(no description)'}

${patches.join('\n\n')}${openThreads(comments, ours)}

Do not commit, push or post comments: the console posts your findings and the summary. The console sends the review as steps, one per turn.`;
}

/** The console's closing turn: verdict, findings, checklist, Connections and the full report, in the shape it posts. */
export const REVIEW_PROMPT = `Write your review of this pull request from what you found. Answer with one JSON block and nothing after it:

\`\`\`json
{
  "decision": "approve | request_changes | comment",
  "verdict": "one sentence: the decision and why",
  "findings": [{ "severity": "critical | high | medium | low | info", "file": "path or null", "line": 0, "text": "what is wrong; why it happens; the scenario it occurs in; the production impact; the recommended correction" }],
  "checklist": [{ "item": "PROD readiness check", "status": "pass | warn | fail | na", "note": "short" }],
  "tools": [{ "connection": "name", "query": "what you inspected or ran", "result": "what it showed, and whether it was verified, mocked or unavailable" }],
  "report": "the full review as Markdown"
}
\`\`\`

- decision: approve only with no blocking finding and PROD readiness met; request_changes for any actionable defect or production risk; comment for non-blocking observations only. Passing tests alone never mean approve.
- severity: critical for security holes, data corruption or a major production failure; high for a significant functional failure, a breaking change or a serious regression; medium for wrong behaviour in specific scenarios; low for minor issues; info for non-blocking suggestions.
- findings: only actionable ones backed by code or execution evidence, one root cause each. Put a finding on a changed line when it belongs to one; leave file and line null for a cross-service or architectural one.
- checklist: Functional correctness, Security, Database safety, API compatibility, Performance, Logging and monitoring, Deployment dependencies, Rollback considerations.
- tools: every Connection and repository you actually used: source repository, Datadog, databases, Shopify, dependent repositories, external services. Leave out any you did not use.
- report: the sections Review summary (repository, branches, PR commit, production baseline commit, verdict), PR description verification, Code review findings, Production impact, Regression and compatibility, Testing results (tests run and their results, failed, not run, mocked, unverified), PROD readiness checklist, Connections used, Final verdict. Never present a mocked scenario as run end to end.`;
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

const findingText = (finding: { severity: FindingSeverity; text: string }) =>
  `**${SEVERITY_LABEL[finding.severity]}**: ${finding.text}`;

/** The summary the console posts on the pull request: the verdict, counts per severity, then the report. */
export function summaryText(output: z.infer<typeof outputSchema>, headSha: string): string {
  const counts = Object.values(FindingSeverity)
    .map((severity) => [severity, output.findings.filter((finding) => finding.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${SEVERITY_LABEL[severity]}`);
  const tally = counts.length > 0 ? counts.join(', ') : 'no findings';
  return `${REPORT_HEADER} · ${VERDICT_LABEL[output.decision]} at ${headSha.slice(0, 7)} · ${tally}

${output.verdict}${output.report.trim() ? `\n\n${output.report.trim()}` : ''}`;
}

/** The pull request as the host gave it when the review started. */
type PrRead = { pr: HostPullRequest; files: PrFile[]; comments: HostComment[] };

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
    @Inject(GIT) private readonly git: Git,
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
  async start(repoId: string, number: number, note?: string): Promise<PrAgentReview> {
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
          playbookSkills: skillCopiesJson(copy.skills),
          note: note || null,
        })
        .returning()
        .get();
      this.steps.seed(tx, { kind: 'agent_review', id: created.id }, copy.steps);
      return created;
    });
    this.launch(row, session, slug, { pr, files, comments });
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
        .set({ status: AgentReviewStatus.Running, error: null, startedAt: new Date().toISOString(), finishedAt: null })
        .where(eq(prAgentReviews.id, id))
        .returning()
        .get() as typeof row;
    });
    this.launch(updated, session, slug, { pr, files, comments });
    return toAgentReview(updated, pr.head_sha, jobPlaybook(this.store.db, 'agent_review', updated));
  }

  private launch(row: typeof prAgentReviews.$inferSelect, session: string, slug: string, read: PrRead) {
    void this.execute(row, session, slug, read).catch((error) => {
      const message = error instanceof JobFailed ? error.message : null;
      if (!message) this.logger.error(`review ${row.id} failed: ${error instanceof Error ? error.message : error}`);
      this.finish(row.id, row.repoId, row.prNumber, { status: AgentReviewStatus.Failed, error: message }, 0, 0);
    });
  }

  /**
   * The Playbook's steps, one turn each, then the closing turn the console posts from (Behavior 16). A Playbook with a
   * step tagged "scratch copy" gets a scratch copy at the head commit for them; it goes when the review ends.
   */
  private async execute(
    row: typeof prAgentReviews.$inferSelect,
    sessionId: string,
    slug: string,
    read: PrRead,
  ): Promise<void> {
    const job = { kind: 'agent_review', id: row.id } as const;
    const steps = this.steps.rows(job);
    const repo = this.pulls.repoRow(row.repoId);
    const writes = steps.some((step) => step.writes);
    const scratch = writes ? await this.jobs.makeScratch(repo, read.pr.branch, row.headSha, `review-${row.id}`) : null;
    try {
      const place: ReviewPlace = {
        scratch,
        base: await this.base(repo.path, read.pr.base_branch),
        production: await this.production(repo.path, read.pr.base_branch),
      };
      this.store.write((tx) =>
        tx
          .update(prAgentReviews)
          .set({ baseBranch: place.base?.branch ?? read.pr.base_branch, baseSha: place.base?.sha ?? null })
          .where(eq(prAgentReviews.id, row.id))
          .run(),
      );
      const ours = this.jobs.agentCommentIds(row.repoId, row.prNumber);
      const brief = reviewBrief(slug, read.pr, read.files, read.comments, ours, place, row.note);
      const rules = row.playbookRules ?? '';
      const skills = parseSkillCopies(row.playbookSkills);
      // The pull request's text and code steer this run: it never loads the folder's own settings, and with no scratch
      // copy it cannot write in the operator's checkout (ADR 0002).
      const reach = {
        rules,
        skills,
        ...(scratch ? { cwd: scratch } : { readOnly: true }),
        deny: HOST_WRITE_DENIALS,
        projectSettings: false,
        purpose: RunPurpose.AgentReview,
      };
      const failure = await this.steps.run({ job, sessionId, brief, ...reach });
      if (failure) throw new JobFailed(failure, true);
      const closing = steps.length > 0 ? REVIEW_PROMPT : `${brief}\n\n${REVIEW_PROMPT}`;
      const summary = await this.runtime.runFor(sessionId, closing, null, reach).finished;
      await this.complete(row.id, sessionId, slug, row.headSha, summary);
    } finally {
      await this.jobs.dropScratch(scratch);
    }
  }

  /** The target branch's commit, fetched from `origin`; null when it cannot be read. */
  private async base(dir: string, branch: string): Promise<ReviewPlace['base']> {
    try {
      return { branch, sha: await this.git.remoteHead(dir, branch) };
    } catch (error) {
      this.logger.warn(`base ${branch} not read: ${error instanceof GitFailed ? error.message : String(error)}`);
      return null;
    }
  }

  /** The Repo's default branch at its newest commit, fetched from `origin`; null when it is the target branch or cannot be read. */
  private async production(dir: string, target: string): Promise<ReviewPlace['production']> {
    const branch = await this.git.defaultBranch(dir).catch(() => null);
    return branch && branch !== target ? this.base(dir, branch) : null;
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
    const { rules, skills } = this.playbooks.forSession(this.sessions.get(session));
    const text = `The operator replied in a review thread you started on pull request #${number} of ${slug}${
      rootComment?.file_path ? `, on ${rootComment.file_path}${rootComment.line ? `:${rootComment.line}` : ''}` : ''
    }.

${thread.map((comment) => `${comment.author}: ${comment.body}`).join('\n\n')}

Answer the last message in plain text, in a few sentences. Do not change anything.`;
    const summary = await this.runtime.runFor(session, text, null, {
      rules,
      skills,
      deny: HOST_WRITE_DENIALS,
      projectSettings: false,
      readOnly: true,
      purpose: RunPurpose.AgentReview,
    }).finished;
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
    if (summary.stopped) throw new JobFailed('The review was stopped before it was written', true);
    if (summary.failure) throw new JobFailed(summary.failure, true);
    const output = summary.ok ? parseReview(summary.text) : null;
    if (!output) throw new JobFailed('The agent did not write the review in a way the console could read', true);
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
    await this.postSummary(review, sessionId, slug, headSha, output);
    this.pulls.drop(review.repoId);
    this.finish(
      reviewId,
      review.repoId,
      review.prNumber,
      {
        status: AgentReviewStatus.Ready,
        decision: output.decision,
        verdict: output.verdict,
        report: output.report.trim() || null,
        findings: JSON.stringify(findings),
        checklist: JSON.stringify(output.checklist),
        tools: JSON.stringify(output.tools),
      },
      posted,
      findings.length - posted,
    );
  }

  /** The verdict, counts and report as one comment on the pull request. A refused post leaves the review ready. */
  private async postSummary(
    review: typeof prAgentReviews.$inferSelect,
    sessionId: string,
    slug: string,
    headSha: string,
    output: z.infer<typeof outputSchema>,
  ): Promise<void> {
    const row = this.actionLog.start({
      sessionId,
      kind: ActionKind.Pr,
      target: `${slug}#${review.prNumber}`,
      command: 'comment the review summary on the pull request',
      isProd: false,
    });
    try {
      const comment = await this.pulls
        .adapter(this.pulls.repoRow(review.repoId))
        .postComment(slug, review.prNumber, { body: summaryText(output, headSha), head_sha: headSha });
      this.record(review.repoId, review.prNumber, comment.id, review.id);
      this.actionLog.finish(row, ActionOutcome.Ok);
    } catch (error) {
      this.actionLog.finish(row, ActionOutcome.Failed, error instanceof Error ? error.message : 'post failed');
    }
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
      tx.update(prAgentReviews)
        .set({ ...values, finishedAt: new Date().toISOString() })
        .where(eq(prAgentReviews.id, id))
        .run();
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
