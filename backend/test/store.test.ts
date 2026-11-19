import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Module } from '@nestjs/common';
import Database from 'better-sqlite3';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { StartupRecovery } from '../src/common/recovery';
import { applyMigrations } from '../src/db/migrate';
import { openSqlite } from '../src/db/open';
import { freePort, MIGRATIONS_DIR, startTestDaemon, tempDir } from './helpers';

function tables(dataDir: string): string[] {
  const db = new Database(path.join(dataDir, 'state.db'), { readonly: true });
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
    name: string;
  }[];
  db.close();
  return names.map((row) => row.name);
}

/** A copy of the real migrations plus one extra, as Drizzle Kit would write it. */
async function migrationsWith(extra: { tag: string; sql: string }): Promise<string> {
  const dir = await tempDir('migrations-');
  await cp(MIGRATIONS_DIR, dir, { recursive: true });
  const journalFile = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8'));
  const last = journal.entries.at(-1);
  journal.entries.push({ ...last, idx: last.idx + 1, tag: extra.tag, when: last.when + 1 });
  await writeFile(journalFile, JSON.stringify(journal));
  await writeFile(path.join(dir, `${extra.tag}.sql`), extra.sql);
  return dir;
}

describe('state.db migrations', () => {
  it('creates state.db with every migration on an empty folder, and keeps rows on a later start', async () => {
    const dataDir = await tempDir();
    const first = await startTestDaemon({ dataDir });
    expect(tables(dataDir)).toContain('settings');
    await first.stop();

    const db = new Database(path.join(dataDir, 'state.db'));
    db.prepare("INSERT INTO settings (key, value) VALUES ('kept', '1')").run();
    db.close();

    const migrations = await migrationsWith({
      tag: '0001_notes',
      sql: 'CREATE TABLE `notes` (`id` text PRIMARY KEY NOT NULL) STRICT;',
    });
    const second = await startTestDaemon({ dataDir, migrationsDir: migrations });
    await second.stop();

    expect(tables(dataDir)).toContain('notes');
    const reopened = new Database(path.join(dataDir, 'state.db'), { readonly: true });
    expect(reopened.prepare("SELECT value FROM settings WHERE key = 'kept'").get()).toEqual({ value: '1' });
    reopened.close();
  });

  it('rolls back a failing migration, exits and names it in the log', async () => {
    const dataDir = await tempDir();
    await (await startTestDaemon({ dataDir })).stop();
    const before = tables(dataDir);

    const migrations = await migrationsWith({
      tag: '0001_broken',
      sql: 'CREATE TABLE `half_done` (`id` text PRIMARY KEY NOT NULL) STRICT;\n--> statement-breakpoint\nCREATE TABLE oops (;',
    });
    const log: string[] = [];
    await expect(startTestDaemon({ dataDir, migrationsDir: migrations, log })).rejects.toThrow(/0001_broken/);

    expect(log.join('\n')).toMatch(/migration 0001_broken failed/);
    expect(tables(dataDir)).toEqual(before);
    await (await startTestDaemon({ dataDir })).stop();
  });
});

type Row = Record<string, string | number | null>;

/** Inserts `values`, filling every other NOT NULL column that has no default so a fixture names only what it tests. */
function insert(db: Database.Database, table: string, values: Row): void {
  const columns = db.pragma(`table_info(${table})`) as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }[];
  const row: Row = { ...values };
  for (const { name, type, notnull, dflt_value } of columns) {
    if (notnull && dflt_value === null && !(name in row)) row[name] = type.toLowerCase() === 'integer' ? 0 : 'x';
  }
  const names = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(
    ...Object.values(row),
  );
}

const dump = (db: Database.Database, table: string): unknown[] =>
  db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();

describe('migration that drops the connector CHECK', () => {
  it('keeps every row of the three tables and of what hangs off them, with foreign keys on', async () => {
    const before = await tempDir('migrations-');
    await cp(MIGRATIONS_DIR, before, { recursive: true });
    const journalFile = path.join(before, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalFile, 'utf8')) as { entries: { tag: string }[] };
    const index = journal.entries.findIndex((entry) => entry.tag === '0043_cloudwatch_log_source');
    journal.entries.length = index;
    await writeFile(journalFile, JSON.stringify(journal));

    const dataDir = await tempDir();
    const db = openSqlite(dataDir);
    applyMigrations(db, before, () => {});
    expect(() => insert(db, 'services', { id: 'bad', name: 'x', env: 'x', connector: 'cloudwatch_logs' })).toThrow(
      /CHECK/,
    );

    insert(db, 'services', { id: 's-dd', name: 'shop-api', env: 'prod', connector: 'datadog' });
    insert(db, 'services', { id: 's-ot', name: 'shop-api', env: 'prod', connector: 'otel_logs' });
    insert(db, 'routes', { id: 'r-dd', service_id: 's-dd', method: 'GET', path: '/a' });
    insert(db, 'routes', { id: 'r-ot', service_id: 's-ot', method: 'GET', path: '/a' });
    insert(db, 'scans', { id: 'sc-dd', service_id: 's-dd', connector: 'datadog' });
    insert(db, 'scans', { id: 'sc-ot', service_id: null, connector: 'otel_logs' });
    insert(db, 'scan_route_results', {
      scan_id: 'sc-dd',
      route_id: 'r-dd',
      scanned_at: 'x',
      error_count: 3,
      state: 'failing',
    });
    insert(db, 'alerts', {
      id: 'a-dd',
      route_id: 'r-dd',
      connector: 'datadog',
      fingerprint: 'f1',
      status: 'verified',
      samples: '[{"id":"1"}]',
    });
    insert(db, 'alerts', {
      id: 'a-ot',
      route_id: 'r-ot',
      connector: 'otel_logs',
      fingerprint: 'f2',
      status: 'open',
      regression_count: 2,
    });
    insert(db, 'alert_events', { id: 'e1', alert_id: 'a-dd', kind: 'verified', actor: 'agent' });
    insert(db, 'reports', { id: 'rep1', alert_id: 'a-dd', version: 1 });
    insert(db, 'reviews', { id: 'rev1', report_id: 'rep1', decision: 'rejected' });
    insert(db, 'sessions', { id: 'ses1', alert_id: 'a-dd' });
    insert(db, 'action_log', { id: 'act1', alert_id: 'a-ot' });

    const tables = [
      'services',
      'routes',
      'scans',
      'scan_route_results',
      'alerts',
      'alert_events',
      'reports',
      'reviews',
      'sessions',
      'action_log',
    ];
    const rows = Object.fromEntries(tables.map((table) => [table, dump(db, table)]));

    applyMigrations(db, MIGRATIONS_DIR, () => {});

    for (const table of tables) expect(dump(db, table), table).toEqual(rows[table]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    // The unique key still holds, and a third source is accepted.
    expect(() => insert(db, 'services', { id: 'dup', name: 'shop-api', env: 'prod', connector: 'otel_logs' })).toThrow(
      /UNIQUE/,
    );
    expect(() => insert(db, 'alerts', { id: 'dup', route_id: 'r-dd', fingerprint: 'f1' })).toThrow(/UNIQUE/);
    insert(db, 'services', { id: 's-cw', name: 'shop-api', env: 'prod', connector: 'cloudwatch_logs' });

    // The children still point at the rebuilt tables: a Service's delete still cascades.
    db.prepare("DELETE FROM services WHERE id = 's-dd'").run();
    expect(db.prepare('SELECT id FROM alerts').all()).toEqual([{ id: 'a-ot' }]);
    expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'ses1' }]);
    expect(db.prepare('SELECT alert_id FROM sessions').get()).toEqual({ alert_id: null });
    db.close();
  });
});

describe('start-up recovery', () => {
  it('runs every registered function in order, before the port opens', async () => {
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    @Injectable()
    class Recoveries {
      constructor(@Inject(StartupRecovery) recovery: StartupRecovery) {
        recovery.register('first', async () => {
          order.push('first');
          await gate;
        });
        recovery.register('second', () => {
          order.push('second');
        });
      }
    }
    @Module({ providers: [Recoveries] })
    class RecoveryFixtureModule {}

    const port = await freePort();
    const starting = startTestDaemon({ port, modules: [{ module: RecoveryFixtureModule }] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual(['first']);
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();

    release();
    const daemon = await starting;
    expect(order).toEqual(['first', 'second']);
    const health = await request(daemon.url).get('/api/health').set('Authorization', `Bearer ${daemon.token}`);
    expect(health.status).toBe(200);
    await daemon.stop();
  });
});
