import path from 'node:path';
import Database from 'better-sqlite3';

export function openSqlite(dataDir: string): Database.Database {
  const sqlite = new Database(path.join(dataDir, 'state.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return sqlite;
}
