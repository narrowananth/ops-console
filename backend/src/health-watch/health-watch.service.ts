import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import {
  CheckTarget,
  ConnectionEnv,
  ConnectorId,
  ErrorCode,
  HEALTH_CHECKS_DEFAULT,
  HealthArea,
  type HealthAreaState,
  HealthInterval,
  type HealthItem,
  type HealthOverview,
  HealthStatus,
  healthChecksSettingSchema,
  isFailing,
  type WsEvent,
} from '@ops-console/shared';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { WsHub } from '../common/ws-hub';
import { ConnectionsService } from '../connections/connections.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { connections, healthChecks } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { ConnectionServers, McpServersService } from '../mcp/mcp-servers.service';
import { SettingsRegistry } from '../settings/settings.registry';
import { SettingsService } from '../settings/settings.service';

export const HEALTH_CHECKS = 'health_checks';

const MINUTE = 60_000;
export const INTERVAL_MS: Record<HealthInterval, number | null> = {
  [HealthInterval.HalfHour]: 30 * MINUTE,
  [HealthInterval.Hour]: 60 * MINUTE,
  [HealthInterval.SixHours]: 360 * MINUTE,
  [HealthInterval.TwelveHours]: 720 * MINUTE,
  [HealthInterval.Day]: 1440 * MINUTE,
  [HealthInterval.Off]: null,
};

/** How often the scheduler looks at whether an area is due. */
const TICK_MS = 30_000;
/** The first look after the daemon starts, so start-up is not slowed by it. */
const FIRST_TICK_MS = 20_000;
/** The stripe keeps this many checks. */
const HISTORY_POINTS = 24;
/** A recovery shows on its row for this long. */
const RECOVERED_FOR_MS = 60 * MINUTE;
/** Two checks this close with the same answer are one: a burst of events is not a history. */
const SAME_ANSWER_MS = 30_000;
/** The history read per item: enough to find where its run of failures began. */
const LOOKBACK_ROWS = 200;

const AREA_OF: Record<CheckTarget, HealthArea> = {
  [CheckTarget.Connection]: HealthArea.Connections,
  [CheckTarget.Connector]: HealthArea.Integrations,
  [CheckTarget.McpServer]: HealthArea.Integrations,
};

type Point = { status: HealthStatus; at: string };

/** Walks a history, newest first, for when the current run of failures began and when a recovery happened. */
export function readHistory(
  newestFirst: Point[],
  now: number,
): { failingSince: string | null; recoveredAt: string | null; wasDown: string | null } {
  const [latest] = newestFirst;
  if (!latest) return { failingSince: null, recoveredAt: null, wasDown: null };
  if (isFailing(latest.status)) {
    let since = latest.at;
    for (const point of newestFirst) {
      if (!isFailing(point.status)) break;
      since = point.at;
    }
    return { failingSince: since, recoveredAt: null, wasDown: null };
  }
  // Answering now: a recovery when the check before the run of answers was failing, and it is recent.
  let firstOk = latest.at;
  let index = 0;
  while (newestFirst[index] && !isFailing(newestFirst[index]?.status ?? HealthStatus.Ok)) {
    firstOk = newestFirst[index]?.at ?? firstOk;
    index += 1;
  }
  const before = newestFirst[index];
  if (!before || now - Date.parse(firstOk) > RECOVERED_FOR_MS)
    return { failingSince: null, recoveredAt: null, wasDown: null };
  let began = before.at;
  for (let down = index; newestFirst[down] && isFailing(newestFirst[down]?.status ?? HealthStatus.Ok); down++) {
    began = newestFirst[down]?.at ?? began;
  }
  return { failingSince: null, recoveredAt: firstOk, wasDown: began };
}

/**
 * Checks the Connections, Connectors and MCP servers on a schedule the operator sets, keeps each check, and says when
 * one breaks or recovers. A check is whatever sends `connection.checked`, so a manual Retry counts too.
 */
@Injectable()
export class HealthWatch implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('health-watch');
  private timers: NodeJS.Timeout[] = [];
  private readonly lastRun = new Map<HealthArea, number>();
  private readonly running = new Map<HealthArea, { done: number; total: number }>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(WsHub) private readonly hub: WsHub,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ConnectionsService) private readonly connections: ConnectionsService,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(McpServersService) private readonly mcp: McpServersService,
    @Inject(ConnectionServers) private readonly connectionServers: ConnectionServers,
    @Inject(SettingsRegistry) registry: SettingsRegistry,
  ) {
    registry.register({ key: HEALTH_CHECKS, schema: healthChecksSettingSchema, default: HEALTH_CHECKS_DEFAULT });
    hub.tap((event) => {
      if (event.event === 'connection.checked') void this.record(event).catch(this.failed);
    });
  }

  private readonly failed = (error: unknown): void =>
    this.logger.warn(`health check bookkeeping failed: ${error instanceof Error ? error.message : error}`);

  onApplicationBootstrap(): void {
    for (const area of Object.values(HealthArea)) {
      const last = this.lastCheckedIn(area);
      if (last !== null) this.lastRun.set(area, last);
    }
    const first = setTimeout(() => this.tick(), FIRST_TICK_MS);
    const every = setInterval(() => this.tick(), TICK_MS);
    first.unref();
    every.unref();
    this.timers = [first, every];
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }

  private intervals() {
    return this.settings.get(HEALTH_CHECKS, healthChecksSettingSchema);
  }

  /** Starts every area that is due. */
  tick(now = Date.now()): void {
    const setting = this.intervals();
    for (const area of Object.values(HealthArea)) {
      const every = INTERVAL_MS[setting[area]];
      if (every === null || this.running.has(area)) continue;
      const last = this.lastRun.get(area);
      if (last === undefined || now - last >= every) void this.run(area).catch(this.failed);
    }
  }

  /** Checks everything in the area, one at a time, and settles when the last one answered. */
  async run(area: HealthArea): Promise<void> {
    if (this.running.has(area)) return;
    // Marked before the list is read, so a second click or tick does not start another run.
    const state = { done: 0, total: 0 };
    this.running.set(area, state);
    this.lastRun.set(area, Date.now());
    const work = await this.work(area);
    state.total = work.length;
    try {
      for (const job of work) {
        try {
          await job();
        } catch (error) {
          this.logger.debug(`a ${area} check failed to run: ${error instanceof Error ? error.message : error}`);
        }
        state.done += 1;
      }
    } finally {
      this.running.delete(area);
      this.lastRun.set(area, Date.now());
    }
  }

  /** Starts a run and answers at once; the page follows it through `checking`. */
  start(area: HealthArea): void {
    void this.run(area).catch(this.failed);
  }

  private async work(area: HealthArea): Promise<(() => Promise<unknown>)[]> {
    if (area === HealthArea.Connections) {
      return this.store.db
        .select()
        .from(connections)
        .all()
        .filter((row) => row.access !== 'none')
        .map((row) => () => this.connections.check(row.id));
    }
    const jobs: (() => Promise<unknown>)[] = [];
    for (const connector of (await this.connectors.list()).data) {
      if (connector.status !== HealthStatus.Off) jobs.push(() => this.connectors.check(connector.id));
    }
    for (const server of (await this.mcp.list()).data) {
      if (server.registered && server.enabled) jobs.push(() => this.mcp.checkOne(server.name));
    }
    return jobs;
  }

  /** Keeps one check, and says so when it turned a working thing into a failing one or back. */
  private async record(event: Extract<WsEvent, { event: 'connection.checked' }>): Promise<void> {
    const { target, id, status, detail, latency_ms: latency } = event.data;
    if (status === HealthStatus.Off || status === HealthStatus.Checking) return;
    if (target === CheckTarget.McpServer && this.connectionServers.names().has(id)) return;
    const at = event.at;
    const previous = this.store.db
      .select()
      .from(healthChecks)
      .where(and(eq(healthChecks.target, target), eq(healthChecks.targetId, id)))
      .orderBy(desc(healthChecks.checkedAt))
      .limit(1)
      .get();
    if (
      previous &&
      previous.status === status &&
      Date.parse(at) - Date.parse(previous.checkedAt) < SAME_ANSWER_MS &&
      previous.detail === detail
    ) {
      return;
    }
    this.store.write((tx) => {
      tx.insert(healthChecks)
        .values({ id: crypto.randomUUID(), target, targetId: id, status, detail, latencyMs: latency, checkedAt: at })
        .run();
    });
    const wasFailing = previous ? isFailing(previous.status as HealthStatus) : false;
    const nowFailing = isFailing(status);
    // A Connector or MCP server that never answered was never set up: nothing broke, so nothing to say.
    if (target !== CheckTarget.Connection && nowFailing && !this.everAnswered(target, id)) return;
    if (nowFailing === wasFailing && (previous !== undefined || !nowFailing)) return;
    const name = await this.nameOf(target, id);
    this.hub.publish({
      event: 'health.changed',
      at,
      data: {
        area: AREA_OF[target],
        target,
        id,
        name,
        status,
        detail,
        since: nowFailing ? at : null,
        recovered: !nowFailing,
      },
    });
  }

  private async nameOf(target: CheckTarget, id: string): Promise<string> {
    if (target === CheckTarget.Connection) {
      return this.store.db.select().from(connections).where(eq(connections.id, id)).get()?.name ?? id;
    }
    if (target === CheckTarget.Connector) {
      try {
        return (await this.connectors.get(id as ConnectorId)).name;
      } catch {
        return id;
      }
    }
    return id;
  }

  private everAnswered(target: CheckTarget, id: string): boolean {
    return (
      this.store.db
        .select({ id: healthChecks.id })
        .from(healthChecks)
        .where(
          and(eq(healthChecks.target, target), eq(healthChecks.targetId, id), eq(healthChecks.status, HealthStatus.Ok)),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  private lastCheckedIn(area: HealthArea): number | null {
    const targets = Object.values(CheckTarget).filter((target) => AREA_OF[target] === area);
    const row = this.store.db
      .select({ at: max(healthChecks.checkedAt) })
      .from(healthChecks)
      .where(inArray(healthChecks.target, targets))
      .get();
    return row?.at ? Date.parse(row.at) : null;
  }

  private history(target: CheckTarget, id: string): Point[] {
    return this.store.db
      .select({ status: healthChecks.status, at: healthChecks.checkedAt })
      .from(healthChecks)
      .where(and(eq(healthChecks.target, target), eq(healthChecks.targetId, id)))
      .orderBy(desc(healthChecks.checkedAt))
      .limit(LOOKBACK_ROWS)
      .all()
      .map((row) => ({ status: row.status as HealthStatus, at: row.at }));
  }

  private item(
    base: Pick<
      HealthItem,
      'target' | 'id' | 'name' | 'kind' | 'is_prod' | 'status' | 'detail' | 'latency_ms' | 'last_checked_at'
    >,
    now: number,
  ): HealthItem {
    const newestFirst = this.history(base.target, base.id);
    const read = readHistory(newestFirst, now);
    // What the service reads now wins over a stale history row for the pill; the history says since when.
    // A Connector or MCP server that has never answered was never set up: it is not failing, it is not in use.
    const neverSetUp =
      base.target !== CheckTarget.Connection &&
      isFailing(base.status) &&
      !newestFirst.some((p) => p.status === HealthStatus.Ok);
    const failing = isFailing(base.status) && !neverSetUp;
    return {
      ...base,
      status: neverSetUp ? HealthStatus.Off : base.status,
      area: AREA_OF[base.target],
      failing_since: failing ? (read.failingSince ?? base.last_checked_at) : null,
      recovered_at: failing ? null : read.recoveredAt,
      history: newestFirst.slice(0, HISTORY_POINTS).reverse(),
    };
  }

  /** Every item the two pages check, as it reads now, with its history. */
  async overview(now = Date.now()): Promise<HealthOverview> {
    const setting = this.intervals();
    const items: HealthItem[] = [];
    for (const row of this.store.db.select().from(connections).orderBy(connections.createdAt).all()) {
      if (row.access === 'none') continue;
      items.push(
        this.item(
          {
            target: CheckTarget.Connection,
            id: row.id,
            name: row.name,
            kind: row.type,
            is_prod: row.env === ConnectionEnv.Prod,
            status: row.status,
            detail: row.statusDetail,
            latency_ms: row.latencyMs,
            last_checked_at: row.lastCheckedAt,
          },
          now,
        ),
      );
    }
    for (const connector of (await this.connectors.list()).data) {
      items.push(
        this.item(
          {
            target: CheckTarget.Connector,
            id: connector.id,
            name: connector.name,
            kind: connector.id,
            is_prod: false,
            status: connector.status,
            detail: connector.status_detail,
            latency_ms: null,
            last_checked_at: connector.last_checked_at,
          },
          now,
        ),
      );
    }
    for (const server of (await this.mcp.list()).data) {
      if (!server.registered) continue;
      items.push(
        this.item(
          {
            target: CheckTarget.McpServer,
            id: server.name,
            name: server.name,
            kind: 'mcp',
            is_prod: false,
            status: server.enabled ? server.status : HealthStatus.Off,
            detail: server.status_detail,
            latency_ms: null,
            last_checked_at: null,
          },
          now,
        ),
      );
    }
    const area = (which: HealthArea): HealthAreaState => {
      const every = INTERVAL_MS[setting[which]];
      const last = this.lastRun.get(which);
      return {
        interval: setting[which],
        last_checked_at: last === undefined ? null : new Date(last).toISOString(),
        next_check_at: every === null ? null : new Date((last ?? now) + every).toISOString(),
        checking: this.running.get(which) ?? null,
      };
    };
    return {
      areas: { connections: area(HealthArea.Connections), integrations: area(HealthArea.Integrations) },
      items,
    };
  }

  /** Throws for a name that is not an area. */
  area(name: string): HealthArea {
    const found = Object.values(HealthArea).find((area) => area === name);
    if (!found) throw new ApiError(404, ErrorCode.NotFound, 'no such area');
    return found;
  }
}
