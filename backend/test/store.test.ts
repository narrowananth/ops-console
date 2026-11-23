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

/** A later migration gives `sessions` the columns of a PR action Session. */
const withoutPrAction = (row: Row): Row =>
  Object.fromEntries(Object.entries(row).filter(([name]) => !name.startsWith('pr_action')));

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
    // A later migration moves these columns out of `sessions`.
    rows.sessions = (rows.sessions as Row[]).map(
      ({ opened_pr_number, opened_pr_url, opened_pr_branch, ...rest }) => rest,
    );

    applyMigrations(db, MIGRATIONS_DIR, () => {});

    for (const table of tables) {
      const after = dump(db, table);
      expect(table === 'sessions' ? (after as Row[]).map(withoutPrAction) : after, table).toEqual(rows[table]);
    }
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

describe('migration that moves the opened pull request into a list', () => {
  it('gives a Session that remembered one pull request one entry, and changes nothing else', async () => {
    const before = await tempDir('migrations-');
    await cp(MIGRATIONS_DIR, before, { recursive: true });
    const journalFile = path.join(before, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalFile, 'utf8')) as { entries: { tag: string }[] };
    const index = journal.entries.findIndex((entry) => entry.tag === '0046_session_pull_requests');
    journal.entries.length = index;
    await writeFile(journalFile, JSON.stringify(journal));

    const db = openSqlite(await tempDir());
    applyMigrations(db, before, () => {});
    insert(db, 'sessions', {
      id: 'remembered',
      title: 'Fix totals',
      branch: 'fix-total',
      created_at: '2026-10-01T10:00:00.000Z',
      opened_pr_number: 41,
      opened_pr_url: 'https://github.com/acme/orders-api/pull/41',
      opened_pr_branch: 'fix-total',
    });
    insert(db, 'sessions', { id: 'plain', title: 'Look around' });
    insert(db, 'sessions', { id: 'half', opened_pr_number: 9 });
    const sessionsBefore = db.prepare('SELECT * FROM sessions ORDER BY id').all() as Row[];

    applyMigrations(db, MIGRATIONS_DIR, () => {});

    expect(db.prepare('SELECT * FROM session_pull_requests').all()).toEqual([
      {
        session_id: 'remembered',
        number: 41,
        url: 'https://github.com/acme/orders-api/pull/41',
        branch: 'fix-total',
        created_at: '2026-10-01T10:00:00.000Z',
      },
    ]);
    const dropped = ['opened_pr_number', 'opened_pr_url', 'opened_pr_branch'];
    const sessionsAfter = (db.prepare('SELECT * FROM sessions ORDER BY id').all() as Row[]).map(withoutPrAction);
    expect(sessionsAfter).toEqual(
      sessionsBefore.map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => !dropped.includes(name)))),
    );
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // The list goes with its Session.
    db.prepare("DELETE FROM sessions WHERE id = 'remembered'").run();
    expect(db.prepare('SELECT * FROM session_pull_requests').all()).toEqual([]);
    db.close();
  });
});

type Json = Record<string, unknown>;
type Migrated = { id: string; status: string; status_detail: string | null; config: Json };

describe('migration that drops the typed log source fields', () => {
  const OLD_LOKI = {
    url: 'https://loki.example.com',
    org_id: 'tenant-1',
    auth: 'bearer',
    username: '',
    service_label: 'service_name',
    env_label: 'deployment_environment_name',
    selector: 'cluster="prod-1"',
    format: 'json',
    environments: ['prod', 'staging'],
    daily_scan_time: '06:30',
    default_interval: '12h',
    rapid_errors_per_10m: 50,
    failing_errors_per_hour: 3,
    ignore: [{ kind: 'route', value: '/health' }],
    reports_folder: 'reports',
  };
  const OLD_NEW_RELIC = {
    account_id: '1234567',
    region: 'EU',
    service_attribute: 'service.name',
    env_attribute: 'environment',
    filter: "cluster = 'prod-1'",
    environments: ['prod'],
    daily_scan_time: '09:00',
    default_interval: '24h',
    rapid_errors_per_10m: 100,
    failing_errors_per_hour: 5,
    ignore: [],
    reports_folder: 'reports',
  };

  /** A state.db at migration 0046 with the two log source rows set as `loki` and `newRelic` say, then migrated. */
  async function migrated(
    loki: { status: string; config: Json },
    newRelic: { status: string; config: Json },
  ): Promise<Record<string, Migrated>> {
    const before = await tempDir('migrations-');
    await cp(MIGRATIONS_DIR, before, { recursive: true });
    const journalFile = path.join(before, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalFile, 'utf8')) as { entries: { tag: string }[] };
    const index = journal.entries.findIndex((entry) => entry.tag === '0047_one_click_log_sources');
    journal.entries.length = index;
    await writeFile(journalFile, JSON.stringify(journal));
    const db = openSqlite(await tempDir());
    applyMigrations(db, before, () => {});
    const set = db.prepare('UPDATE connectors SET status = ?, status_detail = NULL, config = ? WHERE id = ?');
    set.run(loki.status, JSON.stringify(loki.config), 'loki_logs');
    set.run(newRelic.status, JSON.stringify(newRelic.config), 'new_relic_logs');
    applyMigrations(db, MIGRATIONS_DIR, () => {});
    const rows = db
      .prepare("SELECT id, status, status_detail, config FROM connectors WHERE id IN ('loki_logs', 'new_relic_logs')")
      .all() as {
      id: string;
      status: string;
      status_detail: string | null;
      config: string;
    }[];
    db.close();
    return Object.fromEntries(rows.map((row) => [row.id, { ...row, config: JSON.parse(row.config) }]));
  }

  it('moves a connected Grafana Cloud Loki and a connected New Relic to needs auth, and keeps their other settings', async () => {
    const rows = await migrated(
      { status: 'ok', config: { ...OLD_LOKI, url: 'https://logs-prod-012.grafana.net' } },
      { status: 'ok', config: OLD_NEW_RELIC },
    );
    expect(rows.loki_logs).toMatchObject({ status: 'auth', status_detail: 'Sign in again to use Grafana Cloud.' });
    expect(rows.loki_logs?.config).toEqual({
      datasource_uid: '',
      environments: ['prod', 'staging'],
      daily_scan_time: '06:30',
      default_interval: '12h',
      rapid_errors_per_10m: 50,
      failing_errors_per_hour: 3,
      ignore: [{ kind: 'route', value: '/health' }],
      reports_folder: 'reports',
    });
    expect(rows.new_relic_logs).toMatchObject({
      status: 'auth',
      status_detail: 'Sign in again to use the New Relic MCP server.',
    });
    expect(rows.new_relic_logs?.config).toEqual({
      account_id: '1234567',
      region: 'EU',
      environments: ['prod'],
      daily_scan_time: '09:00',
      default_interval: '24h',
      rapid_errors_per_10m: 100,
      failing_errors_per_hour: 5,
      ignore: [],
      reports_folder: 'reports',
    });
  });

  it('says a Loki that held a self-hosted URL reads Grafana Cloud only, and treats a never-set URL like Grafana Cloud', async () => {
    const hosted = await migrated({ status: 'fail', config: OLD_LOKI }, { status: 'off', config: OLD_NEW_RELIC });
    expect(hosted.loki_logs).toMatchObject({
      status: 'auth',
      status_detail: 'Loki on Grafana Cloud only: the self-hosted URL is no longer read.',
    });
    const unset = await migrated(
      { status: 'auth', config: { ...OLD_LOKI, url: '' } },
      { status: 'off', config: OLD_NEW_RELIC },
    );
    expect(unset.loki_logs).toMatchObject({ status: 'auth', status_detail: 'Sign in again to use Grafana Cloud.' });
  });

  it('reads a Loki row with no url key like one with an empty url', async () => {
    const { url: _url, ...noUrl } = OLD_LOKI;
    const rows = await migrated({ status: 'ok', config: noUrl }, { status: 'off', config: OLD_NEW_RELIC });
    expect(rows.loki_logs).toMatchObject({ status: 'auth', status_detail: 'Sign in again to use Grafana Cloud.' });
  });

  it('leaves a Connector that is off off, and still drops its typed fields so the config reads', async () => {
    const rows = await migrated({ status: 'off', config: OLD_LOKI }, { status: 'off', config: OLD_NEW_RELIC });
    expect(rows.loki_logs).toMatchObject({ status: 'off', status_detail: null });
    expect(rows.new_relic_logs).toMatchObject({ status: 'off', status_detail: null });
    expect(Object.keys(rows.loki_logs?.config as Json)).not.toContain('url');
    expect(Object.keys(rows.new_relic_logs?.config as Json)).not.toContain('filter');
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

describe('migration that ends the pull request jobs', () => {
  it('drops the old job rows and their steps, and keeps Sessions, comment records and the steps of Verifications and Fixes', async () => {
    const before = await tempDir('migrations-');
    await cp(MIGRATIONS_DIR, before, { recursive: true });
    const journalFile = path.join(before, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalFile, 'utf8')) as { entries: { tag: string }[] };
    const index = journal.entries.findIndex((entry) => entry.tag === '0049_rainy_stark_industries');
    journal.entries.length = index;
    await writeFile(journalFile, JSON.stringify(journal));

    const db = openSqlite(await tempDir());
    applyMigrations(db, before, () => {});
    // The rows these hang off are beside the point here.
    db.pragma('foreign_keys = OFF');
    insert(db, 'sessions', { id: 'ses', title: 'Keep me' });
    insert(db, 'pr_comment_passes', {
      id: 'cp1',
      repo_id: 'r1',
      pr_number: 1,
      head_sha: 'x',
      branch: 'b',
      threads: '[]',
    });
    insert(db, 'pr_reply_checks', { id: 'rc1', repo_id: 'r1', pr_number: 1, comment_id: 'c', head_sha: 'x' });
    insert(db, 'pr_agent_reviews', { id: 'ar1', repo_id: 'r1', pr_number: 1, head_sha: 'x' });
    insert(db, 'agent_comments', { repo_id: 'r1', pr_number: 1, comment_id: 'c1', agent_review_id: 'ar1' });
    const step = { position: 0, title: 'Step', instructions: 'Do it' };
    insert(db, 'playbook_steps', { id: 'kept', report_id: 'rep1', ...step });
    insert(db, 'playbook_steps', { id: 'gone-pass', comment_pass_id: 'cp1', ...step });
    insert(db, 'playbook_steps', { id: 'gone-review', agent_review_id: 'ar1', ...step });
    db.pragma('foreign_keys = ON');

    applyMigrations(db, MIGRATIONS_DIR, () => {});

    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).not.toContain('pr_comment_passes');
    expect(names).not.toContain('pr_reply_checks');
    expect(db.prepare('SELECT id FROM playbook_steps').all()).toEqual([{ id: 'kept' }]);
    expect(db.prepare('SELECT id FROM pr_agent_reviews').all()).toEqual([]);
    expect(db.prepare('SELECT comment_id, agent_review_id FROM agent_comments').all()).toEqual([
      { comment_id: 'c1', agent_review_id: null },
    ]);
    expect(db.prepare('SELECT id, title, pr_action FROM sessions').all()).toEqual([
      { id: 'ses', title: 'Keep me', pr_action: null },
    ]);
    // A pull request has one unsubmitted PR action Session per action.
    db.pragma('foreign_keys = OFF');
    insert(db, 'sessions', { id: 'a1', repo_id: 'r1', pr_number: 1, pr_action: 'review' });
    expect(() => insert(db, 'sessions', { id: 'a2', repo_id: 'r1', pr_number: 1, pr_action: 'review' })).toThrow(
      /UNIQUE/,
    );
    db.close();
  });
});
