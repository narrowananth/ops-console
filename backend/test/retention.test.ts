import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { BATCH_ROWS, KEEP_DAYS, Retention } from '../src/agent/retention';
import { STORE, type Store } from '../src/db/store';
import { type AgentDaemon, api, startAgentDaemon } from './agent-fixtures';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

const DAY = 86_400_000;

async function start() {
  const daemon = await startAgentDaemon();
  running.push(daemon);
  return { daemon, store: daemon.app.get<Store>(STORE), retention: daemon.app.get(Retention) };
}

const count = (store: Store, table: string) =>
  store.db.get<{ c: number }>(sql`select count(*) c from ${sql.identifier(table)}`).c;

function insertSteps(store: Store, sessionId: string, prefix: string, n: number, at: string) {
  store.write((tx) => {
    for (let i = 0; i < n; i++) {
      tx.run(
        sql`insert into run_steps (id, session_id, run_started_at, tool, summary, phase, started_at, waited_ms)
            values (${`${prefix}-${i}`}, ${sessionId}, ${at}, 'Bash', 's', 'commands', ${at}, 0)`,
      );
    }
  });
}

describe('keeping 90 days of runs', () => {
  it('keeps 90 days and deletes 250 rows at a time', () => {
    expect(KEEP_DAYS).toBe(90);
    expect(BATCH_ROWS).toBe(250);
  });

  it('deletes what is past 90 days from every table and keeps the rest', async () => {
    const { daemon, store, retention } = await start();
    const id = daemon.createSession();
    const now = new Date();
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY).toISOString();
    insertSteps(store, id, 'old', 700, at(120));
    insertSteps(store, id, 'new', 20, at(10));
    store.write((tx) => {
      for (const [name, when] of [
        ['u-old-1', at(100)],
        ['u-old-2', at(91)],
        ['u-new', at(5)],
      ] as const) {
        tx.run(
          sql`insert into run_usage (id, session_id, run_started_at, finished_at, cost_usd, tokens)
              values (${name}, ${id}, ${when}, ${when}, 1, 1)`,
        );
      }
      for (const [name, when] of [
        ['a-old', at(95)],
        ['a-new', at(2)],
      ] as const) {
        tx.run(
          sql`insert into run_agents (id, session_id, run_started_at, task_id, description, status, started_at)
              values (${name}, ${id}, ${when}, ${name}, 'x', 'done', ${when})`,
        );
      }
    });

    const deleted = await retention.run({ now, batch: 100, pauseMs: 0 });

    expect(deleted).toBe(700 + 2 + 1);
    expect(count(store, 'run_steps')).toBe(20);
    expect(count(store, 'run_usage')).toBe(1);
    expect(count(store, 'run_agents')).toBe(1);
    expect((await api(daemon).get('/agent-accounts/usage?range=90d')).status).toBe(200);
  });

  it('never deletes more than one batch per statement, so the daemon is not held by a bulk delete', async () => {
    const { daemon, store, retention } = await start();
    const id = daemon.createSession();
    const now = new Date();
    insertSteps(store, id, 'o', 1000, new Date(now.getTime() - 200 * DAY).toISOString());
    const sizes: number[] = [];
    const target = retention as unknown as { deleteBatch: (...args: unknown[]) => number };
    const original = target.deleteBatch.bind(retention);
    target.deleteBatch = (...args) => {
      const changed = original(...args);
      sizes.push(changed);
      return changed;
    };

    await retention.run({ now, batch: 250, pauseMs: 0 });

    expect(sizes.filter((size) => size > 0)).toEqual([250, 250, 250, 250]);
    expect(count(store, 'run_steps')).toBe(0);
  });

  it('does nothing when nothing is old, and a second call while one runs waits for the first', async () => {
    const { daemon, store, retention } = await start();
    insertSteps(store, daemon.createSession(), 'fresh', 5, new Date().toISOString());
    const first = retention.run({ pauseMs: 0 });
    const second = retention.run({ pauseMs: 0 });
    expect(second).toBe(first);
    expect(await first).toBe(0);
    expect(count(store, 'run_steps')).toBe(5);
  });
});
