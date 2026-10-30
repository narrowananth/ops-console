import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WsEvent } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionsModule } from '../src/connections/connections.module';
import { KEYCHAIN } from '../src/keychain/keychain';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { type AgentDaemon, api, listen, signIn, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectionTester } from './fakes/connection-tester';
import { FakeKeychain } from './fakes/keychain';
import { FakeProbe } from './fakes/probe';

const LAUNCHER = '/opt/ops-console/bin/ops-console';
const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

type Ctx = { daemon: AgentDaemon; tester: FakeConnectionTester; keychain: FakeKeychain; dirs: string[] };
type Row = Record<string, unknown> & { id: string; name: string; status: string };

async function start(): Promise<Ctx> {
  const tester = new FakeConnectionTester();
  const daemon = await startAgentDaemon({
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: LAUNCHER }),
      ConnectionsModule.forRoot({ tester }),
    ],
  });
  running.push(daemon);
  const added = await api(daemon).post('/agent-accounts');
  const second = path.join(daemon.dataDir, 'accounts', added.body.data.account.id);
  await signIn(second, 'second@example.com', 'pro');
  await api(daemon).post(`/agent-accounts/${added.body.data.account.id}/checks`);
  return { daemon, tester, keychain: daemon.app.get<FakeKeychain>(KEYCHAIN), dirs: [daemon.home, second] };
}

const PG = {
  name: 'pg-orders',
  type: 'postgres',
  env: 'staging',
  config: { host: 'db.example.com', port: 5432, database: 'orders', user: 'reader' },
  secret: 'hunter2-secret',
};

async function registered(configDir: string): Promise<Record<string, { command?: string; args?: string[] }>> {
  try {
    return JSON.parse(await readFile(path.join(configDir, '.claude.json'), 'utf8')).mcpServers ?? {};
  } catch {
    return {};
  }
}

const list = async (ctx: Ctx): Promise<Row[]> => (await api(ctx.daemon).get('/connections')).body.data;
const checks = (events: WsEvent[]) =>
  events.flatMap((event) =>
    event.event === 'connection.checked' && event.data.target === 'connection' ? [event.data] : [],
  );

describe('creating', () => {
  it('stores the fields, keeps the secret in the Keychain and registers a read-only server in every account', async () => {
    const ctx = await start();
    const { events, close } = await listen(ctx.daemon);
    const created = await api(ctx.daemon).post('/connections', PG);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'pg-orders',
      access: 'read',
      is_prod: false,
      secret_stored: true,
      config: { host: 'db.example.com', port: 5432 },
    });
    for (const dir of ctx.dirs) {
      expect((await registered(dir))['pg-orders']).toMatchObject({
        command: LAUNCHER,
        args: [
          'mcp-exec',
          'pg-orders',
          '--',
          'npx',
          '-y',
          '@bytebase/dbhub@latest',
          '--transport',
          'stdio',
          '--readonly',
        ],
      });
    }
    expect(ctx.keychain.values.get(`connection:${created.body.data.id}`)).toBe('hunter2-secret');
    expect(JSON.parse(ctx.keychain.values.get('mcp:pg-orders') ?? '{}').DSN).toContain('hunter2-secret');
    await until(
      () => checks(events),
      (found) => found.length > 0,
      'the first check',
    );
    close();
    expect(checks(events)[0]).toMatchObject({ id: created.body.data.id, status: 'ok' });
  });

  it('leaves no row and no secret when registering fails in an account', async () => {
    const ctx = await start();
    await writeFile(path.join(ctx.dirs[1] ?? '', 'mcp-fail-add'), '');
    const created = await api(ctx.daemon).post('/connections', PG);
    expect(created.status).toBe(502);
    expect(created.body.error.code).toBe('upstream_failed');
    expect(await list(ctx)).toEqual([]);
    expect([...ctx.keychain.values.keys()]).toEqual([]);
    for (const dir of ctx.dirs) expect((await registered(dir))['pg-orders']).toBeUndefined();
  });

  it('refuses a name a Connection or an MCP Server already uses', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'taken',
      transport: 'stdio',
      target: 'node a.js',
      scope: 'user',
    });
    const clash = await api(ctx.daemon).post('/connections', { ...PG, name: 'taken' });
    expect(clash.body.error.code).toBe('duplicate');
    await api(ctx.daemon).post('/connections', PG);
    expect((await api(ctx.daemon).post('/connections', PG)).body.error.code).toBe('duplicate');
  });

  it('validates the config per type, naming the fields', async () => {
    const ctx = await start();
    const bad = await api(ctx.daemon).post('/connections', { ...PG, config: { host: 'db.example.com', port: 'x' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('port');
    expect(bad.body.error.message).toContain('database');
    expect((await api(ctx.daemon).post('/connections', { ...PG, secret: undefined })).status).toBe(400);
  });
});

describe('Access Level', () => {
  it('registers write without the read-only flag and none not at all, and changing it registers again', async () => {
    const ctx = await start();
    const { body } = await api(ctx.daemon).post('/connections', { ...PG, access: 'write' });
    expect((await registered(ctx.dirs[0] ?? ''))['pg-orders']?.args).not.toContain('--readonly');

    await api(ctx.daemon).patch(`/connections/${body.data.id}`, { access: 'read' });
    for (const dir of ctx.dirs) expect((await registered(dir))['pg-orders']?.args).toContain('--readonly');

    await api(ctx.daemon).patch(`/connections/${body.data.id}`, { access: 'none' });
    for (const dir of ctx.dirs) expect((await registered(dir))['pg-orders']).toBeUndefined();
    expect((await list(ctx))[0]).toMatchObject({ access: 'none' });
  });

  it('makes a PROD Connection read unless the request says write', async () => {
    const ctx = await start();
    const prod = await api(ctx.daemon).post('/connections', { ...PG, env: 'prod' });
    expect(prod.body.data).toMatchObject({ is_prod: true, access: 'read' });
    const write = await api(ctx.daemon).post('/connections', { ...PG, name: 'pg-2', env: 'prod', access: 'write' });
    expect(write.body.data).toMatchObject({ is_prod: true, access: 'write' });
  });

  it('turns write on for ClickHouse through its env and keeps read the default', async () => {
    const ctx = await start();
    const config = { host: 'ch.example.com', http_port: 8123, database: 'default', user: 'default' };
    const created = await api(ctx.daemon).post('/connections', { name: 'ch', type: 'clickhouse', env: 'dev', config });
    expect(created.body.data.access).toBe('read');
    expect(JSON.parse(ctx.keychain.values.get('mcp:ch') ?? '{}').CLICKHOUSE_ALLOW_WRITE_ACCESS).toBe('false');
    await api(ctx.daemon).patch(`/connections/${created.body.data.id}`, { access: 'write' });
    expect(JSON.parse(ctx.keychain.values.get('mcp:ch') ?? '{}').CLICKHOUSE_ALLOW_WRITE_ACCESS).toBe('true');
  });

  it('refuses read where the type has no read-only server, and any server where none is picked', async () => {
    const ctx = await start();
    const redis = { host: 'redis.example.com', port: 6379, db_index: 0 };
    const refused = await api(ctx.daemon).post('/connections', {
      name: 'r',
      type: 'redis',
      env: 'dev',
      config: redis,
      access: 'read',
    });
    expect(refused.status).toBe(400);
    const prod = await api(ctx.daemon).post('/connections', { name: 'r', type: 'redis', env: 'prod', config: redis });
    expect(prod.body.data.access).toBe('none');
    const kafka = { bootstrap_servers: 'k:9092', sasl_mechanism: '', schema_registry_url: '', kafbat_url: '' };
    expect(
      (
        await api(ctx.daemon).post('/connections', {
          name: 'k',
          type: 'kafka',
          env: 'dev',
          config: kafka,
          access: 'write',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(ctx.daemon).post('/connections', {
          name: 'k',
          type: 'kafka',
          env: 'dev',
          config: kafka,
          access: 'none',
        })
      ).status,
    ).toBe(201);
  });
});

describe('testing and checking', () => {
  it('tests an unsaved Connection with the secret in memory and stores nothing', async () => {
    const ctx = await start();
    const result = await api(ctx.daemon).post('/connections/tests', {
      type: PG.type,
      config: PG.config,
      secret: PG.secret,
    });
    expect(result.body.data).toEqual({ status: 'ok', latency_ms: 12, detail: null });
    expect(ctx.tester.runs[0]?.launch.env.DSN).toContain('hunter2-secret');
    expect(await list(ctx)).toEqual([]);
    expect([...ctx.keychain.values.keys()]).toEqual([]);
  });

  it('records a check with the stored secret, and a server that does not answer reads fail', async () => {
    const ctx = await start();
    const { body } = await api(ctx.daemon).post('/connections', PG);
    await until(
      () => list(ctx),
      (rows) => rows[0]?.status === 'ok',
      'the first check',
    );
    ctx.tester.next = { status: 'fail' as never, latency_ms: null, detail: 'connect ETIMEDOUT' };
    const { events, close } = await listen(ctx.daemon);
    const checked = await api(ctx.daemon).post(`/connections/${body.data.id}/checks`);
    expect(checked.body.data).toMatchObject({ status: 'fail', status_detail: 'connect ETIMEDOUT', latency_ms: null });
    await until(
      () => checks(events),
      (found) => found.length > 0,
      'the event',
    );
    close();
    expect(ctx.tester.runs.at(-1)?.launch.env.DSN).toContain('hunter2-secret');
    expect((await list(ctx))[0]).toMatchObject({ status: 'fail', status_detail: 'connect ETIMEDOUT' });
  });
});

describe('editing and deleting', () => {
  it('keeps blank fields, replaces the secret and registers the server again', async () => {
    const ctx = await start();
    const { body } = await api(ctx.daemon).post('/connections', PG);
    const edited = await api(ctx.daemon).patch(`/connections/${body.data.id}`, {
      config: { host: 'db2.example.com', database: '' },
      secret: 'new-secret-value',
    });
    expect(edited.body.data.config).toMatchObject({ host: 'db2.example.com', database: 'orders', user: 'reader' });
    expect(ctx.keychain.values.get(`connection:${body.data.id}`)).toBe('new-secret-value');
    const env = JSON.parse(ctx.keychain.values.get('mcp:pg-orders') ?? '{}');
    expect(env.DSN).toContain('db2.example.com');
    expect(env.DSN).toContain('new-secret-value');
  });

  it('removes the server from every account, the Keychain entries and the row', async () => {
    const ctx = await start();
    const { body } = await api(ctx.daemon).post('/connections', PG);
    expect((await api(ctx.daemon).delete(`/connections/${body.data.id}`)).status).toBe(204);
    expect(await list(ctx)).toEqual([]);
    for (const dir of ctx.dirs) expect((await registered(dir))['pg-orders']).toBeUndefined();
    expect([...ctx.keychain.values.keys()]).toEqual([]);
  });
});

describe('MCP servers list', () => {
  it('leaves out the server of a Connection and counts it', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connections', PG);
    const servers = await api(ctx.daemon).get('/mcp-servers');
    expect(servers.body.data.map((server: Row) => server.name)).not.toContain('pg-orders');
    expect(servers.body.meta.connection_server_count).toBe(1);
  });
});

describe('secrets', () => {
  it('shows no secret in a response, an event, the log or the registered config', async () => {
    const ctx = await start();
    const { events, close } = await listen(ctx.daemon);
    const { body } = await api(ctx.daemon).post('/connections', PG);
    await until(
      () => checks(events),
      (found) => found.length > 0,
      'the check',
    );
    const responses = [
      body,
      await list(ctx),
      (await api(ctx.daemon).post(`/connections/${body.data.id}/checks`)).body,
      (await api(ctx.daemon).get('/mcp-servers')).body,
    ];
    close();
    expect(JSON.stringify([responses, events, ctx.daemon.log])).not.toContain('hunter2-secret');
    for (const dir of ctx.dirs)
      expect(await readFile(path.join(dir, '.claude.json'), 'utf8')).not.toContain('hunter2-secret');
  });
});
