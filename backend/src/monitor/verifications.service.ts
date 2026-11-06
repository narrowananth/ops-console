import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AlertActor,
  AlertEventKind,
  AlertStatus,
  branchList,
  ErrorCode,
  type Part,
  PlaybookTrigger,
  type Report,
  ReportKind,
  type ReportStep,
  RunPurpose,
  RunStatus,
  stepSchema,
} from '@ops-console/shared';
import { and, desc, eq, isNotNull, max, ne } from 'drizzle-orm';
import { z } from 'zod';
import { redact } from '../action-log/redact';
import { failedBecause, type RunSummary } from '../agent/runs';
import { AgentRuntime } from '../agent/runtime';
import { parseAgentJson } from '../common/agent-json';
import { DATA_DIR } from '../common/data-dir';
import { ApiError } from '../common/errors';
import { StartupRecovery } from '../common/recovery';
import { reports, routes, services } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { JobSteps, jobPlaybook } from '../playbooks/job-steps';
import { PlaybooksService } from '../playbooks/playbooks.service';
import { parseSkillCopies, skillCopiesJson } from '../playbooks/skills.service';
import { type CodeBase, codeBaseStep, GIT, Git, GitFailed } from '../repos/git';
import { AnonymousSessionsService } from '../workspace/anonymous-sessions.service';
import { AlertSessions, type CodeSource } from './alert-sessions';
import { AlertsService } from './alerts.service';
import { DATADOG_READER, type DatadogReader } from './datadog';
import { type AlertRow, type ReportRow, type RouteRow, type ServiceRow, samplesOf, toReport } from './mappers';
import { deployedVersion, PROD_PARITY_ASK, recheck, versionStep } from './prod-parity';
import { ScansService } from './scans.service';

const outputSchema = z.object({
  kind: z.enum(ReportKind),
  slug: z.string().min(1),
  root_cause: z.string().min(1),
  proposed_fix: z.string().min(1),
  replay: z.object({ request: z.string(), response: z.string() }).nullish(),
  diff: z.array(z.object({ sign: z.enum(['+', '-', ' ']), text: z.string() })).nullish(),
  markdown: z.string().nullish(),
});

/** The fix branch ends with this: lowercase words, no path tricks. */
export function cleanSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** What the agent is told about the Alert before its first step: its logs and where the code is. */
export function verificationBrief(
  alert: AlertRow,
  service: ServiceRow,
  route: RouteRow,
  source: CodeSource,
  base: CodeBase | null = null,
  recheckLine: string | null = null,
): string {
  const samples = samplesOf(alert)
    .slice(0, 5)
    .map((sample) => `- ${sample.timestamp} ${sample.status}: ${sample.message}`)
    .join('\n');
  const copied = source.kind === 'repo' ? `the local Repo ${source.name}` : `a fresh clone of ${source.name}`;
  const at = base ? ` at ${base.ref}, commit ${base.sha.slice(0, 12)}` : '';
  const where = `this folder, a scratch copy of ${copied}${at}`;
  const behind =
    base && !base.fetched
      ? `\nThe console could not fetch ${base.branch} from origin (${base.error ?? 'no reason given'}), so this is the local branch and may be behind production. Say so in the Report.\n`
      : '';
  const what = route.method ? `route ${route.method} ${route.path}` : 'logs with no HTTP route';
  return `Find the cause of a failure Datadog logged, in the code in ${where}. The console throws this folder away afterwards: write files and run local commands here only when a step allows it.

Alert: ${alert.title}
Service: ${service.name} (${service.env}); ${what}
Events: ${alert.eventCount} since ${alert.firstSeenAt}; Datadog query: ${alert.datadogQuery}${recheckLine ? `\n${recheckLine}` : ''}

Newest log lines:
${samples}
${behind}
The console sends the work as steps, one per turn.`;
}

/** The console's closing turn: the Report, in the shape the Monitor stores. */
export const REPORT_PROMPT = `Write the Report on this Alert from what you found. Change no file in this turn. Answer with one JSON block and nothing after it:

\`\`\`json
{
  "kind": "bug | improvement",
  "slug": "short-kebab-name",
  "root_cause": "what is wrong, in plain words, with file:line",
  "proposed_fix": "what to change and where",
  "replay": { "request": "curl command", "response": "status and body, secrets removed" },
  "diff": [{ "sign": "+ | - | space", "text": "line" }],
  "markdown": "the full Report as Markdown, in the sections listed below"
}
\`\`\`

"replay" and "diff" may be null. The Markdown has these sections, in order: Issue summary (what happens, the observed behaviour); Datadog evidence (log lines, timestamps, trace IDs, error details); Affected services (which service writes the error, which consume the logic); Root cause; Code-level findings (repository, file:line, classes, methods, execution flow); Timeline (when it started and changes around then, where evidence exists); Blast radius (services, APIs, platforms, integrations, user impact); Consumer analysis (mobile, web, internal APIs, background work); Database findings (read only); External dependency findings (Shopify and other third parties); Reproduction and validation (mocks, scenarios, results); Existing PR verification (related pull requests and earlier fixes); Recommended stable fix (exact changes and why this approach); Regression risks and test plan; Prod parity (${PROD_PARITY_ASK}); Final conclusion (confirmed root cause, scope, next action). Mark each finding as verified, mocked or unverified.`;

function stepOf(part: Part): ReportStep | null {
  if (part.kind === 'step') return { kind: part.text.startsWith('$ ') ? 'command' : 'step', text: part.text };
  if (part.kind === 'text') return { kind: 'step', text: part.text.slice(0, 500) };
  return null;
}

function toMarkdown(alert: AlertRow, output: z.infer<typeof outputSchema>): string {
  return `# ${alert.title}\n\n**Kind:** ${output.kind}\n\n## Root cause\n\n${output.root_cause}\n\n## Proposed fix\n\n${output.proposed_fix}\n`;
}

/** A failure that ends the Verification with its own message. */
class VerificationFailed extends Error {}

@Injectable()
export class VerificationsService {
  private readonly logger = new Logger('monitor');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(GIT) private readonly git: Git,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(AlertSessions) private readonly sessions: AlertSessions,
    @Inject(AnonymousSessionsService) private readonly anonymous: AnonymousSessionsService,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(PlaybooksService) private readonly playbooks: PlaybooksService,
    @Inject(JobSteps) private readonly steps: JobSteps,
    @Inject(ScansService) private readonly scans: ScansService,
    @Inject(DATADOG_READER) private readonly datadog: DatadogReader,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('monitor verifications', () => this.recover());
  }

  /**
   * Answers with the Report in `running`, holding the copy of the Playbook Verify holds now. The clone, the scratch
   * copy and the steps go on in the background; `alert.verified` reports the end.
   */
  async start(alertId: string): Promise<Report> {
    const alert = this.alerts.row(alertId);
    this.alerts.requireStatus(alert, AlertStatus.Open, AlertStatus.Verified);
    const { service } = this.serviceOf(alert);
    // A Service with neither a Repo nor a Git URL is refused before a Report exists.
    this.sessions.sourceOf(service);
    const copy = this.playbooks.copyFor(PlaybookTrigger.Verify);
    const reportId = crypto.randomUUID();
    const row = this.store.write((tx) => {
      const version =
        (tx
          .select({ v: max(reports.version) })
          .from(reports)
          .where(eq(reports.alertId, alertId))
          .get()?.v ?? 0) + 1;
      const created = tx
        .insert(reports)
        .values({
          id: reportId,
          alertId,
          version,
          playbookId: copy.id,
          playbookName: copy.name,
          playbookRules: copy.rules,
          playbookSkills: skillCopiesJson(copy.skills),
          playbookBranches: copy.branches,
        })
        .returning()
        .get();
      this.steps.seed(tx, { kind: 'report', id: reportId }, copy.steps);
      this.alerts.transition(
        tx,
        alertId,
        AlertStatus.Verifying,
        AlertEventKind.VerificationStarted,
        AlertActor.Operator,
        { report_id: reportId, version },
      );
      return created;
    });
    this.detach(reportId, alert, false);
    return toReport(row, jobPlaybook(this.store.db, 'report', row));
  }

  /** Runs a failed Report again from its failed step, in its scratch copy, into the same version (Behavior 17). */
  retry(reportId: string, skip = false): Report {
    const report = this.store.db.select().from(reports).where(eq(reports.id, reportId)).get();
    if (!report) throw new ApiError(404, ErrorCode.NotFound, 'no such Report');
    const newest = this.store.db
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.alertId, report.alertId))
      .orderBy(desc(reports.version))
      .get();
    if (report.status !== RunStatus.Failed || newest?.id !== report.id || !report.scratchPath) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Only the newest failed Report with its scratch copy can retry');
    }
    const alert = this.alerts.row(report.alertId);
    const row = this.store.write((tx, emit) => {
      const updated = tx
        .update(reports)
        .set({ status: RunStatus.Running, errorMessage: null, startedAt: new Date().toISOString(), finishedAt: null })
        .where(eq(reports.id, reportId))
        .returning()
        .get() as ReportRow;
      if (skip) this.steps.skip(tx, emit, { kind: 'report', id: reportId });
      this.steps.reset(tx, emit, { kind: 'report', id: reportId });
      this.alerts.transition(
        tx,
        alert.id,
        AlertStatus.Verifying,
        AlertEventKind.VerificationStarted,
        AlertActor.Operator,
        { report_id: reportId, version: report.version, retry: true },
      );
      return updated;
    });
    this.detach(reportId, alert, true);
    return toReport(row, jobPlaybook(this.store.db, 'report', row));
  }

  private detach(reportId: string, alert: AlertRow, retry: boolean): void {
    void this.execute(reportId, alert, retry).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof VerificationFailed)) this.logger.warn(`verification ${reportId} failed: ${message}`);
      this.fail(reportId, alert.id, message.slice(0, 600));
    });
  }

  private async execute(reportId: string, alert: AlertRow, retry: boolean): Promise<void> {
    const { service, route } = this.serviceOf(alert);
    const source = this.sessions.sourceOf(service);
    const report = this.store.db.select().from(reports).where(eq(reports.id, reportId)).get() as ReportRow;
    const reportSteps: ReportStep[] = z.array(stepSchema).parse(JSON.parse(report.steps));
    const onPart = (part: Part) => this.step(reportId, reportSteps, part);
    // Before the Session and the scratch copy, so it is the first step the operator reads (Behavior 7).
    const checked = await recheck(this.datadog, alert.datadogQuery);
    this.addStep(reportId, reportSteps, checked.step);
    const sessionId = await this.sessions.ensure(alert, service, (text) => onPart({ kind: 'step', text }));
    const made = retry ? null : await this.makeScratch(report, source, sessionId, onPart);
    const scratch = made?.dir ?? (report.scratchPath as string);
    const job = { kind: 'report', id: reportId } as const;
    const hasSteps = this.steps.rows(job).length > 0;
    const rules = report.playbookRules;
    const skills = parseSkillCopies(report.playbookSkills);
    if (made)
      this.addStep(
        reportId,
        reportSteps,
        versionStep(deployedVersion(samplesOf(alert)), made.base.sha, made.base.branch),
      );
    const brief = verificationBrief(alert, service, route, source, made?.base ?? null, checked.line);
    const failure = await this.steps.run({ job, sessionId, brief, rules, skills, cwd: scratch, fresh: !retry, onPart });
    if (failure) throw new VerificationFailed(failure);
    const closing = hasSteps || retry ? REPORT_PROMPT : `${brief}\n\n${REPORT_PROMPT}`;
    const summary = await this.runtime.runFor(sessionId, closing, onPart, {
      cwd: scratch,
      rules,
      skills,
      fresh: !retry && !hasSteps,
      purpose: RunPurpose.Verify,
    }).finished;
    await this.complete(reportId, alert, summary);
  }

  /**
   * A git worktree of the code, in the data directory, at the newest commit of the first branch in the Playbook's
   * Branch field that origin has: the Repo's default branch when the field is blank. When origin cannot be reached the
   * local branch stands in, and the Report says so. Earlier Reports' copies go first (Behavior 25). The operator's
   * checkout keeps its branch and uncommitted work.
   */
  private async makeScratch(
    report: ReportRow,
    source: CodeSource,
    sessionId: string,
    onPart: (part: Part) => void,
  ): Promise<{ dir: string; base: CodeBase }> {
    await this.dropScratch(
      this.store.db
        .select()
        .from(reports)
        .where(and(eq(reports.alertId, report.alertId), ne(reports.id, report.id), isNotNull(reports.scratchPath)))
        .all(),
    );
    const repo = source.kind === 'repo' ? source.repo.path : this.anonymous.folder(sessionId);
    const listed = branchList(report.playbookBranches ?? '');
    const names =
      listed.length > 0
        ? listed
        : [source.kind === 'repo' ? source.repo.defaultBranch : ((await this.git.defaultBranch(repo)) ?? 'main')];
    const dir = path.join(this.dataDir, 'scratch', report.id);
    let base: CodeBase;
    try {
      base = await this.git.codeBase(repo, names);
      onPart({ kind: 'step', text: codeBaseStep(base) });
      await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
      await this.git.addWorktree(repo, dir, base.sha);
    } catch (error) {
      const message = error instanceof GitFailed && error.message ? error.message : 'git failed';
      throw new VerificationFailed(`Could not make a scratch copy: ${message}`);
    }
    this.store.write((tx) => tx.update(reports).set({ scratchPath: dir }).where(eq(reports.id, report.id)).run());
    return { dir, base };
  }

  private async dropScratch(rows: ReportRow[]): Promise<void> {
    for (const row of rows) {
      if (!row.scratchPath) continue;
      await this.git
        .removeWorktree(row.scratchPath)
        .catch((error) =>
          this.logger.warn(`scratch copy not removed: ${error instanceof Error ? error.message : String(error)}`),
        );
      this.store.write((tx) => tx.update(reports).set({ scratchPath: null }).where(eq(reports.id, row.id)).run());
    }
  }

  private serviceOf(alert: AlertRow): { service: ServiceRow; route: RouteRow } {
    const found = this.store.db
      .select({ service: services, route: routes })
      .from(routes)
      .innerJoin(services, eq(services.id, routes.serviceId))
      .where(eq(routes.id, alert.routeId))
      .get();
    return found as { service: ServiceRow; route: RouteRow };
  }

  private step(reportId: string, steps: ReportStep[], part: Part): void {
    const step = stepOf(part);
    if (step) this.addStep(reportId, steps, step);
  }

  private addStep(reportId: string, steps: ReportStep[], step: ReportStep): void {
    const safe = { ...step, text: redact(step.text) };
    steps.push(safe);
    this.store.write((tx, emit) => {
      tx.update(reports)
        .set({ steps: JSON.stringify(steps) })
        .where(eq(reports.id, reportId))
        .run();
      emit('verification.stepped', { report_id: reportId, index: steps.length - 1, step: safe });
    });
  }

  private async complete(reportId: string, alert: AlertRow, summary: RunSummary): Promise<void> {
    const output = summary.ok ? parseAgentJson(summary.text, outputSchema) : null;
    if (!output) {
      this.fail(reportId, alert.id, summary.ok ? 'the agent did not answer with a Report' : failedBecause(summary));
      return;
    }
    const slug = cleanSlug(output.slug) || 'fix';
    const markdown = redact(output.markdown ?? toMarkdown(alert, output));
    const file = await this.writeFile(alert, reportId, markdown);
    // A ready Report needs no scratch copy (Behavior 25); it goes before the Alert reads as verified.
    await this.dropScratch(this.store.db.select().from(reports).where(eq(reports.id, reportId)).all());
    this.store.write((tx, emit) => {
      tx.update(reports)
        .set({
          status: RunStatus.Ready,
          kind: output.kind,
          slug,
          rootCause: redact(output.root_cause),
          proposedFix: redact(output.proposed_fix),
          replay: output.replay
            ? JSON.stringify({ request: redact(output.replay.request), response: redact(output.replay.response) })
            : null,
          diff: output.diff ? JSON.stringify(output.diff) : null,
          markdown,
          markdownPath: file,
          finishedAt: new Date().toISOString(),
        })
        .where(eq(reports.id, reportId))
        .run();
      this.alerts.transition(tx, alert.id, AlertStatus.Verified, AlertEventKind.Verified, AlertActor.Agent, {
        report_id: reportId,
        kind: output.kind,
      });
      emit('alert.verified', { alert_id: alert.id, report_id: reportId, status: 'ready' });
    });
  }

  /** The Report file goes in the Datadog Connector's reports folder; the database copy is the one that counts. */
  private async writeFile(alert: AlertRow, reportId: string, markdown: string): Promise<string | null> {
    try {
      const folder = path.resolve(this.dataDir, this.scans.config().reports_folder);
      await mkdir(folder, { recursive: true });
      const row = this.store.db.select().from(reports).where(eq(reports.id, reportId)).get();
      const file = path.join(folder, `${alert.id.slice(0, 8)}-v${row?.version ?? 1}.md`);
      await writeFile(file, markdown);
      return file;
    } catch (error) {
      this.logger.warn(`report file not written: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private fail(reportId: string, alertId: string, message: string): void {
    this.store.write((tx, emit) => {
      tx.update(reports)
        .set({ status: RunStatus.Failed, errorMessage: message, finishedAt: new Date().toISOString() })
        .where(eq(reports.id, reportId))
        .run();
      this.alerts.transition(tx, alertId, AlertStatus.Open, AlertEventKind.VerificationFailed, AlertActor.Agent, {
        report_id: reportId,
        reason: message,
      });
      emit('alert.verified', { alert_id: alertId, report_id: reportId, status: 'failed' });
    });
  }

  /**
   * Start-up recovery: a Report left `running` failed with its steps kept (Behavior 26). Scratch copies stay only for
   * failed Reports, which Retry needs (Behavior 25).
   */
  private async recover(): Promise<void> {
    const running = this.store.db.select().from(reports).where(eq(reports.status, RunStatus.Running)).all();
    for (const report of running) this.fail(report.id, report.alertId, 'interrupted');
    const kept = this.store.db
      .select()
      .from(reports)
      .where(and(isNotNull(reports.scratchPath), eq(reports.status, RunStatus.Failed)))
      .all();
    await this.dropScratch(
      this.store.db
        .select()
        .from(reports)
        .where(and(isNotNull(reports.scratchPath), ne(reports.status, RunStatus.Failed)))
        .all(),
    );
    const folder = path.join(this.dataDir, 'scratch');
    const keep = new Set(kept.map((row) => row.scratchPath));
    for (const name of await readdir(folder).catch(() => [])) {
      const dir = path.join(folder, name);
      if (!keep.has(dir)) await this.git.removeWorktree(dir);
    }
  }
}
