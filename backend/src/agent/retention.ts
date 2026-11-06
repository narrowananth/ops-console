import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { STORE, type Store } from '../db/store';

/** How long the console keeps the steps, subagents and costs of finished runs. */
export const KEEP_DAYS = 90;
const DAY_MS = 86_400_000;

/**
 * Rows deleted per statement. The database driver is synchronous, so a statement holds the whole daemon while it runs.
 * Measured on 720,000 step rows: a single delete of the 360,000 past the keep time held the daemon for 1.2 s, batches
 * of 1,000 for up to 150 ms each, batches of 250 for about 20 ms.
 */
export const BATCH_ROWS = 250;
/** A pause between batches, so requests, the socket and runs go first. */
const PAUSE_MS = 25;
const CHECK_EVERY_MS = DAY_MS;
const FIRST_CHECK_MS = 60_000;

/** A table that keeps the history of runs, and the indexed timestamp column that says how old a row is. */
export type Retained = { table: string; column: string };

export const RETAINED: Retained[] = [
  { table: 'run_steps', column: 'started_at' },
  { table: 'run_agents', column: 'started_at' },
  { table: 'run_usage', column: 'finished_at' },
  { table: 'health_checks', column: 'checked_at' },
];

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Deletes what is older than the keep time, oldest first, a small batch at a time, each batch in its own short
 * transaction. It runs once after start and then daily, never at the start of a run, and never as one bulk delete.
 */
@Injectable()
export class Retention implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('retention');
  private timers: NodeJS.Timeout[] = [];
  private running: Promise<number> | null = null;

  constructor(@Inject(STORE) private readonly store: Store) {}

  onApplicationBootstrap(): void {
    const first = setTimeout(() => void this.run().catch(this.failed), FIRST_CHECK_MS);
    const daily = setInterval(() => void this.run().catch(this.failed), CHECK_EVERY_MS);
    first.unref();
    daily.unref();
    this.timers = [first, daily];
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }

  private readonly failed = (error: unknown): void =>
    this.logger.warn(`pruning failed: ${error instanceof Error ? error.message : error}`);

  /** Prunes every retained table; a second call while one runs waits for it. Returns the rows deleted. */
  run(options: { now?: Date; batch?: number; pauseMs?: number } = {}): Promise<number> {
    this.running ??= this.prune(options).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async prune({ now = new Date(), batch = BATCH_ROWS, pauseMs = PAUSE_MS }): Promise<number> {
    const before = new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString();
    let total = 0;
    for (const { table, column } of RETAINED) {
      for (;;) {
        const deleted = this.deleteBatch(table, column, before, batch);
        total += deleted;
        if (deleted < batch) break;
        await pause(pauseMs);
      }
    }
    // Keeps the write-ahead log from holding the deleted pages; free pages are reused by new rows.
    if (total > 0) this.store.checkpoint();
    if (total > 0) this.logger.log(`pruned ${total} rows older than ${KEEP_DAYS} days`);
    return total;
  }

  /** The oldest `batch` rows past `before`, by the column's index; table and column come from `RETAINED` only. */
  private deleteBatch(table: string, column: string, before: string, batch: number): number {
    return this.store.write((tx) => {
      const from = sql.identifier(table);
      const by = sql.identifier(column);
      const result = tx.run(
        sql`delete from ${from} where rowid in (select rowid from ${from} where ${by} < ${before} order by ${by} limit ${batch})`,
      );
      return result.changes;
    });
  }
}
