import { Inject, Injectable } from '@nestjs/common';
import {
  type Alert,
  type AlertActor,
  type AlertDetail,
  type AlertEvent,
  AlertEventKind,
  type AlertListItem,
  AlertStatus,
  type AlertSummary,
  alertsQuerySchema,
  type CheckInterval,
  ErrorCode,
  LOG_SOURCES,
  type LogSource,
  type Page,
  type Report,
  ScanStatus,
} from '@ops-console/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { z } from 'zod';
import { ApiError } from '../common/errors';
import { afterCursor, toPage } from '../common/pagination';
import { alertEvents, alerts, fixes, reports, reviews, routes, scans, services, sessions } from '../db/schema';
import { STORE, type Store, type Tx } from '../db/store';
import { jobPlaybook } from '../playbooks/job-steps';
import { awaitingProdCheck, freshnessOf } from './freshness';
import { logSourceConfig } from './log-source-config';
import {
  type AlertListRow,
  type AlertRow,
  type ServiceRow,
  samplesOf,
  toAlert,
  toAlertEvent,
  toAlertListItem,
  toFix,
  toReport,
  toReview,
} from './mappers';

const CLOSED = [AlertStatus.Resolved, AlertStatus.Dismissed];

const SEQ = sql`"alert_events"."rowid"`;

/** Events that put an Alert in `verified`: the newest one is when it began waiting (ADR 0002). */
const ENTERED_VERIFIED = [AlertEventKind.Verified, AlertEventKind.Undone, AlertEventKind.Abandoned];

type ScanRead = { scans: (typeof scans.$inferSelect)[]; intervals: Record<LogSource, CheckInterval> };

@Injectable()
export class AlertsService {
  constructor(@Inject(STORE) private readonly store: Store) {}

  row(id: string): AlertRow {
    const row = this.store.db.select().from(alerts).where(eq(alerts.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Alert');
    return row;
  }

  /**
   * The Alerts the Monitor lists: every one not yet resolved or dismissed, or with `scope=closed` the resolved and
   * dismissed ones, newest sighting first, a page at a time.
   */
  list(query: z.infer<typeof alertsQuerySchema>): Page<AlertListItem> {
    const closed = query.scope === 'closed';
    const after = afterCursor(query.cursor);
    const [seenAt = '', afterId = ''] = after?.split('|') ?? [];
    const filters: (SQL | undefined)[] = [
      query.status === undefined ? undefined : eq(alerts.status, query.status),
      query.severity === undefined ? undefined : eq(alerts.severity, query.severity),
      query.service_id === undefined ? undefined : eq(services.id, query.service_id),
      query.connector === undefined ? undefined : eq(alerts.connector, query.connector),
      closed
        ? inArray(alerts.status, CLOSED)
        : query.status === undefined
          ? notInArray(alerts.status, CLOSED)
          : undefined,
      closed && after !== undefined
        ? or(lt(alerts.lastSeenAt, seenAt), and(eq(alerts.lastSeenAt, seenAt), lt(alerts.id, afterId)))
        : undefined,
    ];
    const { samples: _samples, ...columns } = getTableColumns(alerts);
    const found = this.store.db
      .select({ alert: columns, route: routes, service: services })
      .from(alerts)
      .innerJoin(routes, eq(routes.id, alerts.routeId))
      .innerJoin(services, eq(services.id, routes.serviceId))
      .where(and(...filters))
      .orderBy(desc(alerts.lastSeenAt), desc(alerts.id))
      .limit(closed ? query.limit + 1 : -1)
      .all();
    const read = this.scanRead();
    const sessionOf = this.sessionsByAlert();
    // Freshness depends on the Service and the status code only, so Alerts that share both share one answer.
    const fresh = new Map<string, ReturnType<typeof freshnessOf>>();
    const rows = found.map(({ alert, route, service }) =>
      toAlertListItem(alert, route, service, this.extra(alert, service, read, sessionOf, fresh)),
    );
    return closed
      ? toPage(rows, query.limit, (row) => `${row.last_seen_at}|${row.id}`)
      : { data: rows, meta: { next_cursor: null } };
  }

  /**
   * The Alerts not yet resolved or dismissed that the Monitor lists with no status code picked: one from before Scans
   * read codes lists only while the operator works on it.
   */
  summary(): AlertSummary {
    const row = this.store.db
      .select({ open: count() })
      .from(alerts)
      .where(
        and(notInArray(alerts.status, CLOSED), or(isNotNull(alerts.httpStatus), ne(alerts.status, AlertStatus.Open))),
      )
      .get();
    return { open: row?.open ?? 0 };
  }

  view(id: string): Alert {
    const found = this.store.db
      .select({ alert: alerts, route: routes, service: services })
      .from(alerts)
      .innerJoin(routes, eq(routes.id, alerts.routeId))
      .innerJoin(services, eq(services.id, routes.serviceId))
      .where(eq(alerts.id, id))
      .get();
    if (!found) throw new ApiError(404, ErrorCode.NotFound, 'no such Alert');
    return toAlert(found.alert, found.route, found.service, this.extra(found.alert, found.service, this.scanRead()));
  }

  detail(id: string): AlertDetail {
    const alert = this.view(id);
    const latest = this.store.db
      .select()
      .from(reports)
      .where(eq(reports.alertId, id))
      .orderBy(desc(reports.version))
      .get();
    const review = latest
      ? this.store.db
          .select()
          .from(reviews)
          .where(and(eq(reviews.reportId, latest.id), isNull(reviews.undoneAt)))
          .get()
      : undefined;
    const fix = this.fixOf(id);
    return {
      ...alert,
      samples: samplesOf(this.row(id)),
      latest_report: latest ? toReport(latest, jobPlaybook(this.store.db, 'report', latest)) : null,
      review: review ? toReview(review) : null,
      fix: fix ? toFix(fix, jobPlaybook(this.store.db, 'fix', fix)) : null,
    };
  }

  events(id: string): AlertEvent[] {
    this.row(id);
    return this.store.db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.alertId, id))
      .orderBy(asc(alertEvents.at), asc(SEQ))
      .all()
      .map(toAlertEvent);
  }

  reports(id: string): Report[] {
    this.row(id);
    return this.store.db
      .select()
      .from(reports)
      .where(eq(reports.alertId, id))
      .orderBy(asc(reports.version))
      .all()
      .map((row) => toReport(row, jobPlaybook(this.store.db, 'report', row)));
  }

  report(id: string): Report {
    const row = this.store.db.select().from(reports).where(eq(reports.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Report');
    return toReport(row, jobPlaybook(this.store.db, 'report', row));
  }

  /** The newest Fix of the Alert's active Review, if any. */
  fixOf(alertId: string) {
    return this.store.db
      .select({ fix: fixes })
      .from(fixes)
      .innerJoin(reviews, eq(reviews.id, fixes.reviewId))
      .innerJoin(reports, eq(reports.id, reviews.reportId))
      .where(eq(reports.alertId, alertId))
      .orderBy(desc(fixes.startedAt))
      .get()?.fix;
  }

  /** Moves the Alert and writes the `alert_events` row in the same transaction (Behavior 25). */
  transition(
    tx: Tx,
    alertId: string,
    status: AlertStatus,
    kind: AlertEventKind,
    actor: AlertActor,
    data: Record<string, unknown> = {},
    extra: Partial<typeof alerts.$inferInsert> = {},
  ): void {
    tx.update(alerts)
      .set({ status, updatedAt: new Date().toISOString(), ...extra })
      .where(eq(alerts.id, alertId))
      .run();
    this.record(tx, alertId, kind, actor, data);
  }

  /** An event that leaves the status as it is. */
  record(tx: Tx, alertId: string, kind: AlertEventKind, actor: AlertActor, data: Record<string, unknown> = {}): void {
    tx.insert(alertEvents)
      .values({ id: crypto.randomUUID(), alertId, kind, actor, data: JSON.stringify(data) })
      .run();
  }

  /** Alerts of this status, for the code that must not act on a stale read. */
  requireStatus(alert: AlertRow, ...allowed: AlertStatus[]): void {
    if (!allowed.includes(alert.status)) {
      throw new ApiError(409, ErrorCode.InvalidState, `the Alert is ${alert.status}`);
    }
  }

  /** The `ok` Scans newest end first, and the interval a Service with none of its own is scanned at, per source. */
  private scanRead(): ScanRead {
    const ok = this.store.db
      .select()
      .from(scans)
      .where(eq(scans.status, ScanStatus.Ok))
      .orderBy(desc(scans.finishedAt))
      .all();
    const intervals = Object.fromEntries(
      LOG_SOURCES.map((connector) => [connector, logSourceConfig(this.store.db, connector).default_interval]),
    ) as Record<LogSource, CheckInterval>;
    return { scans: ok, intervals };
  }

  /** The Session of each Alert that has one, read once for a list. */
  private sessionsByAlert(): Map<string, string> {
    const rows = this.store.db
      .select({ id: sessions.id, alertId: sessions.alertId })
      .from(sessions)
      .where(isNotNull(sessions.alertId))
      .all();
    const found = new Map<string, string>();
    for (const row of rows) if (row.alertId !== null && !found.has(row.alertId)) found.set(row.alertId, row.id);
    return found;
  }

  private extra(
    alert: AlertListRow,
    service: ServiceRow,
    read: ScanRead,
    sessionOf?: Map<string, string>,
    memo?: Map<string, ReturnType<typeof freshnessOf>>,
  ) {
    const waiting =
      alert.status === AlertStatus.Verified
        ? this.store.db
            .select({ at: alertEvents.at })
            .from(alertEvents)
            .where(and(eq(alertEvents.alertId, alert.id), inArray(alertEvents.kind, ENTERED_VERIFIED)))
            .orderBy(desc(alertEvents.at), desc(SEQ))
            .get()?.at
        : undefined;
    const sessionId =
      sessionOf?.get(alert.id) ??
      (sessionOf
        ? null
        : (this.store.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.alertId, alert.id)).get()?.id ??
          null));
    const key = `${service.id}|${alert.httpStatus}`;
    let fresh = memo?.get(key);
    if (!fresh) {
      fresh = freshnessOf(read.scans, alert, service, read.intervals[service.connector]);
      memo?.set(key, fresh);
    }
    return {
      waitingSince: waiting ?? null,
      sessionId,
      lastScannedAt: fresh.lastScannedAt,
      scanOverdue: fresh.overdue,
      awaitingProdCheck: awaitingProdCheck(alert),
    };
  }
}
