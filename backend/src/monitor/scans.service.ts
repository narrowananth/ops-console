import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AlertActor,
  AlertEventKind,
  AlertSource,
  AlertStatus,
  CheckInterval,
  ConnectorId,
  type CreateScan,
  ErrorCode,
  LOG_SOURCES,
  type LogService,
  type LogSource,
  type MonitorEnv,
  NO_ENV,
  ReviewDecision,
  RouteState,
  repoUrlSchema,
  SAMPLE_LIMIT,
  type Sample,
  type Scan,
  ScanStatus,
  ScanTrigger,
  type ScanWindow,
  Severity,
  type StatusCodeCount,
  WINDOW_HOURS,
} from '@ops-console/shared';
import { and, desc, eq, inArray, isNull, lt, max } from 'drizzle-orm';
import { redact } from '../action-log/redact';
import { ApiError, validationFailed } from '../common/errors';
import { StartupRecovery } from '../common/recovery';
import { ConnectorsService } from '../connectors/connectors.service';
import { alerts, reports, reviews, routes, scanRouteResults, scans, services } from '../db/schema';
import { type Emit, STORE, type Store, type Tx } from '../db/store';
import { Scheduler } from '../scheduler/scheduler';
import { AlertsService } from './alerts.service';
import { CodeFinder } from './code-finder';
import { fingerprint, maskSignature } from './fingerprint';
import { HOURS, scanReads } from './freshness';
import { ERROR_LEVEL, LOG_READERS, type LogGroup, type LogReaders, type ServiceReading } from './log-reader';
import { type LogSourceConfig, logSourceConfig } from './log-source-config';
import { type AlertRow, parseJson, type RouteRow, type ServiceRow, samplesOf } from './mappers';
import { OTEL_ERROR_LEVEL } from './otel-logs';
import { MonitorRetention } from './retention';

type ScanRow = typeof scans.$inferSelect;

/** The finest interval; every slot of a longer interval is also one of these. */
const GRID_HOURS = 6;

/** An `ok` Scan keeps its notes, one to a line, where a failed one keeps its error message. */
const NOTE_SEPARATOR = '\n';

export function toScan(row: ScanRow): Scan {
  const ok = row.status === ScanStatus.Ok;
  return {
    id: row.id,
    connector: row.connector,
    triggered_by: row.triggeredBy,
    service_id: row.serviceId,
    window_size: row.windowSize,
    envs: parseJson<string[]>(row.envs, []),
    services: parseJson<string[] | null>(row.services, null),
    status_codes: parseJson<number[]>(row.statusCodes, []),
    status: row.status,
    error_code: row.errorCode,
    error_message: ok ? null : row.errorMessage,
    notes: ok && row.errorMessage ? row.errorMessage.split(NOTE_SEPARATOR) : [],
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
/** The last part of a dotted key counts: OpenTelemetry names it `http.request.body`. */
const BODY_KEY = /(?:^|\.)(?:body|request_body|response_body|payload|data)$/i;

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

/** Logs that name no request hang on this Route of their Service; the API shows it as no Route. */
const NO_ROUTE = { method: '', path: '' };

/** How long the list of a source's envs is kept before it is read again. */
const ENVS_TTL_MS = 10 * 60_000;
/** How long one range and env pick's list of Services is kept. */
const SERVICES_TTL_MS = 2 * 60_000;

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
  private readonly envCache = new Map<LogSource, { at: number; names: string[] }>();
  private readonly serviceCache = new Map<string, { at: number; list: LogService[] }>();
  /** The running Scans' read, to stop it. */
  private readonly running = new Map<string, AbortController>();
  private readonly codeCache = new Map<string, { at: number; list: StatusCodeCount[] }>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(LOG_READERS) private readonly readers: LogReaders,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(CodeFinder) private readonly finder: CodeFinder,
    @Inject(MonitorRetention) private readonly retention: MonitorRetention,
    @Inject(Scheduler) scheduler: Scheduler,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('monitor scans', () => this.recover());
    // Each source on its own schedule, from its own Connector's daily scan time.
    for (const connector of LOG_SOURCES) {
      scheduler.register({
        name: connector === ConnectorId.Datadog ? 'monitor-scan' : `monitor-scan-${connector}`,
        nextSlot: (after) => nextSlot(this.config(connector).daily_scan_time, GRID_HOURS, after),
        run: () => this.runDue(new Date(), connector),
        lastRunAt: () => {
          const last = this.store.db
            .select({ at: max(scans.startedAt) })
            .from(scans)
            .where(and(eq(scans.triggeredBy, ScanTrigger.Schedule), eq(scans.connector, connector)))
            .get()?.at;
          return last ? new Date(last) : null;
        },
      });
    }
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

  /**
   * The operator's Scan over the window, Services and HTTP status codes they picked; a null `service_id` and no
   * `services` scans every Service, in every env. It reads the source asked for, or every connected one, a Scan each.
   * Answers once the Scans are stored (with the first); the reads go on in the background.
   */
  async start(input: CreateScan): Promise<Scan> {
    const serviceId = input.service_id;
    const service =
      serviceId === null ? undefined : this.store.db.select().from(services).where(eq(services.id, serviceId)).get();
    if (serviceId !== null && !service) throw new ApiError(404, ErrorCode.NotFound, 'no such Service');
    if (service && input.connector !== undefined && input.connector !== service.connector) {
      throw validationFailed('the Service is read from another log source');
    }
    const asked = service?.connector ?? input.connector;
    if (asked !== undefined) this.connectors.require(asked);
    const sources = asked ? [asked] : LOG_SOURCES.filter((connector) => !this.connectorDown(connector));
    if (sources.length === 0) {
      throw new ApiError(409, ErrorCode.ConnectorNotConnected, 'no log source is connected');
    }
    const started: Scan[] = [];
    for (const connector of sources) {
      try {
        started.push(await this.startOne(connector, input, service));
      } catch (error) {
        // With several sources, one that cannot be asked for its envs does not stop the others.
        if (sources.length === 1) throw error;
        started.push(this.failedAtStart(connector, input, error));
      }
    }
    return started[0] as Scan;
  }

  private async startOne(connector: LogSource, input: CreateScan, service: ServiceRow | undefined): Promise<Scan> {
    const config = this.config(connector);
    const codes = [...new Set(input.status_codes ?? [])].sort();
    let window: ScanWindow = input.window ?? (config.default_interval as CheckInterval);
    let envs = [...new Set(input.envs ?? (await this.allEnvs(connector)))];
    let names = input.services ? [...new Set(input.services)] : null;
    if (service) {
      window = input.window ?? service.checkInterval ?? window;
      envs = [service.env];
      names = [service.name];
    }
    const row = this.create(ScanTrigger.Operator, connector, service?.id ?? null, window, envs, names, codes);
    void this.execute(row).catch((error) =>
      this.logger.warn(`scan ${row.id} stopped: ${error instanceof Error ? error.message : String(error)}`),
    );
    return toScan(row);
  }

  /** A Scan that could not begin its read: stored, and ended failed, so the operator sees which source it was. */
  private failedAtStart(connector: LogSource, input: CreateScan, error: unknown): Scan {
    const window = input.window ?? (this.config(connector).default_interval as CheckInterval);
    const row = this.create(
      ScanTrigger.Operator,
      connector,
      null,
      window,
      input.envs ?? [],
      input.services ?? null,
      input.status_codes ?? [],
    );
    this.fail(row, error);
    return toScan(this.store.db.select().from(scans).where(eq(scans.id, row.id)).get() as ScanRow);
  }

  /**
   * The scheduled Scans of `connector` (every source when left out) due at `now`: one per window that has Services and
   * no Scan since its latest slot. A source that is down is skipped, and one that fails does not stop the others.
   */
  async runDue(now: Date, connector?: LogSource): Promise<void> {
    for (const source of connector ? [connector] : LOG_SOURCES) {
      if (this.connectorDown(source)) continue;
      try {
        await this.runDueOf(now, source);
      } catch (error) {
        this.logger.warn(
          `scheduled scan of ${source} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async runDueOf(now: Date, connector: LogSource): Promise<void> {
    const config = this.config(connector);
    const fallback = config.default_interval as CheckInterval;
    const windows = new Set<CheckInterval>([fallback]);
    for (const service of this.store.db.select().from(services).where(eq(services.connector, connector)).all()) {
      windows.add((service.checkInterval ?? fallback) as CheckInterval);
    }
    for (const window of windows) {
      const slot = latestSlot(config.daily_scan_time, HOURS[window], now);
      const last = this.store.db
        .select({ at: max(scans.startedAt) })
        .from(scans)
        .where(
          and(
            eq(scans.triggeredBy, ScanTrigger.Schedule),
            eq(scans.connector, connector),
            eq(scans.windowSize, window),
            isNull(scans.serviceId),
          ),
        )
        .get()?.at;
      if (last && new Date(last) >= slot) continue;
      const envs = await this.allEnvs(connector);
      await this.execute(this.create(ScanTrigger.Schedule, connector, null, window, envs, null, []));
    }
  }

  private connectorDown(connector: LogSource): boolean {
    try {
      this.connectors.require(connector);
      return false;
    } catch {
      return true;
    }
  }

  config(connector: LogSource = ConnectorId.Datadog): LogSourceConfig {
    return logSourceConfig(this.store.db, connector);
  }

  /** The envs a source has logs for, the Connector's own first; read again after 10 minutes. */
  async envs(connector: LogSource = ConnectorId.Datadog): Promise<MonitorEnv[]> {
    const configured = this.config(connector).environments;
    let kept = this.envCache.get(connector);
    if (!kept || Date.now() - kept.at > ENVS_TTL_MS) {
      this.connectors.require(connector);
      kept = { at: Date.now(), names: await this.readers[connector].envs() };
      this.envCache.set(connector, kept);
    }
    // Logs with no env are their own choice: many services send none.
    const names = [...new Set([...configured, ...kept.names, NO_ENV])];
    return names.map((name) => ({ name, configured: configured.includes(name) }));
  }

  /** Every env name a Scan reads by default: each env the source has logs for, and the logs with no env. */
  private async allEnvs(connector: LogSource): Promise<string[]> {
    return (await this.envs(connector)).map((env) => env.name);
  }

  /**
   * The Services a source has failing requests for (HTTP status 400 or more, or only `codes`) in the window and envs,
   * every env when none are given; busiest first, kept 2 minutes.
   */
  async logServices(
    connector: LogSource,
    window: ScanWindow,
    envs: string[] | undefined,
    codes: number[],
  ): Promise<LogService[]> {
    const read = envs ?? (await this.allEnvs(connector));
    const key = `${connector}|${window}|${[...read].sort().join(',')}|${[...codes].sort().join(',')}`;
    const kept = this.serviceCache.get(key);
    if (kept && Date.now() - kept.at < SERVICES_TTL_MS) return kept.list;
    this.connectors.require(connector);
    const byName = new Map<string, { envs: { env: string; errors: number }[]; errors: number }>();
    for (const count of await this.readers[connector].services(read, window, codes)) {
      const entry = byName.get(count.name) ?? { envs: [], errors: 0 };
      entry.envs.push({ env: count.env, errors: count.errors });
      entry.errors += count.errors;
      byName.set(count.name, entry);
    }
    const list = [...byName]
      .map(([name, entry]) => ({
        name,
        envs: entry.envs.sort((a, b) => b.errors - a.errors).map((one) => one.env),
        errors: entry.errors,
      }))
      .sort((a, b) => b.errors - a.errors || a.name.localeCompare(b.name));
    this.serviceCache.set(key, { at: Date.now(), list });
    return list;
  }

  /** The HTTP status codes from 400 up with requests in the window, busiest first; kept 2 minutes. */
  async statusCodes(connector: LogSource, window: ScanWindow): Promise<StatusCodeCount[]> {
    const key = `${connector}|${window}`;
    const kept = this.codeCache.get(key);
    if (kept && Date.now() - kept.at < SERVICES_TTL_MS) return kept.list;
    this.connectors.require(connector);
    const list = await this.readers[connector].statusCodes(window);
    this.codeCache.set(key, { at: Date.now(), list });
    return list;
  }

  private create(
    triggeredBy: ScanTrigger,
    connector: LogSource,
    serviceId: string | null,
    window: ScanWindow,
    envs: string[],
    names: string[] | null,
    codes: number[],
  ): ScanRow {
    return this.store.write((tx, emit) => {
      const row = tx
        .insert(scans)
        .values({
          id: crypto.randomUUID(),
          connector,
          triggeredBy,
          serviceId,
          windowSize: window,
          envs: JSON.stringify(envs),
          services: names && JSON.stringify(names),
          statusCodes: JSON.stringify(codes),
        })
        .returning()
        .get();
      emit('scan.started', { scan_id: row.id, service_id: serviceId });
      return row;
    });
  }

  /** Stops a running Scan: its read ends, nothing it read is kept, and it ends `cancelled`. */
  cancel(id: string): void {
    this.get(id);
    const read = this.running.get(id);
    if (!read) throw new ApiError(409, ErrorCode.InvalidState, 'the Scan is not running');
    read.abort();
  }

  private async execute(scan: ScanRow): Promise<void> {
    const read = new AbortController();
    this.running.set(scan.id, read);
    try {
      const config = this.config(scan.connector);
      const notes: string[] = [];
      const readings = await this.readers[scan.connector].read({
        signal: read.signal,
        envs: parseJson<string[]>(scan.envs, []),
        window: scan.windowSize,
        services: parseJson<string[] | null>(scan.services, null),
        codes: parseJson<number[]>(scan.statusCodes, []),
        ignore: config.ignore,
        note: (text) => notes.push(text),
      });
      read.signal.throwIfAborted();
      await this.apply(scan, config, readings, notes);
      this.finder.lookForUnlinked();
      this.retention.afterScan();
    } catch (error) {
      if (read.signal.aborted) {
        this.store.write((tx, emit) => this.end(tx, emit, scan.id, ScanStatus.Cancelled, null, null));
        return;
      }
      this.fail(scan, error);
    } finally {
      this.running.delete(scan.id);
    }
  }

  /** Ends the Scan failed, or rate limited when the source throttled. */
  private fail(scan: ScanRow, error: unknown): void {
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

  /**
   * Whether the Scan covers the Service: its env was read, and it is the one asked for, among the names asked for, or
   * on this schedule.
   */
  private applies(
    scan: ScanRow,
    name: string,
    existing: ServiceRow | undefined,
    config: LogSourceConfig,
    env: string,
  ): boolean {
    const target = {
      id: existing?.id,
      connector: existing?.connector ?? scan.connector,
      name,
      env,
      checkInterval: existing?.checkInterval ?? null,
    };
    return scanReads(scan, target, config.default_interval as CheckInterval);
  }

  /**
   * Stores what the Scan read, one transaction per Service with a turn of the event loop between, so a Scan of
   * hundreds of Services never holds the daemon's one thread for long; then the Routes and Alerts it did not see, and
   * the Scan's end, in the last transaction. A Scan that stops part way keeps the Services stored so far and ends
   * `failed` through the start-up recovery.
   */
  private async apply(
    scan: ScanRow,
    config: LogSourceConfig,
    readings: ServiceReading[],
    notes: string[],
  ): Promise<void> {
    const now = new Date().toISOString();
    const seenRoutes = new Set<string>();
    for (const reading of readings) {
      this.store.write((tx, emit) => this.applyReading(tx, emit, scan, config, reading, now, seenRoutes));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.store.write((tx, emit) => {
      this.clearUnseen(tx, scan, config, now, seenRoutes);
      this.end(tx, emit, scan.id, ScanStatus.Ok, null, notes.length > 0 ? notes.join(NOTE_SEPARATOR) : null);
    });
  }

  private applyReading(
    tx: Tx,
    emit: Emit,
    scan: ScanRow,
    config: LogSourceConfig,
    reading: ServiceReading,
    now: string,
    seenRoutes: Set<string>,
  ): void {
    let service = tx
      .select()
      .from(services)
      .where(
        and(eq(services.connector, scan.connector), eq(services.name, reading.name), eq(services.env, reading.env)),
      )
      .get();
    if (!this.applies(scan, reading.name, service, config, reading.env)) return;
    service ??= tx
      .insert(services)
      .values({ id: crypto.randomUUID(), connector: scan.connector, name: reading.name, env: reading.env })
      .returning()
      .get();
    // A URL from log content must look like a Git host URL, as one the operator types does.
    if (reading.repoUrl && repoUrlSchema.safeParse(reading.repoUrl).success && service.repoUrl === null) {
      service = tx
        .update(services)
        .set({ repoUrl: reading.repoUrl })
        .where(eq(services.id, service.id))
        .returning()
        .get() as ServiceRow;
    }
    // Several kinds of failure can share a Route; its result is their sum.
    const results = new Map<string, { errors: number; rapid: boolean }>();
    for (const group of reading.groups) {
      if (group.errors === 0) continue;
      const route = this.upsertRoute(tx, service, group.method ? group : NO_ROUTE);
      const skip =
        route.ignored ||
        (group.method !== '' &&
          config.ignore.some((rule) => rule.kind === 'route' && globMatch(rule.value, route.path)));
      if (!skip) this.raise(tx, emit, scan, config, service, route, group, now);
      if (!group.method) continue;
      const result = results.get(route.id) ?? { errors: 0, rapid: false };
      result.errors += group.errors;
      result.rapid ||= group.peakPer10m >= config.rapid_errors_per_10m;
      results.set(route.id, result);
    }
    for (const [routeId, result] of results) {
      seenRoutes.add(routeId);
      const state = result.rapid ? RouteState.Rapid : RouteState.Failing;
      tx.insert(scanRouteResults)
        .values({ scanId: scan.id, routeId, scannedAt: now, errorCount: result.errors, state })
        .run();
    }
  }

  /** A known Route that logged nothing this time is healthy, and so is an Alert of a covered Service that this Scan did not see. */
  private clearUnseen(tx: Tx, scan: ScanRow, config: LogSourceConfig, now: string, seenRoutes: Set<string>): void {
    const scope = tx
      .select()
      .from(services)
      .all()
      .filter((service) => this.applies(scan, service.name, service, config, service.env));
    const codes = parseJson<number[]>(scan.statusCodes, []);
    // A known Route that logged nothing this time is healthy; a Scan of some codes only cannot tell.
    for (const service of codes.length > 0 ? [] : scope) {
      const known = tx.select().from(routes).where(eq(routes.serviceId, service.id)).all();
      for (const route of known) {
        if (seenRoutes.has(route.id) || route.method === '') continue;
        tx.insert(scanRouteResults)
          .values({ scanId: scan.id, routeId: route.id, scannedAt: now, errorCount: 0, state: RouteState.Ok })
          .run();
      }
    }
    // So is an Alert of a covered Service that this Scan did not see: a healthy sighting (Behavior 5).
    const scopeIds = scope.map((service) => service.id);
    if (scopeIds.length > 0) {
      const covered = tx.select({ id: routes.id }).from(routes).where(inArray(routes.serviceId, scopeIds));
      // A Scan of some codes only sees nothing of the others.
      const read = codes.length > 0 ? inArray(alerts.httpStatus, codes) : undefined;
      // An Alert this Scan saw was written with `updated_at` of `now` or later, so an older one was not seen.
      tx.update(alerts)
        .set({ clearedAt: now })
        .where(and(inArray(alerts.routeId, covered), lt(alerts.updatedAt, now), read))
        .run();
    }
  }

  private upsertRoute(tx: Tx, service: ServiceRow, read: { method: string; path: string }): RouteRow {
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

  private severity(config: LogSourceConfig, window: ScanWindow, read: LogGroup, connector: LogSource): Severity {
    if (read.peakPer10m >= config.rapid_errors_per_10m) return Severity.High;
    const perHour = read.errors / WINDOW_HOURS[window];
    const levels = connector === ConnectorId.OtelLogs ? OTEL_ERROR_LEVEL : ERROR_LEVEL;
    const errorLevel = (read.statusCode ?? 0) >= 500 || read.samples.some((sample) => levels.includes(sample.status));
    return perHour >= config.failing_errors_per_hour && errorLevel ? Severity.Medium : Severity.Low;
  }

  /** Creates the Alert, updates it, or reopens it as a Regression (Behaviors 2, 3, 5, 6). Returns its id. */
  private raise(
    tx: Tx,
    emit: Emit,
    scan: ScanRow,
    config: LogSourceConfig,
    service: ServiceRow,
    route: RouteRow,
    read: LogGroup,
    now: string,
  ): string {
    const fresh = read.samples.map(redactSample);
    const print = fingerprint(
      service.id,
      route.method,
      route.path,
      signatureOf(read.samples),
      read.statusCode,
      scan.connector,
    );
    const severity = this.severity(config, scan.windowSize, read, scan.connector);
    const existing = tx.select().from(alerts).where(eq(alerts.fingerprint, print)).get();
    if (!existing) {
      const row = tx
        .insert(alerts)
        .values({
          id: crypto.randomUUID(),
          routeId: route.id,
          connector: scan.connector,
          fingerprint: print,
          httpStatus: read.statusCode,
          source: AlertSource.Scan,
          severity,
          title: route.method
            ? `${read.statusCode ?? ''} ${route.method} ${route.path} failing on ${service.name}`.trim()
            : `${service.name}: ${maskSignature(signatureOf(read.samples)).slice(0, 100)}`,
          logLine: fresh[0]?.message ?? '',
          eventCount: read.errors,
          firstSeenAt: now,
          lastSeenAt: now,
          samples: JSON.stringify(mergeSamples([], fresh)),
          sourceQuery: read.query,
        })
        .returning()
        .get();
      this.alerts.record(tx, row.id, AlertEventKind.Detected, AlertActor.Scan, { event_count: read.errors, severity });
      emit('alert.detected', {
        alert_id: row.id,
        severity,
        route: route.method ? { id: route.id, method: route.method, path: route.path } : null,
      });
      return row.id;
    }
    if (this.reopens(existing)) {
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
      return existing.id;
    }
    // A resolved Alert that has not been seen healthy since stays as it is.
    if (existing.status === AlertStatus.Resolved) {
      tx.update(alerts).set({ updatedAt: now }).where(eq(alerts.id, existing.id)).run();
      return existing.id;
    }
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
    return existing.id;
  }

  /** A resolved or dismissed Alert reopens once a Scan saw it healthy after its last failing sighting. */
  private reopens(alert: AlertRow): boolean {
    if (alert.status !== AlertStatus.Resolved && alert.status !== AlertStatus.Dismissed) return false;
    const boundary = [alert.lastSeenAt, alert.resolvedAt ?? ''].sort().at(-1) as string;
    return alert.clearedAt !== null && alert.clearedAt > boundary;
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
