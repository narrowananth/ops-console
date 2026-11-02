import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AlertActor,
  AlertEventKind,
  AlertStatus,
  branchList,
  ConnectorId,
  ErrorCode,
  FIX_STAGES,
  type Fix,
  FixStage,
  FixStatus,
  GitHost,
  PlaybookStepStatus,
  PlaybookTrigger,
  PrState,
  SessionKind,
  SessionState,
  Severity,
} from '@ops-console/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { type RunSummary, STOPPED } from '../agent/runs';
import { AgentRuntime } from '../agent/runtime';
import { parseAgentJson } from '../common/agent-json';
import { ApiError } from '../common/errors';
import { StartupRecovery } from '../common/recovery';
import { ConnectorsService } from '../connectors/connectors.service';
import { alerts, fixes, reports, repos, reviews, routes, services, sessions } from '../db/schema';
import { type Emit, STORE, type Store, type Tx } from '../db/store';
import { CANCELLED, JobSteps, jobPlaybook } from '../playbooks/job-steps';
import { PlaybooksService } from '../playbooks/playbooks.service';
import { type CodeBase, cloneUrl, codeBaseStep, GIT, Git, GitFailed, parseRemote } from '../repos/git';
import { everyMinutes, Scheduler } from '../scheduler/scheduler';
import { AnonymousSessionsService } from '../workspace/anonymous-sessions.service';
import { PullRequestsService } from '../workspace/pull-requests.service';
import { WorkspaceSessionsService } from '../workspace/workspace-sessions.service';
import { AlertSessions } from './alert-sessions';
import { AlertsService } from './alerts.service';
import { type AlertRow, type FixRow, type ReportRow, type ReviewRow, type ServiceRow, toFix } from './mappers';

const ticketSchema = z.object({ key: z.string().min(1), url: z.string().min(1) });
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
  /** Set until the Fix's first agent turn, which starts a new conversation in the checkout (Behavior 26). */
  fresh: boolean;
};

/** Why a Fix has no ticket when its Playbook's Jira ticket switch is off. */
export const NO_TICKET_IN_PLAYBOOK = 'the Fix Playbook makes no Jira ticket';
@Injectable()
export class FixesService {
  private readonly logger = new Logger('monitor');
  private checking = false;
  /** Fixes being cancelled: their run starts no further stage, step or agent turn. */
  private readonly cancelling = new Set<string>();
  /** The run of each Fix going now, so Cancel can wait for it to end. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(AlertSessions) private readonly sessions: AlertSessions,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(WorkspaceSessionsService) private readonly workspace: WorkspaceSessionsService,
    @Inject(AnonymousSessionsService) private readonly anonymous: AnonymousSessionsService,
    @Inject(PullRequestsService) private readonly pulls: PullRequestsService,
    @Inject(GIT) private readonly git: Git,
    @Inject(PlaybooksService) private readonly playbooks: PlaybooksService,
    @Inject(JobSteps) private readonly steps: JobSteps,
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
    return this.view(this.row(id));
  }

  view(row: FixRow): Fix {
    return toFix(row, jobPlaybook(this.store.db, 'fix', row));
  }

  /** The Fix a confirmed Review starts, holding the copy of the Playbook Fix holds now (Behavior 13). */
  insert(tx: Tx, reviewId: string): FixRow {
    const copy = this.playbooks.copyFor(PlaybookTrigger.Fix);
    const row = tx
      .insert(fixes)
      .values({
        id: crypto.randomUUID(),
        reviewId,
        playbookId: copy.id,
        playbookName: copy.name,
        playbookRules: copy.rules,
        playbookBranches: copy.branches,
        playbookJiraTicket: copy.jiraTicket,
      })
      .returning()
      .get();
    this.steps.seed(tx, { kind: 'fix', id: row.id }, copy.steps);
    return row;
  }

  row(id: string): FixRow {
    const row = this.store.db.select().from(fixes).where(eq(fixes.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Fix');
    return row;
  }

  /** Runs in the background from the first stage; `fix.advanced` reports each step. */
  begin(fixId: string): void {
    this.detach(fixId, true);
  }

  retry(id: string, skip = false): Fix {
    const fix = this.row(id);
    if (fix.status !== FixStatus.Failed) throw new ApiError(409, ErrorCode.InvalidState, `the Fix is ${fix.status}`);
    if (skip && fix.stage !== FixStage.Steps) {
      throw new ApiError(409, ErrorCode.InvalidState, 'The Fix failed after its steps, so there is no step to skip');
    }
    // A Fix that failed before its first agent turn still owes the new conversation (Behavior 26).
    const unstarted =
      fix.jiraKey === null && this.steps.rows({ kind: 'fix', id }).every((step) => step.startedAt === null);
    const row = this.store.write((tx, emit) => {
      const updated = tx
        .update(fixes)
        .set({ status: FixStatus.Running, errorMessage: null, finishedAt: null })
        .where(eq(fixes.id, id))
        .returning()
        .get() as FixRow;
      if (skip) this.steps.skip(tx, emit, { kind: 'fix', id });
      if (updated.stage === FixStage.Steps) this.steps.reset(tx, emit, { kind: 'fix', id });
      this.announce(tx, emit, updated);
      return updated;
    });
    this.detach(id, unstarted);
    return this.view(row);
  }

  /** A run nobody awaits must not reject: a store closed by shutdown ends it, and recovery fails the Fix on the next start. */
  private detach(fixId: string, fresh: boolean): void {
    const going: Promise<void> = this.run(fixId, fresh)
      .catch((error) =>
        this.logger.warn(`fix ${fixId} stopped: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        if (this.running.get(fixId) === going) this.running.delete(fixId);
      });
    this.running.set(fixId, going);
  }

  /**
   * Cancels a running or failed Fix that has no pull request: stops its run, puts its uncommitted changes on the stash,
   * checks out the source branch, deletes the Fix branch, and takes the Alert back to `verified` for a new Review. The
   * Jira ticket, if any, is left as it is.
   */
  async cancel(id: string): Promise<Fix> {
    const fix = this.row(id);
    if (fix.prNumber !== null && fix.status !== FixStatus.Abandoned) {
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        'The Fix opened a pull request; close it on the Git host to abandon the Fix',
      );
    }
    if (fix.status !== FixStatus.Running && fix.status !== FixStatus.Failed) {
      throw new ApiError(409, ErrorCode.InvalidState, `the Fix is ${fix.status}`);
    }
    if (this.cancelling.has(id)) throw new ApiError(409, ErrorCode.InvalidState, 'The Fix is already being cancelled');
    const found = this.found(id);
    const place = this.placeOf(fix, found.service);
    this.cancelling.add(id);
    try {
      await this.halt(fix);
      const branch = place ? await this.restore(this.row(id), place) : null;
      const row = this.store.write((tx, emit) => {
        const now = new Date().toISOString();
        const updated = tx
          .update(fixes)
          .set({ status: FixStatus.Abandoned, finishedAt: now })
          .where(eq(fixes.id, id))
          .returning()
          .get() as FixRow;
        if (branch && place?.sessionId) {
          tx.update(sessions).set({ branch }).where(eq(sessions.id, place.sessionId)).run();
        }
        tx.update(reviews).set({ undoneAt: now }).where(eq(reviews.id, fix.reviewId)).run();
        this.alerts.transition(
          tx,
          found.alert.id,
          AlertStatus.Verified,
          AlertEventKind.Abandoned,
          AlertActor.Operator,
          {
            cancelled: true,
          },
        );
        this.announce(tx, emit, updated);
        emit('alert.reviewed', { alert_id: found.alert.id, decision: 'undone' });
        return updated;
      });
      return this.view(row);
    } finally {
      this.cancelling.delete(id);
    }
  }

  /** Stops the Fix's agent run until its run ends; a turn that starts between two checks is stopped on the next. */
  private async halt(fix: FixRow): Promise<void> {
    for (;;) {
      const going = this.running.get(fix.id);
      if (!going) return;
      const sessionId = this.row(fix.id).sessionId;
      if (sessionId && this.runtime.busy(sessionId)) this.runtime.stop(sessionId);
      await Promise.race([going, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
  }

  /**
   * Where the Fix's branch lives: the Session's clone, or the Service's Repo. Refused while another Session in that
   * Repo is running, since the checkout would move under it.
   */
  private placeOf(
    fix: FixRow,
    service: ServiceRow,
  ): { dir: string; fallback: string; sessionId: string | null } | null {
    const session = fix.sessionId
      ? this.store.db.select().from(sessions).where(eq(sessions.id, fix.sessionId)).get()
      : undefined;
    if (session?.kind === SessionKind.Anonymous) {
      return { dir: this.anonymous.folder(session.id), fallback: 'main', sessionId: session.id };
    }
    const source = this.sessions.sourceOf(service);
    if (source.kind !== 'repo') return null;
    const busy = this.store.db
      .select({ id: sessions.id, state: sessions.state })
      .from(sessions)
      .where(eq(sessions.repoId, source.repo.id))
      .all()
      .some(
        (row) =>
          row.id !== fix.sessionId &&
          (row.state === SessionState.Working || row.state === SessionState.WaitingApproval),
      );
    if (busy) {
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        'A Session in this Repo is running; stop it, then cancel the Fix',
      );
    }
    return { dir: source.repo.path, fallback: source.repo.defaultBranch, sessionId: session?.id ?? null };
  }

  /** Back to the source branch with the Fix's work on the stash; the branch the checkout is on after. */
  private async restore(fix: FixRow, place: { dir: string; fallback: string }): Promise<string | null> {
    if (!fix.branch) return null;
    const listed = branchList(fix.playbookBranches ?? '');
    try {
      let current = await this.git.currentBranch(place.dir);
      if (current === fix.branch) {
        if (await this.git.isDirty(place.dir)) {
          await this.git.stash(place.dir, `ops-console: cancelled Fix ${fix.branch}`);
        }
        const fallback = (await this.git.defaultBranch(place.dir)) ?? place.fallback;
        const base = await this.git.codeBase(place.dir, listed.length > 0 ? listed : [place.fallback, fallback]);
        await this.git.checkout(place.dir, base.branch, false);
        current = base.branch;
      }
      if ((await this.git.branches(place.dir)).some((candidate) => candidate.name === fix.branch)) {
        await this.git.deleteBranch(place.dir, fix.branch);
      }
      return current;
    } catch (error) {
      const message = error instanceof GitFailed && error.message ? error.message : 'git failed';
      throw new ApiError(
        502,
        ErrorCode.UpstreamFailed,
        `The Fix was stopped, but its branch was not undone: ${message}`,
      );
    }
  }

  private async run(fixId: string, fresh: boolean): Promise<void> {
    try {
      const context = await this.context(fixId, fresh);
      for (const stage of FIX_STAGES.slice(FIX_STAGES.indexOf(context.fix.stage))) {
        if (this.cancelling.has(fixId)) throw new StageFailed(CANCELLED);
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

  private found(fixId: string) {
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
    return found;
  }

  private async context(fixId: string, fresh: boolean): Promise<Context> {
    const found = this.found(fixId);
    const sessionId = await this.sessions.ensure(found.alert, found.service);
    if (found.fix.sessionId !== sessionId) {
      this.store.write((tx) => tx.update(fixes).set({ sessionId }).where(eq(fixes.id, fixId)).run());
    }
    return { ...found, sessionId, slug: found.report.slug ?? 'fix', fresh };
  }

  private async stage(stage: FixStage, context: Context): Promise<void> {
    if (stage === FixStage.Ticket) return this.ticket(context);
    if (stage === FixStage.Branch) return this.branch(context);
    if (stage === FixStage.Steps) {
      const failure = await this.steps.run({
        job: { kind: 'fix', id: context.fix.id },
        sessionId: context.sessionId,
        brief: `${this.brief(context)}\nThe console sends the work as steps, one per turn, on branch ${context.fix.branch}.`,
        rules: context.fix.playbookRules,
        fresh: this.takeFresh(context),
        halted: () => this.cancelling.has(context.fix.id),
      });
      if (failure) throw new StageFailed(failure);
      return;
    }
    return this.pullRequest(context);
  }

  private brief(context: Context): string {
    const jira = context.fix.jiraKey ? `Jira: ${context.fix.jiraKey}. ` : '';
    return `Fix for Alert "${context.alert.title}" on ${context.service.name}.
${jira}Root cause: ${context.report.rootCause}. Proposed fix: ${context.report.proposedFix}.`;
  }

  /** Jira is optional: with it the Fix makes a ticket and names the branch after its key. */
  private jiraUp(): boolean {
    try {
      this.connectors.require(ConnectorId.Jira);
      return true;
    } catch {
      return false;
    }
  }

  private takeFresh(context: Context): boolean {
    const fresh = context.fresh;
    context.fresh = false;
    return fresh;
  }

  /** One agent run in the Alert's Session; the answer must carry the stage's JSON. */
  private async ask<T extends z.ZodType>(context: Context, prompt: string, schema: T): Promise<z.infer<T>> {
    if (this.cancelling.has(context.fix.id)) throw new StageFailed(CANCELLED);
    let finished: Promise<RunSummary>;
    try {
      finished = this.runtime.runFor(context.sessionId, prompt, null, {
        rules: context.fix.playbookRules,
        fresh: this.takeFresh(context),
      }).finished;
    } catch (error) {
      throw new StageFailed(error instanceof Error ? error.message : 'the agent could not start');
    }
    const summary = await finished;
    if (!summary.ok) throw new StageFailed(summary.stopped ? STOPPED : 'the agent run failed');
    const parsed = parseAgentJson(summary.text, schema);
    if (!parsed) throw new StageFailed('the agent did not answer as asked');
    return parsed;
  }

  /**
   * The ticket exists after this stage, once: a retry finds the key and skips it (Behavior 22). With the Playbook's
   * Jira ticket switch off (the default), Jira not connected, or the ticket not made, there is no ticket and the
   * branch is `fix/<slug>`; the Fix goes on, and keeps why. Only the operator's Stop fails the stage.
   */
  private async ticket(context: Context): Promise<void> {
    if (context.fix.jiraKey || context.fix.branch) return;
    if (!context.fix.playbookJiraTicket) return this.noTicket(context, NO_TICKET_IN_PLAYBOOK);
    if (!this.jiraUp()) return this.noTicket(context, null);
    try {
      await this.createTicket(context);
    } catch (error) {
      if (error instanceof StageFailed && (error.message === STOPPED || error.message === CANCELLED)) throw error;
      const reason = error instanceof Error && error.message ? error.message : 'Jira failed';
      this.logger.warn(`fix ${context.fix.id} goes on without a ticket: ${reason}`);
      this.noTicket(context, reason);
    }
  }

  private noTicket(context: Context, reason: string | null): void {
    const branch = `fix/${context.slug}`;
    this.store.write((tx, emit) => {
      const row = tx
        .update(fixes)
        .set({ branch, ticketSkipped: reason?.slice(0, 500) ?? null })
        .where(eq(fixes.id, context.fix.id))
        .returning()
        .get() as FixRow;
      this.announce(tx, emit, row);
    });
    context.fix = this.row(context.fix.id);
  }

  private async createTicket(context: Context): Promise<void> {
    const jira = (await this.connectors.get(ConnectorId.Jira)).config as {
      project_key: string;
      issue_types: { bug: string; improvement: string };
    };
    const kind = context.review.kind ?? 'bug';
    const issueType = jira.issue_types[kind];
    const priority = context.alert.severity === Severity.High ? 'High' : 'Medium';
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
    const session = this.store.db.select().from(sessions).where(eq(sessions.id, context.sessionId)).get();
    if (session?.kind === SessionKind.Anonymous) {
      const dir = this.anonymous.folder(context.sessionId);
      const exists = (await this.git.branches(dir)).some((candidate) => candidate.name === branch);
      const base = exists ? null : await this.base(context, dir, (await this.git.defaultBranch(dir)) ?? 'main');
      await this.anonymous.checkout(context.sessionId, branch, base?.sha);
      return;
    }
    const source = this.sessions.sourceOf(context.service);
    if (source.kind !== 'repo') throw new StageFailed('the Fix Session lost its Repo');
    const exists = (await this.git.branches(source.repo.path)).some((candidate) => candidate.name === branch);
    const base = exists ? null : await this.base(context, source.repo.path, source.repo.defaultBranch);
    await this.workspace.checkout(context.sessionId, branch, !exists, base?.sha);
  }

  /**
   * A new Fix branch starts from the newest commit of the first branch in the Playbook's Branch field that origin
   * has, the Repo's default branch when blank; the local branch stands in when origin cannot be reached.
   */
  private async base(context: Context, dir: string, fallback: string): Promise<CodeBase> {
    const listed = branchList(context.fix.playbookBranches ?? '');
    try {
      const base = await this.git.codeBase(dir, listed.length > 0 ? listed : [fallback]);
      this.logger.log(`fix ${context.fix.id} branches from ${codeBaseStep(base)}`);
      return base;
    } catch (error) {
      throw new StageFailed(error instanceof GitFailed && error.message ? error.message : 'git failed');
    }
  }

  private async pullRequest(context: Context): Promise<void> {
    const key = context.fix.jiraKey;
    const prefix = key ? `${key}: ` : '';
    let fix = this.row(context.fix.id);
    if (fix.prNumber === null) {
      const opened = await this.ask(
        context,
        `${this.brief(context)}\n\nCommit the work${key ? ` with a message that starts with "${key}:"` : ''}, push branch ${fix.branch} to origin, and open a pull request on origin's Git host titled "${prefix}${context.alert.title}": gh for GitHub, glab for GitLab, the Bitbucket MCP server or API for Bitbucket. Never merge it.\n\n${this.prMaterial(context, fix)}\n\n${JSON_ONLY}\n\n\`\`\`json\n{ "number": 123, "url": "https://github.com/owner/repo/pull/123" }\n\`\`\``,
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
    if (key) {
      const jira = (await this.connectors.get(ConnectorId.Jira)).config as { in_review_status: string };
      await this.ask(
        context,
        `Move Jira issue ${key} to "${jira.in_review_status}" through the Atlassian MCP server and link ${fix.prUrl} on it. Change nothing else. ${JSON_ONLY}\n\n\`\`\`json\n{ "ok": true }\n\`\`\``,
        okSchema,
      );
    }
    this.store.write((tx, emit) => {
      this.alerts.transition(tx, context.alert.id, AlertStatus.PrOpen, AlertEventKind.PrOpened, AlertActor.Agent, {
        pr_number: fix.prNumber,
        pr_url: fix.prUrl,
      });
      this.announce(tx, emit, fix);
    });
    if (context.service.repoId) this.pulls.drop(context.service.repoId);
  }

  /** What the pull request's description is written from: the Report, the steps' results and the links. */
  private prMaterial(context: Context, fix: FixRow): string {
    const steps = this.steps
      .rows({ kind: 'fix', id: fix.id })
      .map(
        (step) =>
          `- ${step.title}: ${step.summary ?? 'no summary'}${step.status === PlaybookStepStatus.Done ? '' : ` (${step.status})`}`,
      );
    const links = [
      fix.jiraUrl && `- Jira: ${fix.jiraUrl}`,
      `- Alert: "${context.alert.title}" on ${context.service.name}`,
    ];
    return `Write the description by the console's pull request description rule, in depth, from this material and from the diff of the branch.

The Report:
${context.report.markdown ?? `Root cause: ${context.report.rootCause}. Proposed fix: ${context.report.proposedFix}.`}

The Fix's steps and what each found or did:
${steps.join('\n') || '- none'}

Links:
${links.filter(Boolean).join('\n')}`;
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
        .select({ fix: fixes, alert: alerts, service: services, repo: repos })
        .from(fixes)
        .innerJoin(reviews, eq(reviews.id, fixes.reviewId))
        .innerJoin(reports, eq(reports.id, reviews.reportId))
        .innerJoin(alerts, eq(alerts.id, reports.alertId))
        .innerJoin(routes, eq(routes.id, alerts.routeId))
        .innerJoin(services, eq(services.id, routes.serviceId))
        .leftJoin(repos, eq(repos.id, services.repoId))
        .where(and(eq(alerts.status, AlertStatus.PrOpen), isNull(reviews.undoneAt)))
        .all();
      for (const { fix, alert, service, repo } of open) {
        // A Fix made in a clone has no Repo: its host and slug come from the Service's Git URL.
        const remote = repo
          ? { host: repo.host, slug: repo.remoteSlug }
          : parseRemote(service.repoUrl ? cloneUrl(service.repoUrl) : null);
        if (fix.prNumber === null || remote.slug === null || remote.host === GitHost.Local) continue;
        const adapter = this.pulls.adapterFor(remote.host);
        if (!adapter) continue;
        try {
          const { pr } = await adapter.get(remote.slug, fix.prNumber);
          if (pr.state === PrState.Merged) this.resolve(fix, alert);
          else if (pr.state === PrState.Closed) this.abandon(fix, alert);
        } catch (error) {
          this.logger.warn(
            `PR ${remote.slug}#${fix.prNumber} not read: ${error instanceof Error ? error.message : String(error)}`,
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
