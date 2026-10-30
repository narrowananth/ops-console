import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number(), tag: z.string(), when: z.number() })),
});

const lastRunSchema = z.object({ at: z.number().nullable() });

export class MigrationFailedError extends Error {
  constructor(
    readonly tag: string,
    cause: unknown,
  ) {
    super(`migration ${tag} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/**
 * Applies pending Drizzle Kit migrations from `dir`, recording them in Drizzle's own table. Every pending
 * migration runs in one transaction, so a failure leaves `state.db` as it was before this start.
 */
export function applyMigrations(sqlite: Database.Database, dir: string, log: (message: string) => void): void {
  const journal = journalSchema.parse(JSON.parse(readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')));
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)',
  );
  const last = lastRunSchema.parse(sqlite.prepare('SELECT max(created_at) AS at FROM __drizzle_migrations').get());
  const pending = journal.entries.filter((entry) => entry.when > (last.at ?? 0)).sort((a, b) => a.idx - b.idx);
  if (pending.length === 0) {
    log('migrations up to date');
    return;
  }

  const record = sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)');
  sqlite.exec('BEGIN IMMEDIATE');
  for (const entry of pending) {
    try {
      const text = readFileSync(path.join(dir, `${entry.tag}.sql`), 'utf8');
      for (const statement of text.split('--> statement-breakpoint')) {
        if (statement.trim()) sqlite.exec(statement);
      }
      record.run(createHash('sha256').update(text).digest('hex'), entry.when);
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw new MigrationFailedError(entry.tag, error);
    }
  }
  sqlite.exec('COMMIT');
  for (const entry of pending) log(`applied migration ${entry.tag}`);
}
