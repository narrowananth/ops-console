import { execFileSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectionEnv, PrAction, RunPurpose, SessionKind } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime';
import { ConnectionsModule } from '../src/connections/connections.module';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { connections, sessionConnections, sessions } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { DevtoolsModule } from '../src/devtools/devtools.module';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { ReposModule } from '../src/repos/repos.module';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, listen, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectionTester } from './fakes/connection-tester';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeGitHost } from './fakes/git-host';
import { FakeProbe } from './fakes/probe';
import { tempDir } from './helpers';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) {
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
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      ConnectionsModule.forRoot({ tester: new FakeConnectionTester(), launchDir: '/opt/ops-console/app/launch' }),
      ReposModule.forRoot(),
      WorkspaceModule.forRoot({ hosts: new FakeGitHost() }),
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

const append = (daemon: AgentDaemon): string =>
  (daemon.sdk.calls.at(-1)?.options.systemPrompt as { append: string } | undefined)?.append ?? '';

const newSession = async (daemon: AgentDaemon, body: Record<string, unknown> = {}) => {
  const response = await api(daemon).post('/sessions', { kind: 'anonymous', access_mode: 'full', ...body });
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

/** Imports a Repo with one commit on `main`; returns its id. */
async function importRepo(daemon: AgentDaemon): Promise<string> {
  const dir = path.join(await realpath(await tempDir('ops-console-git-')), 'orders-api');
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('remote', 'add', 'origin', 'git@github.com:acme/orders-api.git');
  return (await api(daemon).post('/repos', { path: dir })).body.data.id as string;
}

describe('scope API', () => {
  it('starts a Session with an empty scope and stores a chosen one, surviving a reload', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const pg = await connect(daemon, PG_STAGING);
    expect((await newSession(daemon)).connection_ids).toEqual([]);
    const chosen = await newSession(daemon, { connection_ids: [pg.id, mongo.id] });
    expect(chosen.connection_ids).toEqual([pg.id, mongo.id]);
    expect((await api(daemon).get(`/sessions/${chosen.id}`)).body.data.connection_ids).toEqual([pg.id, mongo.id]);
  });

  it('changes the scope with PATCH and sends session.updated so every open page redraws it', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const made = await newSession(daemon);
    const listener = await listen(daemon);
    const patched = await api(daemon).patch(`/sessions/${made.id}`, { connection_ids: [mongo.id] });
    expect(patched.body.data.connection_ids).toEqual([mongo.id]);
    await until(
      () => listener.events,
      (events) => events.some((event) => event.event === 'session.updated' && event.data.session_id === made.id),
      'session.updated for the scope change',
    );
    listener.close();
  });

  it('refuses an unknown Connection and one with Access Level none, and leaves the scope as it was', async () => {
    const daemon = await start();
    const redis = await connect(daemon, { ...REDIS_LOCAL, access: 'none' });
    const mongo = await connect(daemon, MONGO_PROD);
    const refused = await api(daemon).post('/sessions', { kind: 'anonymous', connection_ids: [redis.id] });
    expect([refused.status, refused.body.error.code]).toEqual([409, 'connection_no_access']);
    expect((await api(daemon).get('/sessions?kind=anonymous')).body.data).toHaveLength(0);

    const made = await newSession(daemon, { connection_ids: [mongo.id] });
    const none = await api(daemon).patch(`/sessions/${made.id}`, { connection_ids: [redis.id] });
    expect([none.status, none.body.error.code]).toEqual([409, 'connection_no_access']);
    const missing = await api(daemon).patch(`/sessions/${made.id}`, { connection_ids: [mongo.id, 'nope'] });
    expect([missing.status, missing.body.error.code]).toEqual([404, 'not_found']);
    expect((await api(daemon).get(`/sessions/${made.id}`)).body.data.connection_ids).toEqual([mongo.id]);
  });

  it('drops a Connection set to none, or deleted, from every scope and keeps the Session', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const pg = await connect(daemon, PG_STAGING);
    const a = await newSession(daemon, { connection_ids: [mongo.id, pg.id] });
    const b = await newSession(daemon, { connection_ids: [pg.id] });
    await api(daemon).patch(`/connections/${pg.id}`, { access: 'none' });
    expect((await api(daemon).get(`/sessions/${a.id}`)).body.data.connection_ids).toEqual([mongo.id]);
    expect((await api(daemon).get(`/sessions/${b.id}`)).body.data.connection_ids).toEqual([]);
    expect((await api(daemon).delete(`/connections/${mongo.id}`)).status).toBe(204);
    expect((await api(daemon).get(`/sessions/${a.id}`)).body.data.connection_ids).toEqual([]);
  });

  it('leaves the scope as it was when another field of the same PATCH is refused', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const made = await newSession(daemon);
    const refused = await api(daemon).patch(`/sessions/${made.id}`, {
      connection_ids: [mongo.id],
      extra_repo_ids: ['nope'],
    });
    expect([refused.status, refused.body.error.code]).toEqual([404, 'not_found']);
    expect((await api(daemon).get(`/sessions/${made.id}`)).body.data.connection_ids).toEqual([]);
  });

  it('answers validation_failed for a kind with no scope, and keeps null on it', async () => {
    const daemon = await start();
    const review = daemon.createSession({ kind: SessionKind.PrReview });
    const patched = await api(daemon).patch(`/sessions/${review}`, { connection_ids: [] });
    expect(patched.body.error.code).toBe('validation_failed');
    expect((await api(daemon).get(`/sessions/${review}`)).body.data.connection_ids).toBeNull();
  });

  it('leaves a Dev tools Session as it was: an empty scope there means every Connection with access', async () => {
    const daemon = await start();
    await connect(daemon, MONGO_PROD);
    await connect(daemon, PG_STAGING);
    const made = await newSession(daemon, { kind: 'devtools' });
    await ask(daemon, made.id, { text: 'ok' });
    expect(denied(daemon)).toEqual([]);
  });

  it('gives a Fork the source scope', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const source = await newSession(daemon, { connection_ids: [mongo.id] });
    await ask(daemon, source.id, { text: 'Done.' });
    const [, answer] = (await api(daemon).get(`/sessions/${source.id}/messages`)).body.data;
    const forked = await api(daemon).post(`/sessions/${source.id}/messages/${answer.id}/fork`);
    expect(forked.status).toBe(201);
    expect(forked.body.data.connection_ids).toEqual([mongo.id]);
  });
});

describe('a repo Session', () => {
  it('takes a scope at creation and on PATCH, and its run reaches only the ticked Connections', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const pg = await connect(daemon, PG_STAGING);
    const repo = await importRepo(daemon);

    const created = await api(daemon).post('/sessions', {
      repo_id: repo,
      branch: 'main',
      access_mode: 'full',
      connection_ids: [mongo.id],
    });
    expect(created.status).toBe(201);
    expect(created.body.data.connection_ids).toEqual([mongo.id]);
    await ask(daemon, created.body.data.id, { text: 'one' });
    expect(denied(daemon)).toEqual(['pg-staging']);

    const patched = await api(daemon).patch(`/sessions/${created.body.data.id}`, { connection_ids: [pg.id] });
    expect(patched.body.data.connection_ids).toEqual([pg.id]);
    await ask(daemon, created.body.data.id, { text: 'two' });
    expect(denied(daemon)).toEqual(['mongo-prod']);
  });
});

describe('a PR Session', () => {
  it('has no Connection scope: its runs reach no Connection, get no note, and refuse PATCH connection_ids', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    await connect(daemon, PG_STAGING);
    const repo = await importRepo(daemon);
    const made = await api(daemon).post('/sessions', { repo_id: repo, branch: 'main', access_mode: 'full' });
    const id = made.body.data.id as string;
    // A scope ticked before the Session became a PR Session's, or by any other route than the API.
    const store = daemon.app.get<Store>(STORE);
    store.write((tx) => {
      tx.update(sessions).set({ prAction: PrAction.Review }).where(eq(sessions.id, id)).run();
      tx.insert(sessionConnections).values({ sessionId: id, connectionId: mongo.id }).run();
    });
    await ask(daemon, id, { text: 'ok' });
    // Every Connection, and the Connector servers with a Read list (Figma), stay out of a pull request's Session.
    expect(denied(daemon)).toEqual(['figma', 'mongo-prod', 'pg-staging']);
    expect(append(daemon)).not.toContain('ops-result');
    expect(append(daemon)).not.toContain('mongo-prod');
    const patched = await api(daemon).patch(`/sessions/${id}`, { connection_ids: [mongo.id] });
    expect([patched.status, patched.body.error.code]).toEqual([400, 'validation_failed']);
  });
});

describe('run options', () => {
  it('reaches no Connection with an empty scope, so no database server starts', async () => {
    const daemon = await start();
    await connect(daemon, MONGO_PROD);
    await connect(daemon, PG_STAGING);
    const session = await newSession(daemon);
    await ask(daemon, session.id, { text: 'ok' });
    expect(denied(daemon)).toEqual(['mongo-prod', 'pg-staging']);
    expect(append(daemon)).not.toContain('ops-result');
  });

  it('gives the next run only the ticked Connections, and tells the agent which it has', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const pg = await connect(daemon, PG_STAGING);
    await connect(daemon, REDIS_LOCAL);
    const session = await newSession(daemon, { connection_ids: [pg.id] });
    await ask(daemon, session.id, { text: 'one' });
    expect(denied(daemon)).toEqual(['mongo-prod', 'redis-local']);
    expect(append(daemon)).toContain('pg-staging (read-only)');
    expect(append(daemon)).not.toContain('mongo-prod');
    expect(append(daemon)).toMatch(/only read unless the operator asks/i);
    expect(append(daemon)).toContain('ops-result');
    expect(append(daemon)).toContain('output folder');

    await api(daemon).patch(`/sessions/${session.id}`, { connection_ids: [mongo.id] });
    await ask(daemon, session.id, { text: 'two' });
    expect(denied(daemon)).toEqual(['pg-staging', 'redis-local']);
  });

  it('keeps a Connection with Access Level none out of a run', async () => {
    const daemon = await start();
    const pg = await connect(daemon, PG_STAGING);
    const session = await newSession(daemon, { connection_ids: [pg.id] });
    await api(daemon).patch(`/connections/${pg.id}`, { access: 'none' });
    await ask(daemon, session.id, { text: 'ok' });
    expect(denied(daemon)).toEqual(['pg-staging']);
  });

  it('ignores the scope in a job and keeps the job its own rules', async () => {
    const daemon = await start();
    const pg = await connect(daemon, PG_STAGING);
    await connect(daemon, { ...REDIS_LOCAL, access: 'write' });
    const runtime = daemon.app.get(AgentRuntime);
    const session = await newSession(daemon, { connection_ids: [pg.id] });
    const empty = await newSession(daemon);
    // Connection servers only: a job leaves connector servers out as it did before.
    const databases = () =>
      (denied(daemon) ?? []).filter((name) => ['mongo-prod', 'pg-staging', 'redis-local'].includes(name));
    // A Verification reaches the Connections that cannot write, whatever the scope; a Fix reaches none.
    await runtime.runFor(session.id, 'job', null, { purpose: RunPurpose.Verify }).finished;
    expect(databases()).toEqual(['redis-local']);
    await runtime.runFor(empty.id, 'job', null, { purpose: RunPurpose.Verify }).finished;
    expect(databases()).toEqual(['redis-local']);
    await runtime.runFor(session.id, 'job', null, { purpose: RunPurpose.Fix }).finished;
    expect(databases()).toEqual(['pg-staging', 'redis-local']);
  });

  it('runs two Sessions with different scopes side by side, each reaching only its own', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const pg = await connect(daemon, PG_STAGING);
    const a = await newSession(daemon, { connection_ids: [mongo.id] });
    const b = await newSession(daemon, { connection_ids: [pg.id] });
    await ask(daemon, a.id, { text: 'a' });
    const forA = denied(daemon);
    await ask(daemon, b.id, { text: 'b' });
    expect([forA, denied(daemon)]).toEqual([['pg-staging'], ['mongo-prod']]);
  });
});

describe('queries in an anonymous Session', () => {
  it('logs a query before it runs and names the Connection and its Access Level in a step', async () => {
    const daemon = await start();
    const mongo = await connect(daemon, MONGO_PROD);
    const session = await newSession(daemon, { connection_ids: [mongo.id] });
    const listener = await listen(daemon);
    await ask(
      daemon,
      session.id,
      { tool: 'mcp__mongo-prod__find', input: { collection: 'shops', filter: { domain: 'acme' } } },
      { text: 'Found it.' },
    );
    const rows = (await api(daemon).get(`/action-log?session_id=${session.id}`)).body.data;
    expect(rows.map((row: Record<string, unknown>) => [row.kind, row.target, row.is_prod, row.outcome])).toEqual([
      ['query', 'mongo-prod', true, 'ok'],
    ]);
    const logged = listener.events.filter((event) => event.event === 'action.logged');
    expect(logged[0]?.data).toMatchObject({ kind: 'query', target: 'mongo-prod', outcome: 'pending' });
    const steps = listener.events.flatMap((event) =>
      event.event === 'session.output' && event.data.part.kind === 'step' ? [event.data.part.text] : [],
    );
    listener.close();
    expect(steps).toContain('mongo-prod (read-only): find');
    const read = (await api(daemon).get(`/sessions/${session.id}/messages`)).body.data;
    expect(JSON.stringify(read)).toContain('mongo-prod (read-only): find');
  });

  it('reports a ticked Connection that is down, and not one that is left out', async () => {
    const daemon = await start();
    const pg = await connect(daemon, PG_STAGING);
    await connect(daemon, REDIS_LOCAL);
    daemon.sdk.mcpServers = [
      { name: 'pg-staging', status: 'failed' },
      { name: 'redis-local', status: 'failed' },
    ];
    const session = await newSession(daemon, { connection_ids: [pg.id] });
    const listener = await listen(daemon);
    await ask(daemon, session.id, { text: 'Fine.' });
    const steps = listener.events.flatMap((event) =>
      event.event === 'session.output' && event.data.part.kind === 'step' ? [event.data.part.text] : [],
    );
    listener.close();
    expect([...new Set(steps)]).toEqual(['pg-staging (read-only): is down, skipped']);
  });

  it('holds a write on a PROD Connection with Access Level write for an Approval, in full mode', async () => {
    const daemon = await start();
    const made = await connect(daemon, { ...MONGO_PROD, access: 'write', env: 'dev' });
    daemon.app
      .get<Store>(STORE)
      .write((tx) => tx.update(connections).set({ env: ConnectionEnv.Prod }).where(eq(connections.id, made.id)).run());
    const session = await newSession(daemon, { connection_ids: [made.id], access_mode: 'full' });
    daemon.sdk.script({
      tool: 'mcp__mongo-prod__update-many',
      input: { collection: 'shops', update: { $set: { plan: 'pro' } } },
    });
    await api(daemon).post(`/sessions/${session.id}/messages`, { text: 'change it' });
    const [approval] = await until(
      async () => (await api(daemon).get('/approvals?status=pending')).body.data,
      (list: Record<string, unknown>[]) => list.length === 1,
      'a pending approval',
    );
    expect(approval).toMatchObject({ kind: 'prod_write', is_prod: true });
    await api(daemon).post(`/approvals/${approval?.id}/decision`, { decision: 'denied' });
    await until(
      async () => (await api(daemon).get(`/sessions/${session.id}`)).body.data.state,
      (state) => state === 'idle' || state === 'failed',
      'the run to end',
    );
    expect(daemon.sdk.ran).toEqual([]);
  });
});
