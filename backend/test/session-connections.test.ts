import { execFileSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectionEnv, PrAction, RunPurpose, SessionKind } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionScopes, scopedConnections } from '../src/agent/connection-scopes';
import { AgentRuntime } from '../src/agent/runtime';
import { ConnectionsModule } from '../src/connections/connections.module';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { actionLog, connections, repos, sessionConnections, sessions } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { DevtoolsModule } from '../src/devtools/devtools.module';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { ReposModule } from '../src/repos/repos.module';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { WorkspaceSessionsService } from '../src/workspace/workspace-sessions.service';
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

const repoDir = (daemon: AgentDaemon, repoId: string): string =>
  daemon.app.get<Store>(STORE).db.select({ path: repos.path }).from(repos).where(eq(repos.id, repoId)).get()?.path ??
  '';

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

/** Imports a Repo with one commit on `main`, and an untracked `.env` when `env` is given; returns its id. */
async function importRepo(daemon: AgentDaemon, env?: string): Promise<string> {
  const dir = path.join(await realpath(await tempDir('ops-console-git-')), 'orders-api');
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('remote', 'add', 'origin', 'git@github.com:acme/orders-api.git');
  if (env !== undefined) await writeFile(path.join(dir, '.env'), env);
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
    const made = daemon.createSession({ kind: SessionKind.Devtools });
    await ask(daemon, made, { text: 'ok' });
    expect(denied(daemon)).toEqual([]);
    expect(append(daemon)).toContain('ops-compare');
    const refused = await api(daemon).post('/sessions', { kind: 'devtools' });
    expect([refused.status, refused.body.error.code]).toEqual([400, 'validation_failed']);
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

const PG_PROD = {
  name: 'pg-prod',
  type: 'postgres',
  env: 'prod',
  config: { host: 'db.prod.example.com', port: 5432, database: 'orders', user: 'reader' },
  secret: 'hunter3',
};
const PG_LOCAL = {
  name: 'pg-local',
  type: 'postgres',
  env: 'local',
  config: { host: 'localhost', port: 5433, database: 'ledger', user: 'dev' },
  secret: 'dev',
};
const PG_OTHER = { ...PG_STAGING, name: 'pg-other', config: { ...PG_STAGING.config, host: 'db.other.example.com' } };
const PG_WRITER = { ...PG_STAGING, name: 'pg-writer', env: 'dev', access: 'write' };
/** Names pg-staging and pg-writer by host, pg-prod by host, pg-local by port and database; nothing else. */
const REPO_ENV = [
  'DATABASE_URL=postgres://reader:SECRET-pw-123@db.example.com:5432/orders',
  'REPORTS_URL=postgres://reader:SECRET-pw-456@db.prod.example.com:5432/orders',
  'LEDGER_URL=postgres://dev:SECRET-pw-789@localhost:5433/ledger',
  'REDIS_PORT=6379',
  '',
].join('\n');

async function connectAll(daemon: AgentDaemon) {
  const made: Record<string, Made> = {};
  for (const body of [MONGO_PROD, PG_STAGING, PG_WRITER, PG_PROD, PG_LOCAL, PG_OTHER, REDIS_LOCAL]) {
    made[body.name] = await connect(daemon, body);
  }
  return made as Record<string, Made>;
}

describe('Connections the Repo names', () => {
  it('ticks the read Connections its .env names when a repo Session is made, and not for an anonymous Session', async () => {
    const daemon = await start();
    const all = await connectAll(daemon);
    const repo = await importRepo(daemon, REPO_ENV);
    const created = await api(daemon).post('/sessions', { repo_id: repo, branch: 'main', access_mode: 'full' });
    expect(created.status).toBe(201);
    // The write, none-named and unnamed Connections are not ticked; the PROD one with read is.
    expect([...created.body.data.connection_ids].sort()).toEqual(
      [all['pg-staging']?.id, all['pg-prod']?.id, all['pg-local']?.id].sort(),
    );
    expect((await newSession(daemon)).connection_ids).toEqual([]);

    const id = created.body.data.id as string;
    await ask(daemon, id, { text: 'one' });
    expect(denied(daemon)).toEqual(['mongo-prod', 'pg-other', 'pg-writer', 'redis-local']);
    expect(append(daemon)).toContain('pg-staging (read-only)');
    expect(append(daemon)).toContain('pg-prod (read-only) PROD');
    // Names leave the daemon; the file's text and its passwords do not.
    const everywhere = JSON.stringify([
      append(daemon),
      (await api(daemon).get(`/sessions/${id}/messages`)).body.data,
      (await api(daemon).get('/action-log')).body.data,
      daemon.app.get<Store>(STORE).db.select().from(actionLog).all(),
      created.body.data,
    ]);
    expect(everywhere).not.toContain('SECRET-pw');
    expect(everywhere).not.toContain('DATABASE_URL');
  });

  it("keeps the operator's later ticks, and does not match again when a Connection or the .env changes", async () => {
    const daemon = await start();
    const all = await connectAll(daemon);
    const repo = await importRepo(daemon, REPO_ENV);
    const created = await api(daemon).post('/sessions', { repo_id: repo, branch: 'main', access_mode: 'full' });
    const id = created.body.data.id as string;
    const untick = await api(daemon).patch(`/sessions/${id}`, { connection_ids: [all['pg-staging']?.id] });
    expect(untick.body.data.connection_ids).toEqual([all['pg-staging']?.id]);
    await connect(daemon, { ...PG_STAGING, name: 'pg-late' });
    await writeFile(path.join(repoDir(daemon, repo), '.env'), `${REPO_ENV}OTHER=db.other.example.com\n`);
    await ask(daemon, id, { text: 'two' });
    expect((await api(daemon).get(`/sessions/${id}`)).body.data.connection_ids).toEqual([all['pg-staging']?.id]);
    expect(denied(daemon)).toEqual([
      'mongo-prod',
      'pg-late',
      'pg-local',
      'pg-other',
      'pg-prod',
      'pg-writer',
      'redis-local',
    ]);
    await api(daemon).patch(`/sessions/${id}`, { connection_ids: [] });
    expect((await api(daemon).get(`/sessions/${id}`)).body.data.connection_ids).toEqual([]);
  });

  it('ticks nothing, and still makes the Session, when the Repo has no .env', async () => {
    const daemon = await start();
    await connectAll(daemon);
    const repo = await importRepo(daemon);
    const created = await api(daemon).post('/sessions', { repo_id: repo, branch: 'main', access_mode: 'full' });
    expect([created.status, created.body.data.connection_ids]).toEqual([201, []]);
  });
});

describe('a PR Session', () => {
  async function prSession(daemon: AgentDaemon, repo: string): Promise<string> {
    const made = await api(daemon).post('/sessions', { repo_id: repo, branch: 'main', access_mode: 'full' });
    const id = made.body.data.id as string;
    daemon.app
      .get<Store>(STORE)
      .write((tx) => tx.update(sessions).set({ prAction: PrAction.Review }).where(eq(sessions.id, id)).run());
    return id;
  }

  it("reaches, at each run, the read Connections its Repo's own .env names, with the note, and refuses PATCH", async () => {
    const daemon = await start();
    const all = await connectAll(daemon);
    const repo = await importRepo(daemon);
    const id = await prSession(daemon, repo);

    // No .env yet: nothing is reached, as before.
    await ask(daemon, id, { text: 'ok' });
    expect(denied(daemon)).toEqual(['figma', 'notion', ...Object.keys(all)].sort());
    expect(append(daemon)).not.toContain('ops-result');

    // The Repo's file now names some: the next run reaches exactly those, found again, none stored.
    await writeFile(path.join(repoDir(daemon, repo), '.env'), REPO_ENV);
    await ask(daemon, id, { text: 'ok' });
    expect(denied(daemon)).toEqual([
      'figma',
      'mongo-prod',
      'notion',
      'pg-other',
      'pg-prod',
      'pg-writer',
      'redis-local',
    ]);
    expect(append(daemon)).toContain('pg-staging (read-only)');
    expect(append(daemon)).toContain('ops-result');
    expect(append(daemon)).not.toContain('mongo-prod');
    expect(append(daemon)).not.toContain('SECRET-pw');
    expect(daemon.app.get<Store>(STORE).db.select().from(sessionConnections).all()).toEqual([]);

    // A file the pull request's branch holds in the Session's worktree chooses nothing.
    const worktree = daemon.app.get(WorkspaceSessionsService).worktreeDir(id);
    await writeFile(path.join(worktree, '.env'), 'X=db.other.example.com\n');
    await ask(daemon, id, { text: 'ok' });
    expect(denied(daemon)).toContain('pg-other');

    const patched = await api(daemon).patch(`/sessions/${id}`, { connection_ids: [all['pg-staging']?.id] });
    expect([patched.status, patched.body.error.code]).toEqual([400, 'validation_failed']);

    // The Repo's file changed: the next run follows it.
    await writeFile(path.join(repoDir(daemon, repo), '.env'), 'NOTHING=1\n');
    await ask(daemon, id, { text: 'ok' });
    expect(denied(daemon)).toEqual(['figma', 'notion', ...Object.keys(all)].sort());
  });

  it('shows the Connections it reaches as its connection_ids', async () => {
    const daemon = await start();
    const all = await connectAll(daemon);
    const repo = await importRepo(daemon, REPO_ENV);
    const id = await prSession(daemon, repo);
    const seen = (await api(daemon).get(`/sessions/${id}`)).body.data.connection_ids as string[];
    // The PROD Connection the file names is left out: a PR Session reads text the operator did not write.
    expect([...seen].sort()).toEqual([all['pg-staging']?.id, all['pg-local']?.id].sort());
  });

  it('never reaches a PROD Connection, even with Access Level read, and the note names only the others', async () => {
    const daemon = await start();
    await connectAll(daemon);
    const repo = await importRepo(daemon, REPO_ENV);
    const id = await prSession(daemon, repo);
    await ask(daemon, id, { text: 'ok' });
    expect(denied(daemon)).toContain('pg-prod');
    expect(append(daemon)).toContain('pg-staging (read-only)');
    expect(append(daemon)).not.toContain('pg-prod');
  });

  it('does the match once for the views of a Sessions list within 5 seconds, and again after', async () => {
    const daemon = await start();
    const all = await connectAll(daemon);
    const repo = await importRepo(daemon, REPO_ENV);
    const id = await prSession(daemon, repo);
    const store = daemon.app.get<Store>(STORE);
    const row = store.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row) throw new Error('no session');
    let now = 1_000_000;
    const handler = scopedConnections(new ConnectionScopes(store, () => now), 'none');
    const view = (): string[] =>
      [...((handler.view?.(row) ?? { connection_ids: [] }).connection_ids as string[])].sort();
    const first = [all['pg-staging']?.id, all['pg-local']?.id].sort();
    expect(view()).toEqual(first);
    // A change inside the 5 seconds is not seen: no folder work was done for the second view.
    await writeFile(path.join(repoDir(daemon, repo), '.env'), 'NOTHING=1\n');
    expect(view()).toEqual(first);
    now += 4_999;
    expect(view()).toEqual(first);
    now += 2;
    expect(view()).toEqual([]);
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
    expect(append(daemon)).toContain('ops-compare');
    expect(append(daemon)).toContain('rows across');
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
  it('tells the agent the Realtime Database address of a ticked Firebase Connection, or that none is set', async () => {
    const daemon = await start();
    // A made-up key: the fields Firebase reads, no real private key.
    const secret = JSON.stringify({
      type: 'service_account',
      project_id: 'shop-123',
      client_email: 'reader@shop-123.iam.gserviceaccount.example.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n',
    });
    const base = { type: 'firebase', env: 'dev', secret };
    const named = await connect(daemon, {
      ...base,
      name: 'shop-fb',
      config: {
        project_id: 'shop-123',
        services: ['realtime_database'],
        database_url: 'https://shop-test-db.firebaseio.com',
      },
    });
    const bare = await connect(daemon, {
      ...base,
      name: 'shop-fb-bare',
      config: { project_id: 'shop-123', services: ['realtime_database'] },
    });
    const session = await newSession(daemon, { connection_ids: [named.id, bare.id] });
    await ask(daemon, session.id, { text: 'one' });
    expect(append(daemon)).toContain('always pass databaseUrl');
    expect(append(daemon)).toContain('shop-fb: https://shop-test-db.firebaseio.com');
    expect(append(daemon)).toContain('shop-fb-bare: none set, so ask the operator for it');
  });

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
