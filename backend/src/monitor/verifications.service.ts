import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AlertActor,
  AlertEventKind,
  AlertStatus,
  type Part,
  type Report,
  ReportKind,
  type ReportStep,
  RunStatus,
} from '@ops-console/shared';
import { eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { redact } from '../action-log/redact';
import { AgentRuntime } from '../agent/runtime';
import { DATA_DIR } from '../common/data-dir';
import { StartupRecovery } from '../common/recovery';
import { reports, routes, services } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { parseAgentJson } from './agent-json';
import { AlertSessions } from './alert-sessions';
import { AlertsService } from './alerts.service';
import { type AlertRow, type ServiceRow, samplesOf, toReport } from './mappers';
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

export function verificationPrompt(alert: AlertRow, service: ServiceRow, repoName: string): string {
  const samples = samplesOf(alert)
    .slice(0, 5)
    .map((sample) => `- ${sample.timestamp} ${sample.status}: ${sample.message}`)
    .join('\n');
  return `Verify a failing route from Datadog against the code in this folder (${repoName}).

Alert: ${alert.title}
Service: ${service.name} (${service.env}); route ${alert.title.split(' failing')[0]}
Events: ${alert.eventCount} since ${alert.firstSeenAt}; Datadog query: ${alert.datadogQuery}

Newest log lines:
${samples}

1. Map the log to the code that raised it.
2. Replay the request with curl against this repo running locally, and note the response.
3. Cross-check the data with the Connections the console gives you, read only.
4. Decide whether this is a bug or an improvement, and what the smallest fix is.

Change nothing and run nothing that writes. Answer with one JSON block and nothing after it:

\`\`\`json
{
  "kind": "bug | improvement",
  "slug": "short-kebab-name",
  "root_cause": "what is wrong, in plain words",
  "proposed_fix": "what to change and where",
  "replay": { "request": "curl command", "response": "status and body, secrets removed" },
  "diff": [{ "sign": "+ | - | space", "text": "line" }],
  "markdown": "the full Report as Markdown"
}
\`\`\`

"replay" and "diff" may be null.`;
}

function stepOf(part: Part): ReportStep | null {
  if (part.kind === 'step') return { kind: part.text.startsWith('$ ') ? 'command' : 'step', text: part.text };
  if (part.kind === 'text') return { kind: 'step', text: part.text.slice(0, 500) };
  return null;
}

function toMarkdown(alert: AlertRow, output: z.infer<typeof outputSchema>): string {
  return `# ${alert.title}\n\n**Kind:** ${output.kind}\n\n## Root cause\n\n${output.root_cause}\n\n## Proposed fix\n\n${output.proposed_fix}\n`;
}

@Injectable()
export class VerificationsService {
  private readonly logger = new Logger('monitor');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(AlertSessions) private readonly sessions: AlertSessions,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(ScansService) private readonly scans: ScansService,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('monitor verifications', () => this.recover());
  }

  /** Answers with the Report in `running`; the agent works on, and `alert.verified` reports the end. */
  async start(alertId: string): Promise<Report> {
    const alert = this.alerts.row(alertId);
    this.alerts.requireStatus(alert, AlertStatus.Open, AlertStatus.Verified);
    const service = this.serviceOf(alert);
    const repo = this.sessions.repoOf(service);
    const sessionId = await this.sessions.ensure(alert, service);
    const reportId = crypto.randomUUID();
    const steps: ReportStep[] = [];
    const { finished } = this.runtime.runFor(sessionId, verificationPrompt(alert, service, repo.name), (part) =>
      this.step(reportId, steps, part),
    );
    const row = this.store.write((tx) => {
      const version =
        (tx
          .select({ v: max(reports.version) })
          .from(reports)
          .where(eq(reports.alertId, alertId))
          .get()?.v ?? 0) + 1;
      const created = tx.insert(reports).values({ id: reportId, alertId, version }).returning().get();
      this.alerts.transition(
        tx,
        alertId,
        AlertStatus.Verifying,
        AlertEventKind.VerificationStarted,
        AlertActor.Operator,
        {
          report_id: reportId,
          version,
        },
      );
      return created;
    });
    void finished
      .then((summary) => this.complete(reportId, alert, summary))
      .catch((error) =>
        this.logger.error(`verification ${reportId} failed: ${error instanceof Error ? error.message : error}`),
      );
    return toReport(row);
  }

  private serviceOf(alert: AlertRow): ServiceRow {
    const found = this.store.db
      .select({ service: services })
      .from(routes)
      .innerJoin(services, eq(services.id, routes.serviceId))
      .where(eq(routes.id, alert.routeId))
      .get();
    return (found as { service: ServiceRow }).service;
  }

  private step(reportId: string, steps: ReportStep[], part: Part): void {
    const step = stepOf(part);
    if (!step) return;
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

  private async complete(reportId: string, alert: AlertRow, summary: { ok: boolean; text: string }): Promise<void> {
    const output = summary.ok ? parseAgentJson(summary.text, outputSchema) : null;
    if (!output) {
      this.fail(reportId, alert.id, summary.ok ? 'the agent did not answer with a Report' : 'the agent run failed');
      return;
    }
    const slug = cleanSlug(output.slug) || 'fix';
    const markdown = redact(output.markdown ?? toMarkdown(alert, output));
    const file = await this.writeFile(alert, reportId, markdown);
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

  /** Start-up recovery: a Report left `running` failed with its steps kept (Behavior 26). */
  private recover(): void {
    const running = this.store.db.select().from(reports).where(eq(reports.status, RunStatus.Running)).all();
    for (const report of running) this.fail(report.id, report.alertId, 'interrupted');
  }
}
