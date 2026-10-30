import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AlertActor,
  AlertEventKind,
  AlertStatus,
  ConnectorId,
  ErrorCode,
  FIX_STAGES,
  type Fix,
  FixStage,
  FixStatus,
  PrState,
  Severity,
} from '@ops-console/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { AgentRuntime } from '../agent/runtime';
import { ApiError } from '../common/errors';
import { StartupRecovery } from '../common/recovery';
import { ConnectorsService } from '../connectors/connectors.service';
import { alerts, fixes, reports, repos, reviews, routes, services } from '../db/schema';
import { type Emit, STORE, type Store, type Tx } from '../db/store';
import { GIT, Git } from '../repos/git';
import { everyMinutes, Scheduler } from '../scheduler/scheduler';
import { PullRequestsService } from '../workspace/pull-requests.service';
import { WorkspaceSessionsService } from '../workspace/workspace-sessions.service';
import { parseAgentJson } from './agent-json';
import { AlertSessions } from './alert-sessions';
import { AlertsService } from './alerts.service';
import { type AlertRow, type FixRow, type ReportRow, type ReviewRow, type ServiceRow, toFix } from './mappers';

const ticketSchema = z.object({ key: z.string().min(1), url: z.string().min(1) });
const doneSchema = z.object({ summary: z.string() });
const testsSchema = z.object({ passed: z.boolean(), summary: z.string() });
const prSchema = z.object({ number: z.number().int(), url: z.string().min(1) });
const okSchema = z.object({ ok: z.literal(true) });

const JSON_ONLY = 'Answer with one JSON block and nothing after it.';

/** A stage's failure: it names what went wrong; the Fix stays at that stage for a retry. */
class StageFailed extends Error {}

type Context = {
  fix: FixRow;
  alert: AlertRow;
  service: ServiceRow;
  report: ReportRow;
  review: ReviewRow;
  sessionId: string;
  slug: string;
};

@Injectable()
export class FixesService {
  private readonly logger = new Logger('monitor');
  private checking = false;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(AlertSessions) private readonly sessions: AlertSessions,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(WorkspaceSessionsService) private readonly workspace: WorkspaceSessionsService,
    @Inject(PullRequestsService) private readonly pulls: PullRequestsService,
    @Inject(GIT) private readonly git: Git,
    @Inject(Scheduler) scheduler: Scheduler,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('monitor fixes', () => this.recover());
    scheduler.register({
      name: 'monitor-pr-watch',
      nextSlot: everyMinutes(5),
      run: () => this.checkPullRequests(),
      lastRunAt: () => null,
    });
    this.pulls.onRefreshed(() => void this.checkPullRequests());
  }

  get(id: string): Fix {
    return toFix(this.row(id));
  }

  row(id: string): FixRow {
    const row = this.store.db.select().from(fixes).where(eq(fixes.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Fix');
    return row;
  }

  /** Runs in the background from the first stage; `fix.advanced` reports each step. */
  begin(fixId: string): void {
    this.detach(fixId);
  }

  retry(id: string): Fix {
    const fix = this.row(id);
    if (fix.status !== FixStatus.Failed) throw new ApiError(409, ErrorCode.InvalidState, `the Fix is ${fix.status}`);
    const row = this.store.write((tx, emit) => {
      const updated = tx
        .update(fixes)
        .set({ status: FixStatus.Running, errorMessage: null, finishedAt: null })
        .where(eq(fixes.id, id))
        .returning()
        .get() as FixRow;
      this.announce(tx, emit, updated);
      return updated;
    });
    this.detach(id);
    return toFix(row);
  }

  /** A run nobody awaits must not reject: a store closed by shutdown ends it, and recovery fails the Fix on the next start. */
  private detach(fixId: string): void {
    void this.run(fixId).catch((error) =>
      this.logger.warn(`fix ${fixId} stopped: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  private async run(fixId: string): Promise<void> {
    try {
      const context = await this.context(fixId);
      for (const stage of FIX_STAGES.slice(FIX_STAGES.indexOf(context.fix.stage))) {
        this.setStage(fixId, stage);
        await this.stage(stage, context);
      }
      this.finishFix(fixId);
    } catch (error) {
      const message = error instanceof StageFailed || error instanceof ApiError ? error.message : 'the Fix failed';
      if (!(error instanceof StageFailed || error instanceof ApiError)) {
        this.logger.error(`fix ${fixId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.fail(fixId, message);
    }
  }

  private async context(fixId: string): Promise<Context> {
    const found = this.store.db
      .select({ fix: fixes, alert: alerts, report: reports, review: reviews, service: services })
      .from(fixes)
      .innerJoin(reviews, eq(reviews.id, fixes.reviewId))
      .innerJoin(reports, eq(reports.id, reviews.reportId))
      .innerJoin(alerts, eq(alerts.id, reports.alertId))
      .innerJoin(routes, eq(routes.id, alerts.routeId))
      .innerJoin(services, eq(services.id, routes.serviceId))
      .where(eq(fixes.id, fixId))
      .get();
    if (!found) throw new StageFailed('the Fix lost its Alert');
    const sessionId = await this.sessions.ensure(found.alert, found.service);
    if (found.fix.sessionId !== sessionId) {
      this.store.write((tx) => tx.update(fixes).set({ sessionId }).where(eq(fixes.id, fixId)).run());
    }
    return { ...found, sessionId, slug: found.report.slug ?? 'fix' };
  }

  private async stage(stage: FixStage, context: Context): Promise<void> {
    if (stage === FixStage.Ticket) return this.ticket(context);
    if (stage === FixStage.Branch) return this.branch(context);
    if (stage === FixStage.Code) {
      await this.ask(
        context,
        `${this.brief(context)}\n\nImplement the proposed fix on the current branch. Keep the change small and add or update a test. Do not commit and do not push. ${JSON_ONLY}\n\n\`\`\`json\n{ "summary": "what you changed" }\n\`\`\``,
        doneSchema,
      );
      return;
    }
    if (stage === FixStage.Tests) {
      const result = await this.ask(
        context,
        `Run the repo's tests that cover this change, and fix what you broke. ${JSON_ONLY}\n\n\`\`\`json\n{ "passed": true, "summary": "what ran and how it ended" }\n\`\`\``,
        testsSchema,
      );
      if (!result.passed) throw new StageFailed(`tests failed: ${result.summary}`.slice(0, 500));
      return;
    }
    return this.pullRequest(context);
  }

  private brief(context: Context): string {
    return `Fix for Alert "${context.alert.title}" on ${context.service.name}.
Jira: ${context.fix.jiraKey ?? '(none yet)'}. Root cause: ${context.report.rootCause}. Proposed fix: ${context.report.proposedFix}.`;
  }

  /** One agent run in the Alert's Session; the answer must carry the stage's JSON. */
  private async ask<T extends z.ZodType>(context: Context, prompt: string, schema: T): Promise<z.infer<T>> {
    let finished: Promise<{ ok: boolean; text: string }>;
    try {
      finished = this.runtime.runFor(context.sessionId, prompt).finished;
    } catch (error) {
      throw new StageFailed(error instanceof Error ? error.message : 'the agent could not start');
    }
    const summary = await finished;
    if (!summary.ok) throw new StageFailed('the agent run failed');
    const parsed = parseAgentJson(summary.text, schema);
    if (!parsed) throw new StageFailed('the agent did not answer as asked');
    return parsed;
  }

  /** The ticket exists after this stage, once: a retry finds the key and skips it (Behavior 22). */
  private async ticket(context: Context): Promise<void> {
    if (context.fix.jiraKey) return;
    const jira = (await this.connectors.get(ConnectorId.Jira)).config as {
      project_key: string;
      issue_types: { bug: string; improvement: string };
    };
    const kind = context.review.kind ?? 'bug';
    const issueType = jira.issue_types[kind];
    const priority = context.alert.severity === Severity.Sev2 ? 'High' : 'Medium';
    const created = await this.ask(
      context,
      `Create a Jira issue through the Atlassian MCP server. Project ${jira.project_key}, issue type "${issueType}", priority ${priority}, summary "${context.alert.title}". Put this Report in the description:

${context.report.markdown ?? context.report.rootCause}

Change nothing else. ${JSON_ONLY}

\`\`\`json
{ "key": "ABC-123", "url": "https://example.atlassian.net/browse/ABC-123" }
\`\`\``,
      ticketSchema,
    );
    const branch = `${created.key}-${context.slug}`;
    this.store.write((tx, emit) => {
      const row = tx
        .update(fixes)
        .set({ jiraKey: created.key, jiraUrl: created.url, branch })
        .where(eq(fixes.id, context.fix.id))
        .returning()
        .get() as FixRow;
      this.alerts.record(tx, context.alert.id, AlertEventKind.TicketCreated, AlertActor.Agent, {
        jira_key: created.key,
        jira_url: created.url,
      });
      this.announce(tx, emit, row);
    });
    context.fix = this.row(context.fix.id);
  }

  private async branch(context: Context): Promise<void> {
    const branch = context.fix.branch;
    if (!branch) throw new StageFailed('the Fix has no branch name');
    const repo = this.sessions.repoOf(context.service);
    const exists = (await this.git.branches(repo.path)).some((candidate) => candidate.name === branch);
    await this.workspace.checkout(context.sessionId, branch, !exists);
  }

  private async pullRequest(context: Context): Promise<void> {
    const key = context.fix.jiraKey as string;
    let fix = this.row(context.fix.id);
    if (fix.prNumber === null) {
      const opened = await this.ask(
        context,
        `${this.brief(context)}\n\nCommit the work with a message that starts with "${key}:", push the branch, and open a pull request with the gh CLI titled "${key}: ${context.alert.title}". Link ${fix.jiraUrl} and summarize the Report in its description. Never merge it. ${JSON_ONLY}\n\n\`\`\`json\n{ "number": 123, "url": "https://github.com/owner/repo/pull/123" }\n\`\`\``,
        prSchema,
      );
      fix = this.store.write(
        (tx) =>
          tx
            .update(fixes)
            .set({ prNumber: opened.number, prUrl: opened.url })
            .where(eq(fixes.id, fix.id))
            .returning()
            .get() as FixRow,
      );
    }
    const jira = (await this.connectors.get(ConnectorId.Jira)).config as { in_review_status: string };
    await this.ask(
      context,
      `Move Jira issue ${key} to "${jira.in_review_status}" through the Atlassian MCP server and link ${fix.prUrl} on it. Change nothing else. ${JSON_ONLY}\n\n\`\`\`json\n{ "ok": true }\n\`\`\``,
      okSchema,
    );
    this.store.write((tx, emit) => {
      this.alerts.transition(tx, context.alert.id, AlertStatus.PrOpen, AlertEventKind.PrOpened, AlertActor.Agent, {
        pr_number: fix.prNumber,
        pr_url: fix.prUrl,
      });
      this.announce(tx, emit, fix);
    });
    this.pulls.drop(context.service.repoId as string);
  }

  private setStage(fixId: string, stage: FixStage): void {
    this.store.write((tx, emit) => {
      const current = tx.select().from(fixes).where(eq(fixes.id, fixId)).get() as FixRow;
      const row = tx.update(fixes).set({ stage }).where(eq(fixes.id, fixId)).returning().get() as FixRow;
      if (current.stage !== stage) {
        const alertId = this.alertOf(tx, fixId);
        this.alerts.record(tx, alertId, AlertEventKind.FixAdvanced, AlertActor.Agent, { stage });
      }
      this.announce(tx, emit, row);
    });
  }

  private finishFix(fixId: string): void {
    this.store.write((tx, emit) => {
      const row = tx
        .update(fixes)
        .set({ status: FixStatus.Done, finishedAt: new Date().toISOString() })
        .where(eq(fixes.id, fixId))
        .returning()
        .get() as FixRow;
      this.announce(tx, emit, row);
    });
  }

  private fail(fixId: string, message: string): void {
    this.store.write((tx, emit) => {
      const row = tx
        .update(fixes)
        .set({ status: FixStatus.Failed, errorMessage: message.slice(0, 500), finishedAt: new Date().toISOString() })
        .where(eq(fixes.id, fixId))
        .returning()
        .get();
      if (row) this.announce(tx, emit, row);
    });
  }

  private alertOf(tx: Tx, fixId: string): string {
    const found = tx
      .select({ id: reports.alertId })
      .from(fixes)
      .innerJoin(reviews, eq(reviews.id, fixes.reviewId))
      .innerJoin(reports, eq(reports.id, reviews.reportId))
      .where(eq(fixes.id, fixId))
      .get();
    return (found as { id: string }).id;
  }

  private announce(tx: Tx, emit: Emit, fix: FixRow): void {
    emit('fix.advanced', {
      fix_id: fix.id,
      alert_id: this.alertOf(tx, fix.id),
      stage: fix.stage,
      status: fix.status,
      jira_key: fix.jiraKey,
      pr_number: fix.prNumber,
    });
  }

  /** Reads the PR of every `pr_open` Fix: merged resolves the Alert, closed unmerged abandons the Fix (Behavior 24). */
  async checkPullRequests(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const open = this.store.db
        .select({ fix: fixes, alert: alerts, repo: repos })
        .from(fixes)
        .innerJoin(reviews, eq(reviews.id, fixes.reviewId))
        .innerJoin(reports, eq(reports.id, reviews.reportId))
        .innerJoin(alerts, eq(alerts.id, reports.alertId))
        .innerJoin(routes, eq(routes.id, alerts.routeId))
        .innerJoin(services, eq(services.id, routes.serviceId))
        .innerJoin(repos, eq(repos.id, services.repoId))
        .where(and(eq(alerts.status, AlertStatus.PrOpen), isNull(reviews.undoneAt)))
        .all();
      for (const { fix, alert, repo } of open) {
        if (fix.prNumber === null || repo.remoteSlug === null) continue;
        try {
          const { pr } = await this.pulls.adapter(repo).get(repo.remoteSlug, fix.prNumber);
          if (pr.state === PrState.Merged) this.resolve(fix, alert);
          else if (pr.state === PrState.Closed) this.abandon(fix, alert);
        } catch (error) {
          this.logger.warn(
            `PR ${repo.name}#${fix.prNumber} not read: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      this.checking = false;
    }
  }

  private resolve(fix: FixRow, alert: AlertRow): void {
    this.store.write((tx, emit) => {
      this.alerts.transition(
        tx,
        alert.id,
        AlertStatus.Resolved,
        AlertEventKind.Resolved,
        AlertActor.Operator,
        {
          pr_number: fix.prNumber,
        },
        { resolvedAt: new Date().toISOString() },
      );
      emit('alert.resolved', { alert_id: alert.id });
    });
  }

  private abandon(fix: FixRow, alert: AlertRow): void {
    const now = new Date().toISOString();
    this.store.write((tx, emit) => {
      const row = tx
        .update(fixes)
        .set({ status: FixStatus.Abandoned, finishedAt: now })
        .where(eq(fixes.id, fix.id))
        .returning()
        .get() as FixRow;
      tx.update(reviews).set({ undoneAt: now }).where(eq(reviews.id, fix.reviewId)).run();
      this.alerts.transition(tx, alert.id, AlertStatus.Verified, AlertEventKind.Abandoned, AlertActor.Operator, {
        pr_number: fix.prNumber,
      });
      this.announce(tx, emit, row);
      emit('alert.reviewed', { alert_id: alert.id, decision: 'undone' });
    });
  }

  /** Start-up recovery: a Fix left `running` failed at its stage (Behavior 26). */
  private recover(): void {
    for (const fix of this.store.db.select().from(fixes).where(eq(fixes.status, FixStatus.Running)).all()) {
      this.fail(fix.id, 'interrupted');
    }
  }
}
