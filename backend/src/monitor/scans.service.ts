import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AlertActor,
  AlertEventKind,
  AlertSource,
  AlertStatus,
  CheckInterval,
  ConnectorId,
  connectorConfigSchemas,
  ErrorCode,
  ReviewDecision,
  RouteState,
  SAMPLE_LIMIT,
  type Sample,
  type Scan,
  ScanStatus,
  ScanTrigger,
  Severity,
} from '@ops-console/shared';
import { and, desc, eq, gt, isNull, max } from 'drizzle-orm';
import type { z } from 'zod';
import { redact } from '../action-log/redact';
import { ApiError } from '../common/errors';
import { StartupRecovery } from '../common/recovery';
import { ConnectorsService } from '../connectors/connectors.service';
import { alerts, connectors, reports, reviews, routes, scanRouteResults, scans, services } from '../db/schema';
import { type Emit, STORE, type Store, type Tx } from '../db/store';
import { Scheduler } from '../scheduler/scheduler';
import { AlertsService } from './alerts.service';
import { DATADOG_READER, type DatadogReader, type RouteReading, type ServiceReading } from './datadog';
import { fingerprint, maskSignature } from './fingerprint';
import { type AlertRow, parseJson, type RouteRow, type ServiceRow, samplesOf } from './mappers';

type DatadogConfig = z.infer<(typeof connectorConfigSchemas)[ConnectorId.Datadog]>;
type ScanRow = typeof scans.$inferSelect;

const HOURS: Record<CheckInterval, number> = {
  [CheckInterval.Day]: 24,
  [CheckInterval.HalfDay]: 12,
  [CheckInterval.SixHours]: 6,
};

/** The finest interval; every slot of a longer interval is also one of these. */
const GRID_HOURS = 6;

export function toScan(row: ScanRow): Scan {
  return {
    id: row.id,
    triggered_by: row.triggeredBy,
    service_id: row.serviceId,
    window_size: row.windowSize,
    status: row.status,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
  };
}

/** Slots at `time` (local) and every `stepHours` after, on both sides of `around`. */
function slotsAround(time: string, stepHours: number, around: Date): Date[] {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  const base = new Date(around);
  base.setHours(hours, minutes, 0, 0);
  const slots: Date[] = [];
  for (let k = -(48 / stepHours); k <= 48 / stepHours; k++)
    slots.push(new Date(base.getTime() + k * stepHours * 3_600_000));
  return slots;
}

/** The first slot strictly after `after`. */
export function nextSlot(time: string, stepHours: number, after: Date): Date {
  return slotsAround(time, stepHours, after).find((slot) => slot > after) as Date;
}

/** The latest slot at or before `at`. */
export function latestSlot(time: string, stepHours: number, at: Date): Date {
  return slotsAround(time, stepHours, at)
    .filter((slot) => slot <= at)
    .at(-1) as Date;
}

function globMatch(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

const SECRET_KEY = /pass(?:word|wd)?|secret|token|api[_-]?key|authorization|credential|cookie|session/i;
const BODY_KEY = /^(?:body|request_body|response_body|payload|data)$/i;

function redactValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key) || BODY_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, k)]));
  }
  return value;
}

export function redactSample(sample: Sample): Sample {
  return {
    ...sample,
    message: redact(sample.message),
    attributes: redactValue(sample.attributes) as Record<string, unknown>,
  };
}

/** Existing Samples and new ones, newest first, one per id, at most 25. */
function mergeSamples(existing: Sample[], fresh: Sample[]): Sample[] {
  const byId = new Map<string, Sample>();
  for (const sample of [...fresh, ...existing]) if (!byId.has(sample.id)) byId.set(sample.id, sample);
  return [...byId.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, SAMPLE_LIMIT);
}

/** The error kind of a reading: the most common masked message among its Samples, the newest on a tie. */
function signatureOf(samples: Sample[]): string {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const signature = maskSignature(sample.message);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  const best = Math.max(0, ...counts.values());
  const newest = samples.find((sample) => counts.get(maskSignature(sample.message)) === best);
  return newest?.message ?? '';
}

@Injectable()
export class ScansService {
  private readonly logger = new Logger('monitor');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(DATADOG_READER) private readonly reader: DatadogReader,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(Scheduler) scheduler: Scheduler,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('monitor scans', () => this.recover());
    scheduler.register({
      name: 'monitor-scan',
      nextSlot: (after) => nextSlot(this.config().daily_scan_time, GRID_HOURS, after),
      run: () => this.runDue(new Date()),
      lastRunAt: () => {
        const last = this.store.db
          .select({ at: max(scans.startedAt) })
          .from(scans)
          .where(eq(scans.triggeredBy, ScanTrigger.Schedule))
          .get()?.at;
        return last ? new Date(last) : null;
      },
    });
  }

  list(serviceId?: string): Scan[] {
    return this.store.db
      .select()
      .from(scans)
      .where(serviceId === undefined ? undefined : eq(scans.serviceId, serviceId))
      .orderBy(desc(scans.startedAt), desc(scans.id))
      .limit(100)
      .all()
      .map(toScan);
  }

  get(id: string): Scan & { results: { route_id: string; error_count: number; state: RouteState }[] } {
    const row = this.store.db.select().from(scans).where(eq(scans.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Scan');
    const results = this.store.db
      .select()
      .from(scanRouteResults)
      .where(eq(scanRouteResults.scanId, id))
      .all()
      .map((result) => ({ route_id: result.routeId, error_count: result.errorCount, state: result.state }));
    return { ...toScan(row), results };
  }

  /** The operator's Scan: `serviceId` null scans every Service. Answers at once; the read goes on in the background. */
  start(serviceId: string | null): Scan {
    this.connectors.require(ConnectorId.Datadog);
    const config = this.config();
    let window = config.default_interval as CheckInterval;
    if (serviceId !== null) {
      const service = this.store.db.select().from(services).where(eq(services.id, serviceId)).get();
      if (!service) throw new ApiError(404, ErrorCode.NotFound, 'no such Service');
      window = (service.checkInterval ?? window) as CheckInterval;
    }
    const row = this.create(ScanTrigger.Operator, serviceId, window);
    void this.execute(row).catch((error) =>
      this.logger.warn(`scan ${row.id} stopped: ${error instanceof Error ? error.message : String(error)}`),
    );
    return toScan(row);
  }

  /** The scheduled Scans due at `now`: one per window that has Services and no Scan since its latest slot. */
  async runDue(now: Date): Promise<void> {
    if (this.connectorDown()) return;
    const config = this.config();
    const fallback = config.default_interval as CheckInterval;
    const windows = new Set<CheckInterval>([fallback]);
    for (const service of this.store.db.select().from(services).all()) {
      windows.add((service.checkInterval ?? fallback) as CheckInterval);
    }
    for (const window of windows) {
      const slot = latestSlot(config.daily_scan_time, HOURS[window], now);
      const last = this.store.db
        .select({ at: max(scans.startedAt) })
        .from(scans)
        .where(and(eq(scans.triggeredBy, ScanTrigger.Schedule), eq(scans.windowSize, window), isNull(scans.serviceId)))
        .get()?.at;
      if (last && new Date(last) >= slot) continue;
      await this.execute(this.create(ScanTrigger.Schedule, null, window));
    }
  }

  private connectorDown(): boolean {
    try {
      this.connectors.require(ConnectorId.Datadog);
      return false;
    } catch {
      return true;
    }
  }

  config(): DatadogConfig {
    const raw = this.store.db.select().from(connectors).where(eq(connectors.id, ConnectorId.Datadog)).get();
    return connectorConfigSchemas[ConnectorId.Datadog].parse(parseJson(raw?.config ?? null, {}));
  }

  private create(triggeredBy: ScanTrigger, serviceId: string | null, window: CheckInterval): ScanRow {
    return this.store.write((tx, emit) => {
      const row = tx
        .insert(scans)
        .values({ id: crypto.randomUUID(), triggeredBy, serviceId, windowSize: window })
        .returning()
        .get();
      emit('scan.started', { scan_id: row.id, service_id: serviceId });
      return row;
    });
  }

  private async execute(scan: ScanRow): Promise<void> {
    try {
      const config = this.config();
      const target = scan.serviceId
        ? this.store.db.select().from(services).where(eq(services.id, scan.serviceId)).get()
        : undefined;
      const readings = await this.reader.read({
        envs: config.environments,
        window: scan.windowSize,
        service: target?.name ?? null,
        ignore: config.ignore,
      });
      this.store.write((tx, emit) => {
        this.apply(tx, emit, scan, config, readings);
        this.end(tx, emit, scan.id, ScanStatus.Ok, null, null);
      });
    } catch (error) {
      const limited = error instanceof ApiError && error.code === ErrorCode.RateLimited;
      const message = error instanceof Error ? error.message : String(error);
      if (!limited) this.logger.warn(`scan ${scan.id} failed: ${message}`);
      this.store.write((tx, emit) =>
        this.end(
          tx,
          emit,
          scan.id,
          limited ? ScanStatus.RateLimited : ScanStatus.Failed,
          limited ? ErrorCode.RateLimited : ErrorCode.UpstreamFailed,
          message,
        ),
      );
    }
  }

  private end(
    tx: Tx,
    emit: Emit,
    id: string,
    status: ScanStatus,
    errorCode: string | null,
    errorMessage: string | null,
  ): void {
    tx.update(scans)
      .set({ status, errorCode, errorMessage, finishedAt: new Date().toISOString() })
      .where(eq(scans.id, id))
      .run();
    emit('scan.finished', { scan_id: id, status, error_code: errorCode });
  }

  /** Start-up recovery: a Scan the last daemon left `running` did not finish (Behavior 26). */
  private recover(): void {
    this.store.write((tx, emit) => {
      const rows = tx
        .update(scans)
        .set({ status: ScanStatus.Failed, errorCode: 'interrupted', finishedAt: new Date().toISOString() })
        .where(eq(scans.status, ScanStatus.Running))
        .returning()
        .all();
      for (const row of rows)
        emit('scan.finished', { scan_id: row.id, status: ScanStatus.Failed, error_code: 'interrupted' });
    });
  }

  private applies(scan: ScanRow, existing: ServiceRow | undefined, config: DatadogConfig): boolean {
    if (scan.serviceId) return existing?.id === scan.serviceId;
    if (scan.triggeredBy === ScanTrigger.Operator) return true;
    return (existing?.checkInterval ?? config.default_interval) === scan.windowSize;
  }

  private apply(tx: Tx, emit: Emit, scan: ScanRow, config: DatadogConfig, readings: ServiceReading[]): void {
    const now = new Date().toISOString();
    const seen = new Set<string>();
    for (const reading of readings) {
      let service = tx
        .select()
        .from(services)
        .where(and(eq(services.name, reading.name), eq(services.env, reading.env)))
        .get();
      if (!this.applies(scan, service, config)) continue;
      service ??= tx
        .insert(services)
        .values({ id: crypto.randomUUID(), name: reading.name, env: reading.env })
        .returning()
        .get();
      for (const read of reading.routes) {
        const route = this.upsertRoute(tx, service, read);
        seen.add(route.id);
        const skip =
          route.ignored || config.ignore.some((rule) => rule.kind === 'route' && globMatch(rule.value, route.path));
        const state =
          read.peakPer10m >= config.rapid_errors_per_10m && read.errors > 0
            ? RouteState.Rapid
            : read.errors > 0
              ? RouteState.Failing
              : RouteState.Ok;
        if (!skip && read.errors > 0) this.raise(tx, emit, scan, config, service, route, read, now);
        tx.insert(scanRouteResults)
          .values({ scanId: scan.id, routeId: route.id, scannedAt: now, errorCount: read.errors, state })
          .run();
      }
    }
    // A known Route that logged nothing this time is healthy.
    const scope = tx
      .select()
      .from(services)
      .all()
      .filter((service) => this.applies(scan, service, config));
    for (const service of scope) {
      for (const route of tx.select().from(routes).where(eq(routes.serviceId, service.id)).all()) {
        if (seen.has(route.id)) continue;
        tx.insert(scanRouteResults)
          .values({ scanId: scan.id, routeId: route.id, scannedAt: now, errorCount: 0, state: RouteState.Ok })
          .run();
      }
    }
  }

  private upsertRoute(tx: Tx, service: ServiceRow, read: RouteReading): RouteRow {
    const found = tx
      .select()
      .from(routes)
      .where(and(eq(routes.serviceId, service.id), eq(routes.method, read.method), eq(routes.path, read.path)))
      .get();
    return (
      found ??
      tx
        .insert(routes)
        .values({ id: crypto.randomUUID(), serviceId: service.id, method: read.method, path: read.path })
        .returning()
        .get()
    );
  }

  private severity(config: DatadogConfig, window: CheckInterval, read: RouteReading): Severity {
    if (read.peakPer10m >= config.rapid_errors_per_10m) return Severity.Sev2;
    const perHour = read.errors / HOURS[window];
    const errorLevel = read.samples.some((sample) => sample.status === 'error');
    return perHour >= config.failing_errors_per_hour && errorLevel ? Severity.Sev3 : Severity.Warn;
  }

  /** Creates the Alert, updates it, or reopens it as a Regression (Behaviors 2, 3, 5, 6). */
  private raise(
    tx: Tx,
    emit: Emit,
    scan: ScanRow,
    config: DatadogConfig,
    service: ServiceRow,
    route: RouteRow,
    read: RouteReading,
    now: string,
  ): void {
    const fresh = read.samples.map(redactSample);
    const print = fingerprint(service.id, route.method, route.path, signatureOf(read.samples));
    const severity = this.severity(config, scan.windowSize, read);
    const existing = tx.select().from(alerts).where(eq(alerts.fingerprint, print)).get();
    if (!existing) {
      const row = tx
        .insert(alerts)
        .values({
          id: crypto.randomUUID(),
          routeId: route.id,
          fingerprint: print,
          source: AlertSource.Scan,
          severity,
          title: `${route.method} ${route.path} failing on ${service.name}`,
          logLine: fresh[0]?.message ?? '',
          eventCount: read.errors,
          firstSeenAt: now,
          lastSeenAt: now,
          samples: JSON.stringify(mergeSamples([], fresh)),
          datadogQuery: read.query,
        })
        .returning()
        .get();
      this.alerts.record(tx, row.id, AlertEventKind.Detected, AlertActor.Scan, { event_count: read.errors, severity });
      emit('alert.detected', {
        alert_id: row.id,
        severity,
        route: { id: route.id, method: route.method, path: route.path },
      });
      return;
    }
    if (this.reopens(tx, existing)) {
      const since = existing.resolvedAt;
      const after = since ? fresh.filter((sample) => sample.timestamp > since) : fresh;
      this.alerts.transition(
        tx,
        existing.id,
        AlertStatus.Open,
        AlertEventKind.Regressed,
        AlertActor.Scan,
        { regression_count: existing.regressionCount + 1 },
        {
          severity,
          eventCount: read.errors,
          lastSeenAt: now,
          resolvedAt: null,
          regressionCount: existing.regressionCount + 1,
          samples: JSON.stringify(mergeSamples([], after)),
          logLine: after[0]?.message ?? fresh[0]?.message ?? existing.logLine,
        },
      );
      if (existing.status === AlertStatus.Dismissed) this.undoDismissal(tx, existing.id, now);
      emit('alert.regressed', { alert_id: existing.id, regression_count: existing.regressionCount + 1 });
      return;
    }
    // A resolved Alert whose Route has not been seen healthy since stays as it is.
    if (existing.status === AlertStatus.Resolved) return;
    const merged = mergeSamples(samplesOf(existing), fresh);
    const eventCount = existing.eventCount + read.errors;
    tx.update(alerts)
      .set({
        severity,
        eventCount,
        lastSeenAt: now,
        updatedAt: now,
        samples: JSON.stringify(merged),
        logLine: merged[0]?.message ?? existing.logLine,
      })
      .where(eq(alerts.id, existing.id))
      .run();
    emit('alert.updated', { alert_id: existing.id, event_count: eventCount, last_seen_at: now });
  }

  /** A resolved or dismissed Alert reopens once its Route was healthy after its last failing sighting. */
  private reopens(tx: Tx, alert: AlertRow): boolean {
    if (alert.status !== AlertStatus.Resolved && alert.status !== AlertStatus.Dismissed) return false;
    const boundary = [alert.lastSeenAt, alert.resolvedAt ?? ''].sort().at(-1) as string;
    return (
      tx
        .select({ at: scanRouteResults.scannedAt })
        .from(scanRouteResults)
        .where(
          and(
            eq(scanRouteResults.routeId, alert.routeId),
            eq(scanRouteResults.state, RouteState.Ok),
            gt(scanRouteResults.scannedAt, boundary),
          ),
        )
        .get() !== undefined
    );
  }

  /** The dismissal no longer holds once the Alert is open again. */
  private undoDismissal(tx: Tx, alertId: string, now: string): void {
    const ids = tx
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.alertId, alertId))
      .all()
      .map((r) => r.id);
    for (const id of ids) {
      tx.update(reviews)
        .set({ undoneAt: now })
        .where(and(eq(reviews.reportId, id), isNull(reviews.undoneAt), eq(reviews.decision, ReviewDecision.Dismissed)))
        .run();
    }
  }
}
