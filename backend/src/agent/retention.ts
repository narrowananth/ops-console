import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AccountsService } from '../accounts/accounts.service';
import { StartupQueue } from '../common/startup-queue';
import { sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { skillRunsDir } from './skill-plugin';
import { Transcripts } from './transcripts';

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

/** A transcript no Session holds is deleted after this long without a write. */
export const ORPHAN_TRANSCRIPT_DAYS = 14;
/** A run's Skill folder is deleted by the start-up sweep once it is this old: a run that old is long over. */
const SKILL_FOLDER_HOURS = 24;
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

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(Transcripts) private readonly transcripts: Transcripts,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(StartupQueue) private readonly startup: StartupQueue,
  ) {}

  onApplicationBootstrap(): void {
    this.startup.add('sweep of Skill folders', () => this.sweepSkillFolders().catch(this.failed));
    const sweep = () => void Promise.all([this.run(), this.sweepTranscripts()]).catch(this.failed);
    const first = setTimeout(sweep, FIRST_CHECK_MS);
    const daily = setInterval(sweep, CHECK_EVERY_MS);
    first.unref();
    daily.unref();
    this.timers = [first, daily];
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }

  private readonly failed = (error: unknown): void =>
    this.logger.warn(`pruning failed: ${error instanceof Error ? error.message : error}`);

  /** Deletes the transcripts of conversations no Session holds any more, such as one a first-message edit replaced. */
  async sweepTranscripts(): Promise<number> {
    const held = new Set(
      this.store.db
        .select({ id: sessions.sdkSessionId })
        .from(sessions)
        .all()
        .flatMap((row) => (row.id === null ? [] : [row.id])),
    );
    const removed = await this.transcripts.sweep(
      this.accounts.all().map((account) => account.configDir),
      held,
      ORPHAN_TRANSCRIPT_DAYS * DAY_MS,
    );
    if (removed > 0) this.logger.log(`deleted ${removed} transcripts no Session holds`);
    return removed;
  }

  /** Deletes what crashed runs left of their Skill folders in the temp folder. */
  async sweepSkillFolders(): Promise<void> {
    const root = skillRunsDir();
    const before = Date.now() - SKILL_FOLDER_HOURS * 3_600_000;
    for (const name of await readdir(root).catch(() => [])) {
      const folder = path.join(root, name);
      const info = await stat(folder).catch(() => null);
      if (info !== null && info.mtimeMs < before) await rm(folder, { recursive: true, force: true });
    }
  }

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
