import { AccessLevel, ConnectionType } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionsModule } from '../src/connections/connections.module';
import { actionLog } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { DevtoolsModule } from '../src/devtools/devtools.module';
import { isWrite, sqlReads } from '../src/devtools/write-classifier';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { type AgentDaemon, api, gate, listen, startAgentDaemon, until } from './agent-fixtures';
import type { Step } from './fakes/agent-sdk';
import { FakeConnectionTester } from './fakes/connection-tester';
import { FakeProbe } from './fakes/probe';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) {
    // Runs write their end to the store; a daemon that stops first leaves them writing to a closed one.
    await until(
      async () => (await api(daemon).get('/sessions?limit=100')).body.data.map((s: { state: string }) => s.state),
      (states: string[]) => states.every((state) => state !== 'working' && state !== 'waiting_approval'),
      'runs to end',
    ).catch(() => {});
    await daemon.stop();
  }
});

async function start(): Promise<AgentDaemon> {
  const daemon = await startAgentDaemon({
    fixtureKinds: false,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console/bin/ops-console' }),
      ConnectionsModule.forRoot({ tester: new FakeConnectionTester() }),
      DevtoolsModule.forRoot(),
    ],
  });
  running.push(daemon);
  return daemon;
}

type Made = { id: string; name: string };

async function connect(daemon: AgentDaemon, body: Record<string, unknown>): Promise<Made> {
  const response = await api(daemon).post('/connections', body);
  expect(response.status).toBe(201);
  return response.body.data;
}

const MONGO_PROD = {
  name: 'mongo-prod',
  type: 'mongodb',
  env: 'prod',
  config: { database: 'shops' },
  secret: 'mongodb://reader:s3cret@db.example.com/shops',
};
const PG_STAGING = {
  name: 'pg-staging',
  type: 'postgres',
  env: 'staging',
  config: { host: 'db.example.com', port: 5432, database: 'orders', user: 'reader' },
  secret: 'hunter2',
};
const REDIS_LOCAL = {
  name: 'redis-local',
  type: 'redis',
  env: 'local',
  config: { host: '127.0.0.1', port: 6379, db_index: 0 },
};

/** The servers the run left out, as the SDK was told. */
const denied = (daemon: AgentDaemon, call = -1) =>
  (
    daemon.sdk.calls.at(call)?.options.settings as { deniedMcpServers?: { serverName: string }[] } | undefined
  )?.deniedMcpServers
    ?.map((server) => server.serverName)
    .sort();

const newSession = async (daemon: AgentDaemon, body: Record<string, unknown> = {}) => {
  const response = await api(daemon).post('/sessions', { kind: 'devtools', access_mode: 'full', ...body });
  expect(response.status).toBe(201);
  return response.body.data as { id: string; connection_ids: string[] };
};

async function ask(daemon: AgentDaemon, sessionId: string, ...steps: Parameters<AgentDaemon['sdk']['script']>) {
  daemon.sdk.script(...steps);
  await api(daemon).post(`/sessions/${sessionId}/messages`, { text: 'look' });
  await until(
    async () => (await api(daemon).get(`/sessions/${sessionId}`)).body.data.state,
    (state) => state === 'idle' || state === 'failed',
    'the run to end',
  );
}

describe('scope', () => {
  it('stores the scope on the Session; an empty scope leaves every Connection with access in reach', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    await connect(daemon, PG_STAGING);
    const all = await newSession(daemon);
    expect(all.connection_ids).toEqual([]);
    await ask(daemon, all.id, { text: 'ok' });
    expect(denied(daemon)).toEqual([]);

    const one = await newSession(daemon, { connection_ids: [mongo.id] });
    expect(one.connection_ids).toEqual([mongo.id]);
    expect((await api(daemon).get(`/sessions/${one.id}`)).body.data.connection_ids).toEqual([mongo.id]);
    await ask(daemon, one.id, { text: 'ok' });
    expect(denied(daemon)).toEqual(['pg-staging']);
  });

  it('refuses a scope that names a Connection with Access Level none', async () => {
    const daemon = await start();
    const redis = await connect(daemon, { ...REDIS_LOCAL, access: 'none' });
    const mongo = await connect(daemon, MONGO_PROD);
    const refused = await api(daemon).post('/sessions', { kind: 'devtools', connection_ids: [redis.id] });
    expect([refused.status, refused.body.error.code]).toEqual([409, 'connection_no_access']);
    const made = await newSession(daemon, { connection_ids: [mongo.id] });
    const patched = await api(daemon).patch(`/sessions/${made.id}`, { connection_ids: [redis.id] });
    expect([patched.status, patched.body.error.code]).toEqual([409, 'connection_no_access']);
    expect((await api(daemon).get(`/sessions/${made.id}`)).body.data.connection_ids).toEqual([mongo.id]);
    expect((await api(daemon).get('/sessions?kind=devtools')).body.data).toHaveLength(1);
  });

  it('applies a changed scope, or a changed Access Level, to the next run', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const pg = await connect(daemon, PG_STAGING);
    const session = await newSession(daemon, { connection_ids: [mongo.id] });
    await ask(daemon, session.id, { text: 'one' });
    expect(denied(daemon)).toEqual(['pg-staging']);

    const patched = await api(daemon).patch(`/sessions/${session.id}`, { connection_ids: [pg.id] });
    expect(patched.body.data.connection_ids).toEqual([pg.id]);
    await ask(daemon, session.id, { text: 'two' });
    expect(denied(daemon)).toEqual(['mongo-prod']);

    // `none` takes the Connection out of every scope, and its server is left out too.
    await api(daemon).patch(`/connections/${pg.id}`, { access: 'none' });
    expect((await api(daemon).get(`/sessions/${session.id}`)).body.data.connection_ids).toEqual([]);
    await ask(daemon, session.id, { text: 'three' });
    expect(denied(daemon)).toEqual(['pg-staging']);
  });

  it('drops a deleted Connection from every scope and keeps the Session', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const pg = await connect(daemon, PG_STAGING);
    const session = await newSession(daemon, { connection_ids: [mongo.id, pg.id] });
    expect((await api(daemon).delete(`/connections/${mongo.id}`)).status).toBe(204);
    const kept = (await api(daemon).get(`/sessions/${session.id}`)).body.data;
    expect(kept.connection_ids).toEqual([pg.id]);
  });

  it('keeps connection_ids off other kinds', async () => {
    const daemon = await start();
    const created = await api(daemon).post('/sessions', { kind: 'devtools' });
    expect(created.body.data.connection_ids).toEqual([]);
    expect((await api(daemon).post('/sessions', { kind: 'pr_review' })).body.error.code).toBe('validation_failed');
    expect((await api(daemon).post('/sessions', { kind: 'nope' })).body.error.code).toBe('validation_failed');
    const repoSession = daemon.createSession();
    expect((await api(daemon).patch(`/sessions/${repoSession}`, { connection_ids: [] })).body.error.code).toBe(
      'validation_failed',
    );
  });

  it('runs two Sessions side by side', async () => {
    const daemon = await start();
    await connect(daemon, PG_STAGING);
    const [a, b] = [await newSession(daemon), await newSession(daemon)];
    const hold = gate();
    daemon.sdk.script({ wait: hold.promise }, { text: 'a' });
    daemon.sdk.script({ text: 'b' });
    expect((await api(daemon).post(`/sessions/${a.id}/messages`, { text: 'one' })).status).toBe(202);
    expect((await api(daemon).post(`/sessions/${b.id}/messages`, { text: 'two' })).status).toBe(202);
    await until(
      async () => (await api(daemon).get(`/sessions/${b.id}`)).body.data.state,
      (state) => state === 'idle',
    );
    expect((await api(daemon).get(`/sessions/${a.id}`)).body.data.state).toBe('working');
    hold.open();
  });
});

describe('queries', () => {
  it('writes the Action Log row with the Connection and is_prod before the call, and names the Connection in a step', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const pg = await connect(daemon, PG_STAGING);
    const session = await newSession(daemon);
    const listener = await listen(daemon);
    await ask(
      daemon,
      session.id,
      { tool: 'mcp__mongo-prod__find', input: { collection: 'shops', filter: { domain: 'glowbar' } } },
      { tool: 'mcp__pg-staging__execute_sql', input: { sql: 'select * from reservations limit 5' } },
      { text: 'Found it.' },
    );
    const rows = (await api(daemon).get(`/action-log?session_id=${session.id}`)).body.data.reverse();
    expect(rows.map((row: Record<string, unknown>) => [row.kind, row.target, row.is_prod, row.outcome])).toEqual([
      ['query', 'mongo-prod', true, 'ok'],
      ['query', 'pg-staging', false, 'ok'],
    ]);
    const stored = daemon.app.get<Store>(STORE).db.select().from(actionLog).all();
    expect(stored.map((row) => row.connectionId).sort()).toEqual([mongo.id, pg.id].sort());
    const messages = (await api(daemon).get(`/sessions/${session.id}/messages`)).body.data;
    const steps = messages.flatMap((message: { parts: { kind: string; text: string }[] }) =>
      message.parts.filter((part) => part.kind === 'step').map((part) => part.text),
    );
    expect(steps).toEqual(['mongo-prod (read-only): find', 'pg-staging (read-only): execute_sql']);
    const streamed = listener.events.flatMap((event) =>
      event.event === 'session.output' && event.data.part.kind === 'step' ? [event.data.part.text] : [],
    );
    expect(streamed).toContain('mongo-prod (read-only): find');
    // The row is written before the result: it is the first `action.logged` for the call.
    const logged = listener.events.filter((event) => event.event === 'action.logged');
    expect(logged[0]?.data).toMatchObject({ kind: 'query', target: 'mongo-prod', is_prod: true, outcome: 'pending' });
    listener.close();
  });

  it('reports a Connection whose server is down or needs a login, and goes on with the others', async () => {
    const daemon = await start();
    await connect(daemon, MONGO_PROD);
    await connect(daemon, PG_STAGING);
    await connect(daemon, { ...PG_STAGING, name: 'pg-down', env: 'dev' });
    daemon.sdk.mcpServers = [
      { name: 'mongo-prod', status: 'needs-auth' },
      { name: 'pg-staging', status: 'connected' },
      { name: 'pg-down', status: 'failed' },
      { name: 'atlassian', status: 'failed' },
    ];
    const session = await newSession(daemon);
    const listener = await listen(daemon);
    await ask(
      daemon,
      session.id,
      { tool: 'mcp__pg-staging__execute_sql', input: { sql: 'select 1' } },
      { text: 'Answer.' },
    );
    // The note rides the streamed message; the finished transcript is Claude Code's own and has no place for it.
    const steps = listener.events.flatMap((event) =>
      event.event === 'session.output' && event.data.part.kind === 'step' ? [event.data.part.text] : [],
    );
    listener.close();
    expect([...new Set(steps)]).toEqual([
      'mongo-prod (read-only): needs a login, skipped',
      'pg-down (read-only): is down, skipped',
      'pg-staging (read-only): execute_sql',
    ]);
    expect((await api(daemon).get(`/sessions/${session.id}`)).body.data.state).toBe('idle');
  });

  it('does not report a server the scope left out', async () => {
    const daemon = await start();
    const pg = await connect(daemon, PG_STAGING);
    await connect(daemon, REDIS_LOCAL);
    daemon.sdk.mcpServers = [{ name: 'redis-local', status: 'failed' }];
    const session = await newSession(daemon, { connection_ids: [pg.id] });
    await ask(daemon, session.id, { text: 'Fine.' });
    const messages = (await api(daemon).get(`/sessions/${session.id}/messages`)).body.data;
    expect(JSON.stringify(messages)).not.toContain('redis-local');
  });
});

describe('PROD writes', () => {
  const update: Step = {
    tool: 'mcp__mongo-prod__update-many',
    input: { collection: 'shops', update: { $set: { plan: 'pro' } } },
  };

  async function writeAttempt(access: 'read' | 'write', decide: 'approved' | 'denied' | null, step: Step = update) {
    const daemon = await start();
    await connect(daemon, { ...MONGO_PROD, access });
    const session = await newSession(daemon, { access_mode: 'full' });
    daemon.sdk.script(access === 'read' && 'tool' in step ? { ...step, fails: 'server is read-only' } : step);
    await api(daemon).post(`/sessions/${session.id}/messages`, { text: 'change it' });
    if (decide) {
      const pending = await until(
        async () => (await api(daemon).get('/approvals?status=pending')).body.data,
        (list: Record<string, unknown>[]) => list.length === 1,
        'a pending approval',
      );
      const [approval] = pending;
      expect(approval).toMatchObject({ kind: 'prod_write', is_prod: true });
      expect(approval?.summary).toContain('mongo-prod');
      await api(daemon).post(`/approvals/${approval?.id}/decision`, { decision: decide });
    }
    await until(
      async () => (await api(daemon).get(`/sessions/${session.id}`)).body.data.state,
      (state) => state === 'idle' || state === 'failed',
      'the run to end',
    );
    return {
      daemon,
      rows: (await api(daemon).get(`/action-log?session_id=${session.id}`)).body.data,
      approvals: (await api(daemon).get('/approvals')).body.data,
    };
  }

  it('holds a write on a PROD Connection for an Approval, in full mode, and runs it once approved', async () => {
    const { daemon, rows, approvals } = await writeAttempt('write', 'approved');
    expect(approvals).toEqual([expect.objectContaining({ kind: 'prod_write', status: 'approved' })]);
    expect(rows.map((row: Record<string, unknown>) => [row.target, row.is_prod, row.outcome])).toEqual([
      ['mongo-prod', true, 'ok'],
    ]);
    expect(daemon.sdk.ran.map((call) => call.tool)).toEqual(['mcp__mongo-prod__update-many']);
  });

  it('logs a denied write as denied, and the tool never runs', async () => {
    const { daemon, rows } = await writeAttempt('write', 'denied');
    expect(rows.map((row: Record<string, unknown>) => row.outcome)).toEqual(['denied']);
    expect(daemon.sdk.ran).toEqual([]);
  });

  it('asks nothing for a PROD read', async () => {
    const { approvals, rows } = await writeAttempt('write', null, {
      tool: 'mcp__mongo-prod__find',
      input: { collection: 'shops' },
    });
    expect(approvals).toEqual([]);
    expect(rows.map((row: Record<string, unknown>) => [row.is_prod, row.outcome])).toEqual([[true, 'ok']]);
  });

  it('leaves a write on a read-only Connection to its server, which refuses it, and logs it failed', async () => {
    const { approvals, rows } = await writeAttempt('read', null);
    expect(approvals).toEqual([]);
    expect(rows.map((row: Record<string, unknown>) => [row.outcome, row.error_message])).toEqual([
      ['failed', expect.stringContaining('read-only')],
    ]);
  });
});

describe('what counts as a write', () => {
  it('reads SQL that only selects', () => {
    for (const sql of [
      'select 1',
      ' SELECT * FROM a; select 2',
      'with x as (select 1) select * from x',
      'explain select 1',
      "select 'drop table a'",
    ]) {
      expect(sqlReads(sql), sql).toBe(true);
    }
  });

  it('treats everything else, and anything it cannot place, as a write', () => {
    for (const sql of [
      'update a set b = 1',
      'select 1; delete from a',
      'with x as (delete from a returning *) select * from x',
      'select * into backup from a',
      'explain analyze delete from a',
      'truncate a',
      'vacuum',
      '',
      '-- nothing',
    ]) {
      expect(sqlReads(sql), sql).toBe(false);
    }
  });

  it('knows each server type: SQL by statement, Mongo and Redis by tool, an unknown tool as a write', () => {
    expect(isWrite(ConnectionType.Postgres, 'execute_sql', { sql: 'select 1' })).toBe(false);
    expect(isWrite(ConnectionType.Postgres, 'execute_sql', { sql: 'drop table a' })).toBe(true);
    expect(isWrite(ConnectionType.Postgres, 'search_objects', {})).toBe(false);
    expect(isWrite(ConnectionType.Clickhouse, 'run_query', { query: 'select 1' })).toBe(false);
    expect(isWrite(ConnectionType.Mongodb, 'find', {})).toBe(false);
    expect(isWrite(ConnectionType.Mongodb, 'aggregate', { pipeline: [{ $match: {} }] })).toBe(false);
    expect(isWrite(ConnectionType.Mongodb, 'aggregate', { pipeline: [{ $out: 'x' }] })).toBe(true);
    expect(isWrite(ConnectionType.Mongodb, 'delete-many', {})).toBe(true);
    expect(isWrite(ConnectionType.Redis, 'get', {})).toBe(false);
    expect(isWrite(ConnectionType.Redis, 'hset', {})).toBe(true);
    expect(isWrite(ConnectionType.Redis, 'a_new_tool', {})).toBe(true);
    expect(AccessLevel.Write).toBe('write');
  });
});
