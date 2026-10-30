import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Module } from '@nestjs/common';
import Database from 'better-sqlite3';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { StartupRecovery } from '../src/common/recovery';
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
