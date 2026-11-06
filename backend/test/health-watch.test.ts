import path from 'node:path';
import { HealthArea, HealthStatus, type WsEvent } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionsModule } from '../src/connections/connections.module';
import { ConnectionsService } from '../src/connections/connections.service';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { HealthWatchModule } from '../src/health-watch/health-watch.module';
import { HealthWatch, readHistory } from '../src/health-watch/health-watch.service';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { type AgentDaemon, api, listen, signIn, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectionTester } from './fakes/connection-tester';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeProbe } from './fakes/probe';

const LAUNCH_DIR = path.resolve(import.meta.dirname, '../launch');
const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

const PG = {
  name: 'pg-orders',
  type: 'postgres',
  env: 'staging',
  config: { host: 'db.example.com', port: 5432, database: 'orders', user: 'reader' },
  secret: 'hunter2-secret',
};

async function start() {
  const tester = new FakeConnectionTester();
  const daemon = await startAgentDaemon({
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console/bin/ops-console' }),
      ConnectionsModule.forRoot({ tester, launchDir: LAUNCH_DIR }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      HealthWatchModule.forRoot(),
    ],
  });
  running.push(daemon);
  const added = await api(daemon).post('/agent-accounts');
  const second = path.join(daemon.dataDir, 'accounts', added.body.data.account.id);
  await signIn(second, 'second@example.com', 'pro');
  await api(daemon).post(`/agent-accounts/${added.body.data.account.id}/checks`);
  const created = await api(daemon).post('/connections', PG);
  await daemon.app.get(ConnectionsService).settled();
  return { daemon, tester, id: created.body.data.id as string, watch: daemon.app.get(HealthWatch) };
}

type Overview = {
  areas: Record<
    'connections' | 'integrations',
    { interval: string; last_checked_at: string | null; next_check_at: string | null; checking: unknown }
  >;
  items: {
    id: string;
    name: string;
    target: string;
    status: string;
    failing_since: string | null;
    recovered_at: string | null;
    history: { status: string }[];
  }[];
};
const overview = async (daemon: AgentDaemon): Promise<Overview> => (await api(daemon).get('/health-watch')).body.data;
const changes = (events: WsEvent[]) =>
  events.flatMap((event) => (event.event === 'health.changed' ? [event.data] : []));
const itemOf = async (daemon: AgentDaemon, id: string) => (await overview(daemon)).items.find((one) => one.id === id);

describe('reading a history', () => {
  const hour = 3_600_000;
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  it('finds when a run of failures began, across a failure that changed kind', () => {
    const read = readHistory(
      [
        { status: HealthStatus.Auth, at: at(1) },
        { status: HealthStatus.Fail, at: at(16) },
        { status: HealthStatus.Fail, at: at(31) },
        { status: HealthStatus.Ok, at: at(46) },
      ],
      now,
    );
    expect(read).toEqual({ failingSince: at(31), recoveredAt: null, wasDown: null });
  });

  it('reads a recent recovery, and forgets it after an hour', () => {
    const history = [
      { status: HealthStatus.Ok, at: at(2) },
      { status: HealthStatus.Ok, at: at(17) },
      { status: HealthStatus.Fail, at: at(32) },
      { status: HealthStatus.Fail, at: at(47) },
      { status: HealthStatus.Ok, at: at(62) },
    ];
    expect(readHistory(history, now)).toEqual({ failingSince: null, recoveredAt: at(17), wasDown: at(47) });
    expect(readHistory(history, now + hour)).toEqual({ failingSince: null, recoveredAt: null, wasDown: null });
  });

  it('says nothing about a thing that has only answered, or never been checked', () => {
    expect(readHistory([{ status: HealthStatus.Ok, at: at(1) }], now).failingSince).toBeNull();
    expect(readHistory([], now)).toEqual({ failingSince: null, recoveredAt: null, wasDown: null });
  });
});

describe('automatic checks', () => {
  it('lists each Connection with its interval defaults, and leaves out one with no access', async () => {
    const { daemon } = await start();
    const read = await overview(daemon);
    expect(read.areas.connections).toMatchObject({ interval: '30m', checking: null });
    expect(read.areas.integrations).toMatchObject({ interval: '1h', checking: null });
    expect(read.items.filter((one) => one.target === 'connection').map((one) => one.name)).toEqual(['pg-orders']);
    const none = await api(daemon).post('/connections', { ...PG, name: 'pg-none', access: 'none' });
    expect(none.status).toBe(201);
    expect((await overview(daemon)).items.some((one) => one.name === 'pg-none')).toBe(false);
  });

  it('Check now starts a run, keeps each check, and says once when a Connection breaks and once when it recovers', async () => {
    const { daemon, tester, id } = await start();
    const { events, close } = await listen(daemon);
    tester.next = { status: HealthStatus.Fail, latency_ms: null, detail: 'connection refused' };

    const started = await api(daemon).post('/health-watch/connections/checks');
    expect(started.status).toBe(202);
    const failing = await until(
      () => itemOf(daemon, id),
      (one) => one?.status === 'fail',
      'the failing check',
    );
    expect(failing?.failing_since).not.toBeNull();
    await until(
      () => changes(events),
      (list) => list.length === 1,
      'the break',
    );
    expect(changes(events)[0]).toMatchObject({
      area: 'connections',
      target: 'connection',
      id,
      name: 'pg-orders',
      status: 'fail',
      detail: 'connection refused',
      recovered: false,
    });

    // Still down on the next check: no second alert, a second point in the history.
    await new Promise((resolve) => setTimeout(resolve, 40));
    await daemon.app.get(HealthWatch).run(HealthArea.Connections);
    expect(changes(events)).toHaveLength(1);

    tester.next = { status: HealthStatus.Ok, latency_ms: 9, detail: null };
    await daemon.app.get(HealthWatch).run(HealthArea.Connections);
    await until(
      () => changes(events),
      (list) => list.length === 2,
      'the recovery',
    );
    expect(changes(events)[1]).toMatchObject({ id, status: 'ok', recovered: true, since: null });
    const recovered = await itemOf(daemon, id);
    expect(recovered).toMatchObject({ status: 'ok', failing_since: null });
    expect(recovered?.recovered_at).not.toBeNull();
    expect(recovered?.history.map((point) => point.status).at(-1)).toBe('ok');
    close();
  });

  it('says so when a Connection is failing at its first check, and keeps the stripe to 24 checks', async () => {
    const { daemon, tester, id, watch } = await start();
    const { events, close } = await listen(daemon);
    tester.next = { status: HealthStatus.Auth, latency_ms: null, detail: 'authentication failed' };
    await watch.run(HealthArea.Connections);
    await until(
      () => changes(events),
      (list) => list.length === 1,
      'the first alert',
    );
    expect(changes(events)[0]).toMatchObject({ status: 'auth', recovered: false });
    for (let i = 0; i < 30; i++) {
      tester.next = { status: i % 2 === 0 ? HealthStatus.Ok : HealthStatus.Fail, latency_ms: 1, detail: `n${i}` };
      await watch.run(HealthArea.Connections);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect((await itemOf(daemon, id))?.history.length).toBe(24);
    close();
  });

  it('runs an area only when its interval is due, and never when it is off', async () => {
    const { daemon, tester, watch } = await start();
    const runs = () => tester.runs.length;
    const hour = 3_600_000;
    await watch.run(HealthArea.Connections);
    const base = runs();

    watch.tick(Date.now() + 60_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(runs()).toBe(base);

    watch.tick(Date.now() + 31 * 60_000);
    await until(
      () => runs(),
      (count) => count > base,
      'the due run',
    );

    const after = runs();
    await api(daemon).patch('/settings', { health_checks: { connections: 'off', integrations: '1h' } });
    expect((await overview(daemon)).areas.connections).toMatchObject({ interval: 'off', next_check_at: null });
    watch.tick(Date.now() + 10 * hour);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(runs()).toBe(after);
  });

  it('shows the run while it goes, and refuses an area that does not exist', async () => {
    const { daemon, tester } = await start();
    tester.next = { status: HealthStatus.Ok, latency_ms: 1, detail: null };
    expect((await api(daemon).post('/health-watch/elsewhere/checks')).status).toBe(404);
    const settled = await api(daemon).post('/health-watch/connections/checks');
    expect(settled.body.data.areas.connections.interval).toBe('30m');
    await until(
      () => overview(daemon),
      (read) => read.areas.connections.checking === null && read.areas.connections.last_checked_at !== null,
      'the run to end',
    );
  });

  it('refuses an interval that is not on the list', async () => {
    const { daemon } = await start();
    const bad = await api(daemon).patch('/settings', { health_checks: { connections: '15m2', integrations: '1h' } });
    expect(bad.status).toBe(400);
  });

  it('offers 30 minutes, 1, 6, 12 and 24 hours and off, and reads an older 5 or 15 minutes as 30', async () => {
    const { daemon } = await start();
    for (const interval of ['30m', '1h', '6h', '12h', '24h', 'off']) {
      const set = await api(daemon).patch('/settings', {
        health_checks: { connections: interval, integrations: interval },
      });
      expect(set.status).toBe(200);
      expect((await overview(daemon)).areas.connections.interval).toBe(interval);
    }
    expect(
      (await api(daemon).patch('/settings', { health_checks: { connections: '5m', integrations: '15m' } })).status,
    ).toBe(200);
    const read = await overview(daemon);
    expect([read.areas.connections.interval, read.areas.integrations.interval]).toEqual(['30m', '30m']);
  });

  it('does not count a Connector that never answered as failing, and says nothing about it', async () => {
    const { daemon, watch } = await start();
    const { events, close } = await listen(daemon);
    await watch.run(HealthArea.Integrations);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const read = await overview(daemon);
    const never = read.items.filter(
      (one) => one.target === 'connector' && one.history.every((point) => point.status !== 'ok'),
    );
    expect(never.every((one) => one.status === 'off' && one.failing_since === null)).toBe(true);
    expect(changes(events).filter((one) => one.target === 'connector')).toEqual([]);
    close();
  });
});
