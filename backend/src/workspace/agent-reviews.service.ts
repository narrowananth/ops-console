import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ActionKind,
  ActionOutcome,
  type Finding,
  FindingSeverity,
  type PrAgentReview,
  type PrComment,
  type PrFile,
  ReviewVerdict,
  RunPurpose,
  SessionKind,
} from '@ops-console/shared';
import { and, desc, eq } from 'drizzle-orm';
import { ActionLogService } from '../action-log/action-log.service';
import type { ReviewOutput } from '../agent/pull-request-tool';
import { AgentRuntime, HOST_WRITE_DENIALS } from '../agent/runtime';
import { type SessionRow, SessionsService } from '../agent/sessions.service';
import { mapLimit } from '../common/map-limit';
import { agentComments, prAgentReviews, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { PlaybooksService } from '../playbooks/playbooks.service';
import type { HostComment, HostPullRequest } from './git-host';
import { POST_PARALLEL, PrHostWrites } from './pr-host-writes';
import { PullRequestsService, toAgentReview } from './pull-requests.service';

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
  place: ReviewPlace = { base: null, production: null },
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
  const folder = `This folder is a worktree at commit ${pr.head_sha}. You may build, run tests and write mocks here; nothing in it is pushed or posted.`;
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

Do not commit, push or post comments. When the review is done, call the submit_review tool once: the console posts your findings on their lines and the summary on the pull request.`;
}

/** What the agent is told about the review it submits: the decision, the severities, and what the report holds. */
export const REVIEW_GUIDE = `Write your review of this pull request from what you found, then call submit_review once with:
- decision: approve only with no blocking finding and PROD readiness met; request_changes for any actionable defect or production risk; comment for non-blocking observations only. Passing tests alone never mean approve.
- verdict: one sentence, the decision and why.
- severity of each finding: critical for security holes, data corruption or a major production failure; high for a significant functional failure, a breaking change or a serious regression; medium for wrong behaviour in specific scenarios; low for minor issues; info for non-blocking suggestions.
- findings: only actionable ones backed by code or execution evidence, one root cause each. Each says what is wrong, why it happens, the scenario it occurs in, the production impact and the recommended correction. Put a finding on a changed line when it belongs to one; leave file and line out for a cross-service or architectural one.
- report: the full review as Markdown, with the sections Review summary (repository, branches, PR commit, production baseline commit, verdict), PR description verification, Code review findings, Production impact, Regression and compatibility, Testing results (tests run and their results, failed, not run, mocked, unverified), PROD readiness checklist, Connections used, Final verdict. Never present a mocked scenario as run end to end.`;

const findingText = (finding: { severity: FindingSeverity; text: string }) =>
  `**${SEVERITY_LABEL[finding.severity]}**: ${finding.text}`;

/** The summary the console posts on the pull request: the verdict, counts per severity, then the report. */
export function summaryText(output: ReviewOutput, headSha: string): string {
  const counts = Object.values(FindingSeverity)
    .map((severity) => [severity, output.findings.filter((finding) => finding.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${SEVERITY_LABEL[severity]}`);
  const tally = counts.length > 0 ? counts.join(', ') : 'no findings';
  return `${REPORT_HEADER} · ${VERDICT_LABEL[output.decision]} at ${headSha.slice(0, 7)} · ${tally}

${output.verdict}${output.report.trim() ? `\n\n${output.report.trim()}` : ''}`;
}

/** What the review's Session keeps from when it started: the operator's note and the baseline it compared with. */
export type ReviewStart = { note: string | null; base_branch: string | null; base_sha: string | null };

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
    @Inject(PrHostWrites) private readonly writes: PrHostWrites,
  ) {}

  async list(repoId: string, number: number): Promise<PrAgentReview[]> {
    const repo = this.pulls.hosted(repoId);
    const { pr } = await this.pulls.detail(repo, number);
    return this.store.db
      .select()
      .from(prAgentReviews)
      .where(and(eq(prAgentReviews.repoId, repoId), eq(prAgentReviews.prNumber, number)))
      .orderBy(desc(prAgentReviews.createdAt), desc(prAgentReviews.id))
      .all()
      .map((row) => toAgentReview(row, pr.head_sha));
  }

  /** A commit already reviewed is not reviewed again: its findings are on the host. */
  reviewed(repoId: string, number: number, headSha: string): boolean {
    return (
      this.store.db
        .select({ id: prAgentReviews.id })
        .from(prAgentReviews)
        .where(
          and(
            eq(prAgentReviews.repoId, repoId),
            eq(prAgentReviews.prNumber, number),
            eq(prAgentReviews.headSha, headSha),
          ),
        )
        .get() !== undefined
    );
  }

  /** The pull request's `pr_review` Session, which only answers the operator's replies in threads the agent started. */
  private threadSession(repoId: string, repoName: string, number: number): string {
    const existing = this.store.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.repoId, repoId), eq(sessions.prNumber, number), eq(sessions.kind, SessionKind.PrReview)))
      .get();
    if (existing) return existing.id;
    const created = this.sessions.create({ kind: SessionKind.PrReview, repoId, prNumber: number });
    this.sessions.update(created.id, { title: `${repoName} #${number} review` });
    return created.id;
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
    const session = this.threadSession(repoId, repo.name, number);
    // One answer at a time in this Session.
    while (this.runtime.busy(session)) await new Promise((resolve) => setTimeout(resolve, 1000));
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
      this.pulls.wrote(repoId, number);
      this.store.write((_tx, emit) =>
        emit('pull_request.commented', { repo_id: repoId, number, comment_id: posted.id, by_agent: true }),
      );
    } catch (error) {
      this.actionLog.finish(row, ActionOutcome.Failed, error instanceof Error ? error.message : 'post failed');
      throw error;
    }
  }

  /**
   * `submit_review`: posts each finding on its line and the summary as one comment, then records the review against
   * the commit the Session read. A finding the host refuses stays in the record with its error.
   */
  async submit(
    session: SessionRow,
    output: ReviewOutput,
    start: ReviewStart,
  ): Promise<{ posted: number; failed: number }> {
    const repo = this.pulls.repoRow(session.repoId as string);
    const number = session.prNumber as number;
    const headSha = session.prActionHeadSha as string;
    const slug = repo.remoteSlug as string;
    const adapter = this.pulls.adapter(repo);
    const reviewId = crypto.randomUUID();
    const earlier = await this.openAgentThreads(repo.id, number, slug);
    let posted = 0;
    // A few posts at a time: each is a host round trip. The findings keep the review's order.
    const findings = await mapLimit(output.findings, POST_PARALLEL, async (found): Promise<Finding> => {
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
        return finding;
      }
      const row = this.actionLog.start({
        sessionId: session.id,
        kind: ActionKind.Pr,
        target: `${slug}#${number}`,
        command: `comment on ${found.file && found.line ? `${found.file}:${found.line}` : 'the pull request'}`,
        isProd: false,
      });
      try {
        const comment = await adapter.postComment(slug, number, {
          body: findingText(found),
          head_sha: headSha,
          ...inline,
        });
        finding.comment_id = comment.id;
        posted++;
        this.actionLog.finish(row, ActionOutcome.Ok);
        this.store.write((tx, emit) => {
          tx.insert(agentComments)
            .values({ repoId: repo.id, prNumber: number, commentId: comment.id, agentReviewId: null })
            .run();
          emit('pull_request.commented', { repo_id: repo.id, number, comment_id: comment.id, by_agent: true });
        });
      } catch (error) {
        finding.post_error = error instanceof Error ? error.message : 'post failed';
        this.actionLog.finish(row, ActionOutcome.Failed, finding.post_error);
      }
      return finding;
    });
    const summaryPosted = await this.postSummary(session.id, repo, number, slug, headSha, output);
    this.pulls.wrote(repo.id, number);
    this.store.write((tx, emit) => {
      tx.insert(prAgentReviews)
        .values({
          id: reviewId,
          repoId: repo.id,
          prNumber: number,
          headSha,
          sessionId: session.id,
          decision: output.decision,
          verdict: output.verdict,
          baseBranch: start.base_branch,
          baseSha: start.base_sha,
          note: start.note,
          report: output.report.trim() || null,
          findings: JSON.stringify(findings),
        })
        .run();
      emit('pull_request.reviewed', {
        repo_id: repo.id,
        number,
        agent_review_id: reviewId,
        status: 'ready',
        posted,
        post_failed: findings.length - posted + (summaryPosted ? 0 : 1),
      });
    });
    return { posted, failed: findings.length - posted };
  }

  /** The verdict, counts and report as one comment on the pull request. A refused post leaves the review recorded. */
  private async postSummary(
    sessionId: string,
    repo: ReturnType<PullRequestsService['repoRow']>,
    number: number,
    slug: string,
    headSha: string,
    output: ReviewOutput,
  ): Promise<boolean> {
    const row = this.actionLog.start({
      sessionId,
      kind: ActionKind.Pr,
      target: `${slug}#${number}`,
      command: 'comment the review summary on the pull request',
      isProd: false,
    });
    try {
      const comment = await this.pulls
        .adapter(repo)
        .postComment(slug, number, { body: summaryText(output, headSha), head_sha: headSha });
      this.record(repo.id, number, comment.id, null);
      this.actionLog.finish(row, ActionOutcome.Ok);
      return true;
    } catch (error) {
      this.actionLog.finish(row, ActionOutcome.Failed, error instanceof Error ? error.message : 'post failed');
      return false;
    }
  }

  /** `file:line` to the id of an open thread the agent started there. A host that cannot be read gives none. */
  private async openAgentThreads(repoId: string, number: number, slug: string): Promise<Map<string, string>> {
    const ours = this.writes.agentCommentIds(repoId, number);
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
    return this.writes.agentCommentIds(repoId, number).has(commentId);
  }
}
