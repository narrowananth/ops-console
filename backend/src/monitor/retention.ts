import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CheckInterval } from '@ops-console/shared';
import { AlertActor, AlertEventKind, AlertStatus, ScanStatus } from '@ops-console/shared';
import { and, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { alertEvents, alerts, scans, services } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { everyMinutes, Scheduler } from '../scheduler/scheduler';
import { datadogConfig } from './datadog-config';
import { scanReads } from './freshness';

/** An open Alert no Scan has seen for this long is resolved. */
export const AUTO_RESOLVE_DAYS = 14;
/** Scans, their Route results and Alert events older than this are deleted. */
export const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

/** Rows per statement: the driver is synchronous, so a statement holds the daemon while it runs. */
const BATCH = 200;
/** Scans per statement: each takes its Route results with it. */
const SCAN_BATCH = 50;
const PAUSE_MS = 25;
/** After a Scan, the pass runs at most this often; the daily slot catches the rest. */
const AFTER_SCAN_EVERY_MS = 60 * 60_000;

/** Alerts in these states have work the operator or the agent is on; their history stays. */
const IN_FLIGHT = [AlertStatus.Verifying, AlertStatus.Verified, AlertStatus.Fixing, AlertStatus.PrOpen];

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * What the Monitor keeps. An open Alert not seen for 14 days is resolved, with an Alert event saying so. Scans, their
 * Route results and Alert events older than 30 days go, except the newest `ok` Scan that read each Service, so
 * Freshness and each Route's state stay. The Action Log is never touched.
 */
@Injectable()
export class MonitorRetention {
  private readonly logger = new Logger('monitor');
  private running: Promise<void> | null = null;
  private lastRun = 0;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(Scheduler) scheduler: Scheduler,
  ) {
    scheduler.register({
      name: 'monitor-retention',
      nextSlot: everyMinutes(24 * 60),
      run: () => this.run(),
      lastRunAt: () => null,
    });
  }

  /** After a finished Scan, in the background. */
  afterScan(): void {
    if (Date.now() - this.lastRun < AFTER_SCAN_EVERY_MS) return;
    void this.run().catch((error) =>
      this.logger.warn(`monitor retention failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  /** A second call while one runs waits for it. */
  run(now = new Date()): Promise<void> {
    this.running ??= this.prune(now).finally(() => {
      this.running = null;
      this.lastRun = Date.now();
    });
    return this.running;
  }

  private async prune(now: Date): Promise<void> {
    await this.resolveStale(new Date(now.getTime() - AUTO_RESOLVE_DAYS * DAY_MS).toISOString(), now.toISOString());
    const cutoff = new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString();
    await this.pruneScans(cutoff);
    await this.pruneEvents(cutoff);
  }

  private async resolveStale(before: string, now: string): Promise<void> {
    for (;;) {
      const done = this.store.write((tx) => {
        const stale = tx
          .select({ id: alerts.id, lastSeenAt: alerts.lastSeenAt, clearedAt: alerts.clearedAt })
          .from(alerts)
          .where(and(eq(alerts.status, AlertStatus.Open), lt(alerts.lastSeenAt, before)))
          .limit(BATCH)
          .all();
        for (const alert of stale) {
          // Resolved at its last sighting and cleared now: the next failing Scan reopens it as a Regression at once.
          tx.update(alerts)
            .set({ status: AlertStatus.Resolved, resolvedAt: alert.lastSeenAt, clearedAt: now, updatedAt: now })
            .where(eq(alerts.id, alert.id))
            .run();
          tx.insert(alertEvents)
            .values({
              id: crypto.randomUUID(),
              alertId: alert.id,
              kind: AlertEventKind.AutoResolved,
              actor: AlertActor.Scan,
              data: JSON.stringify({ not_seen_days: AUTO_RESOLVE_DAYS, last_seen_at: alert.lastSeenAt }),
            })
            .run();
        }
        return stale.length;
      });
      if (done < BATCH) return;
      await pause(PAUSE_MS);
    }
  }

  /** The ids of the newest `ok` Scan that read each Service, and of the newest one that read it for every status code. */
  private keptScans(): string[] {
    const ok = this.store.db
      .select()
      .from(scans)
      .where(eq(scans.status, ScanStatus.Ok))
      .orderBy(sql`${scans.finishedAt} desc`)
      .all();
    const interval = datadogConfig(this.store.db).default_interval as CheckInterval;
    const kept = new Set<string>();
    for (const service of this.store.db.select().from(services).all()) {
      const reads = ok.filter((scan) => scanReads(scan, service, interval));
      const newest = reads[0];
      const allCodes = reads.find((scan) => scan.statusCodes === '[]');
      if (newest) kept.add(newest.id);
      if (allCodes) kept.add(allCodes.id);
    }
    return [...kept];
  }

  private async pruneScans(cutoff: string): Promise<void> {
    const kept = this.keptScans();
    for (;;) {
      const old = this.store.db
        .select({ id: scans.id })
        .from(scans)
        .where(
          and(
            lt(scans.startedAt, cutoff),
            notInArray(scans.status, [ScanStatus.Running]),
            kept.length > 0 ? notInArray(scans.id, kept) : undefined,
          ),
        )
        .limit(SCAN_BATCH)
        .all()
        .map((scan) => scan.id);
      if (old.length === 0) return;
      // The Route results go with their Scan.
      this.store.write((tx) => tx.delete(scans).where(inArray(scans.id, old)).run());
      if (old.length < SCAN_BATCH) return;
      await pause(PAUSE_MS);
    }
  }

  private async pruneEvents(cutoff: string): Promise<void> {
    for (;;) {
      const old = this.store.db
        .select({ id: alertEvents.id })
        .from(alertEvents)
        .innerJoin(alerts, eq(alerts.id, alertEvents.alertId))
        .where(and(lt(alertEvents.at, cutoff), notInArray(alerts.status, IN_FLIGHT)))
        .limit(BATCH)
        .all()
        .map((event) => event.id);
      if (old.length === 0) return;
      this.store.write((tx) => tx.delete(alertEvents).where(inArray(alertEvents.id, old)).run());
      if (old.length < BATCH) return;
      await pause(PAUSE_MS);
    }
  }
}
