import path from 'node:path';
import Database from 'better-sqlite3';

export function openSqlite(dataDir: string): Database.Database {
  const sqlite = new Database(path.join(dataDir, 'state.db'));
  sqlite.pragma('journal_mode = WAL');
  // The driver is synchronous, so every commit holds the daemon's one thread. In WAL mode NORMAL waits for the disk
  // only at a checkpoint, not at each commit, and loses no committed data short of a power cut.
  sqlite.pragma('synchronous = NORMAL');
  // A log that grew once (a migration, a big delete) is cut back to this after the next checkpoint.
  sqlite.pragma(`journal_size_limit = ${32 * 1024 * 1024}`);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return sqlite;
}
