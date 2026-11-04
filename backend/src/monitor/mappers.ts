import {
  type Alert,
  type AlertEvent,
  AlertStatus,
  type Fix,
  type JobPlaybook,
  type Report,
  type Review,
  type Sample,
} from '@ops-console/shared';
import { alertEvents, alerts, fixes, reports, reviews, routes, services } from '../db/schema';

export type AlertRow = typeof alerts.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
export type ReviewRow = typeof reviews.$inferSelect;
export type FixRow = typeof fixes.$inferSelect;
export type RouteRow = typeof routes.$inferSelect;
export type ServiceRow = typeof services.$inferSelect;

export const parseJson = <T>(text: string | null, fallback: T): T =>
  text === null ? fallback : (JSON.parse(text) as T);

export function toReport(row: ReportRow, playbook: JobPlaybook | null): Report {
  return {
    id: row.id,
    alert_id: row.alertId,
    version: row.version,
    status: row.status,
    kind: row.kind,
    slug: row.slug,
    steps: parseJson(row.steps, []),
    replay: parseJson(row.replay, null),
    root_cause: row.rootCause,
    proposed_fix: row.proposedFix,
    diff: parseJson(row.diff, null),
    markdown: row.markdown,
    markdown_path: row.markdownPath,
    error_message: row.errorMessage,
    created_at: row.createdAt,
    started_at: row.startedAt ?? row.createdAt,
    finished_at: row.finishedAt,
    playbook,
  };
}

export function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    report_id: row.reportId,
    decision: row.decision,
    kind: row.kind,
    decided_at: row.decidedAt,
    undone_at: row.undoneAt,
  };
}

export function toFix(row: FixRow, playbook: JobPlaybook | null): Fix {
  return {
    id: row.id,
    review_id: row.reviewId,
    session_id: row.sessionId,
    stage: row.stage,
    status: row.status,
    jira_key: row.jiraKey,
    jira_url: row.jiraUrl,
    ticket_skipped: row.ticketSkipped,
    branch: row.branch,
    pr_number: row.prNumber,
    pr_url: row.prUrl,
    error_message: row.errorMessage,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    playbook,
  };
}

export function toAlertEvent(row: typeof alertEvents.$inferSelect): AlertEvent {
  return {
    id: row.id,
    alert_id: row.alertId,
    kind: row.kind,
    actor: row.actor,
    data: parseJson(row.data, {}),
    at: row.at,
  };
}

export function toAlert(
  row: AlertRow,
  route: RouteRow,
  service: ServiceRow,
  extra: { waitingSince: string | null; sessionId: string | null },
): Alert {
  return {
    id: row.id,
    route: route.method ? { id: route.id, method: route.method, path: route.path } : null,
    service: {
      id: service.id,
      name: service.name,
      env: service.env,
      repo_id: service.repoId,
      repo_url: service.repoUrl,
    },
    fingerprint: row.fingerprint,
    http_status: row.httpStatus,
    source: row.source,
    severity: row.severity,
    status: row.status,
    title: row.title,
    log_line: row.logLine,
    event_count: row.eventCount,
    first_seen_at: row.firstSeenAt,
    last_seen_at: row.lastSeenAt,
    resolved_at: row.resolvedAt,
    regression_count: row.regressionCount,
    waiting_since: row.status === AlertStatus.Verified ? extra.waitingSince : null,
    datadog_query: row.datadogQuery,
    session_id: extra.sessionId,
  };
}

export const samplesOf = (row: AlertRow): Sample[] => parseJson(row.samples, []);
