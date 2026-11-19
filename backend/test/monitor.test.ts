import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AlertStatus,
  CheckInterval,
  ConnectorId,
  DEFAULT_CONNECTOR_CONFIG,
  FixStatus,
  HealthStatus,
  type LogSource,
  PlaybookStepStatus,
  PlaybookTrigger,
  PrState,
  RunStatus,
  ScanStatus,
  ScanTrigger,
  SessionState,
  type WsEvent,
} from '@ops-console/shared';
import Database from 'better-sqlite3';
import { desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import {
  alertEvents,
  alerts,
  connectors,
  fixes,
  playbookSteps,
  reports,
  repos,
  reviews,
  scanRouteResults,
  scans,
  services,
  sessions,
} from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import type { CloudWatchOptions } from '../src/monitor/cloudwatch-logs';
import { fingerprint, maskSignature, normalizePath } from '../src/monitor/fingerprint';
import { NO_TICKET_IN_PLAYBOOK } from '../src/monitor/fixes.service';
import { LOKI_SECRET_KEY } from '../src/monitor/loki-access';
import type { LokiOptions } from '../src/monitor/loki-logs';
import { MonitorModule } from '../src/monitor/monitor.module';
import { MonitorRetention } from '../src/monitor/retention';
import { latestSlot, nextSlot, ScansService } from '../src/monitor/scans.service';
import { ReposModule } from '../src/repos/repos.module';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, gate, listen, startAgentDaemon, stepTurns, until } from './agent-fixtures';
import type { Step } from './fakes/agent-sdk';
import { AWS_BIN, FakeAws } from './fakes/aws-logs';
import { FakeCodeHosts } from './fakes/code-hosts';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeDatadog, route, samples, service } from './fakes/datadog';
import { FakeGitHost, hostPr } from './fakes/git-host';
import { FakeKeychain } from './fakes/keychain';
import { FakeLogcli } from './fakes/loki-logs';
import { type OtelRecord, otlpLine, writeLogFile } from './fakes/otlp';
import { FakeProbe } from './fakes/probe';
import { MIGRATIONS_DIR, startTestDaemon, tempDir } from './helpers';

/** A job's step without its times, which each test run sets anew. */
const untimed = ({ started_at: _started, finished_at: _finished, ...step }: Record<string, unknown>) => step;

const running: AgentDaemon[] = [];

/** Runs write their end to the store; a daemon that stops first leaves them writing to a closed one. */
async function drain(daemon: AgentDaemon): Promise<void> {
  const store = daemon.app.get<Store>(STORE);
  const busy = () =>
    store.db.select().from(fixes).where(eq(fixes.status, FixStatus.Running)).all().length +
    store.db.select().from(sessions).where(eq(sessions.state, SessionState.Working)).all().length;
  await until(busy, (count) => count === 0, 'runs to end').catch(() => {});
}

afterEach(async () => {
  for (const daemon of running.splice(0)) {
    await drain(daemon);
    await daemon.stop();
  }
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' });

async function makeRepo(): Promise<string> {
  const dir = path.join(await tempDir('ops-console-git-'), 'orders-api');
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/orders-api.git');
  return dir;
}

type Ctx = {
  daemon: AgentDaemon;
  datadog: FakeDatadog;
  host: FakeGitHost;
  store: Store;
  http: ReturnType<typeof api>;
  dir: string;
  codeHosts: FakeCodeHosts;
  /** The Log folder the OpenTelemetry source is pointed at. */
  logs: string;
};

/** Where a Session's agent works: its own worktree of the Repo. */
const worktreeOf = (ctx: Ctx, sessionId: string) => path.join(ctx.daemon.dataDir, 'session-worktrees', sessionId);

function setConnector(store: Store, id: ConnectorId, patch: Partial<typeof connectors.$inferInsert>) {
  store.write((tx) => tx.update(connectors).set(patch).where(eq(connectors.id, id)).run());
}

async function start(
  options: {
    dataDir?: string;
    datadog?: FakeDatadog;
    connected?: boolean;
    otelReadLimit?: number;
    cloudWatch?: CloudWatchOptions;
    loki?: LokiOptions;
    keychain?: FakeKeychain;
  } = {},
): Promise<Ctx> {
  const datadog = options.datadog ?? new FakeDatadog();
  const host = new FakeGitHost();
  const codeHosts = new FakeCodeHosts();
  const daemon = await startAgentDaemon({
    fixtureKinds: false,
    dataDir: options.dataDir,
    keychain: options.keychain,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      ReposModule.forRoot(),
      WorkspaceModule.forRoot({ hosts: host }),
      MonitorModule.forRoot({
        datadog,
        codeHosts,
        otelReadLimit: options.otelReadLimit,
        cloudWatch: { bin: AWS_BIN, pollMs: 10, ...options.cloudWatch },
        loki: options.loki,
      }),
    ],
  });
  running.push(daemon);
  const store = daemon.app.get<Store>(STORE);
  if (options.connected ?? true) {
    setConnector(store, ConnectorId.Datadog, { status: HealthStatus.Ok });
    setConnector(store, ConnectorId.Jira, { status: HealthStatus.Ok });
    setConnector(store, ConnectorId.Github, { status: HealthStatus.Ok, login: 'octo-operator' });
  }
  const logs = await tempDir('ops-console-logs-');
  return { daemon, datadog, host, store, http: api(daemon), dir: '', codeHosts, logs };
}

async function scan(ctx: Ctx, serviceId: string | null = null): Promise<{ id: string; status: string }> {
  const started = await ctx.http.post('/scans', { service_id: serviceId, connector: 'datadog' });
  expect(started.status).toBe(202);
  return until(
    () => ctx.http.get(`/scans/${started.body.data.id}`).then((res) => res.body.data),
    (found) => found.status !== 'running',
    'the Scan to end',
  );
}

const alertList = (ctx: Ctx, query = '') => ctx.http.get(`/alerts${query}`).then((res) => res.body.data);

/** One failing route on one Service, scanned once. */
async function failing(ctx: Ctx, errors = 12) {
  ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', errors)])];
  await scan(ctx);
  const [alert] = await alertList(ctx);
  return alert;
}

const json = (body: object): Step => ({ text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`` });

const REPORT = {
  kind: 'bug',
  slug: 'Null Order Total!',
  root_cause: 'OrderService reads a missing total',
  proposed_fix: 'Default the total to zero',
  replay: { request: 'curl -X POST localhost:8080/orders', response: '500' },
  diff: [{ sign: '+', text: 'const total = order.total ?? 0;' }],
};

async function linkRepo(ctx: Ctx, serviceId: string): Promise<string> {
  ctx.dir = await makeRepo();
  const repo = await ctx.http.post('/repos', { path: ctx.dir });
  // The Repo is on GitHub to the console; the console's push reaches a bare repository.
  const bare = path.join(await tempDir('ops-console-origin-'), 'orders-api.git');
  git(path.dirname(bare), 'init', '-q', '--bare', '-b', 'main', bare);
  git(ctx.dir, 'remote', 'set-url', 'origin', bare);
  git(ctx.dir, 'push', '-q', 'origin', 'main');
  await ctx.http.patch(`/services/${serviceId}`, { repo_id: repo.body.data.id });
  return repo.body.data.id;
}

/** A step turn's answer. */
const outcome = (status: 'done' | 'skipped' | 'failed', summary = 'ok'): Step => json({ outcome: status, summary });

/** The steps of the built-in Verify, each its own turn. */
const VERIFY_STEPS: Step[][] = stepTurns(PlaybookTrigger.Verify);

/** Scripts each step turn, then the closing turn that writes the Report. */
async function verify(ctx: Ctx, alertId: string, closing: Step[] = [json(REPORT)], steps = VERIFY_STEPS) {
  for (const run of steps) ctx.daemon.sdk.script(...run);
  // An empty closing scripts no run: the job stops before it.
  if (closing.length > 0) ctx.daemon.sdk.script(...closing);
  const started = await ctx.http.post(`/alerts/${alertId}/verifications`);
  expect(started.status).toBe(202);
  await until(
    () => ctx.http.get(`/alerts/${alertId}`).then((res) => res.body.data.status),
    (status) => status !== 'verifying',
    'the Verification to end',
  );
  return started.body.data;
}

describe('Fingerprint', () => {
  it('shares one for failures that differ only in ids, times, addresses and counts', () => {
    const a = 'Order 1042 failed at 2026-10-01T10:00:00Z from 10.0.0.12 after 3 tries';
    const b = 'Order 99 failed at 2026-10-02T11:30:00Z from 10.0.4.7 after 9 tries';
    expect(maskSignature(a)).toBe(maskSignature(b));
    expect(fingerprint('s1', 'post', '/orders', a)).toBe(fingerprint('s1', 'POST', '/orders', b));
  });

  it('differs for another Route, Service or error kind', () => {
    const base = fingerprint('s1', 'POST', '/orders', 'Order 1 not found');
    expect(fingerprint('s1', 'POST', '/refunds', 'Order 1 not found')).not.toBe(base);
    expect(fingerprint('s2', 'POST', '/orders', 'Order 1 not found')).not.toBe(base);
    expect(fingerprint('s1', 'POST', '/orders', 'Timeout talking to payments')).not.toBe(base);
  });

  it('keeps the value Datadog Alerts were stored with', () => {
    expect(fingerprint('svc-1', 'POST', '/orders/:id', 'Null pointer in OrderService', 500)).toBe(
      '11c180639173c6ab452ed1ae9bcd02e9',
    );
    expect(fingerprint('svc-1', 'POST', '/orders/:id', 'Null pointer in OrderService')).toBe(
      'f674f78667046125afc1cd94a337268d',
    );
  });

  it('includes the source for OpenTelemetry logs', () => {
    const datadog = fingerprint('svc-1', 'POST', '/orders', 'Order 1 not found', 500);
    expect(fingerprint('svc-1', 'POST', '/orders', 'Order 1 not found', 500, ConnectorId.Datadog)).toBe(datadog);
    expect(fingerprint('svc-1', 'POST', '/orders', 'Order 1 not found', 500, ConnectorId.OtelLogs)).not.toBe(datadog);
  });

  it('folds ids in paths into one Route', () => {
    expect(normalizePath('/orders/1042/items/9f3a1c2e-1111-2222-3333-444455556666')).toBe('/orders/:id/items/:id');
    expect(normalizePath('/health?x=1')).toBe('/health');
  });
});

describe('Scans and Alerts', () => {
  it('finds Services and Routes and raises one open Alert per failing Route', async () => {
    const ctx = await start();
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 12), route('GET', '/orders', 0)])];
    const ended = await scan(ctx);
    expect(ended.status).toBe('ok');
    const services = (await ctx.http.get('/services')).body.data;
    expect(services).toHaveLength(1);
    expect(services[0].routes.map((r: { path: string; state: string }) => [r.path, r.state])).toEqual([
      ['/orders', 'failing'],
    ]);
    const alerts = await alertList(ctx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: 'open', event_count: 12, severity: 'low', source: 'scan' });
    const detail = (await ctx.http.get(`/alerts/${alerts[0].id}`)).body.data;
    expect(detail.samples).toHaveLength(12);
    expect(detail.waiting_since).toBeNull();
  });

  it('counts the Alerts not yet resolved or dismissed for the sidebar badge, without the list', async () => {
    const ctx = await start();
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 12), route('GET', '/carts', 5)])];
    await scan(ctx);
    expect((await ctx.http.get('/alerts/summary')).body.data).toEqual({ open: 2 });
    const [first] = await alertList(ctx);
    ctx.store.write((tx) =>
      tx.update(alerts).set({ status: AlertStatus.Dismissed }).where(eq(alerts.id, first.id)).run(),
    );
    expect((await ctx.http.get('/alerts/summary')).body.data).toEqual({ open: 1 });
  });

  it('reads the window and envs the operator picked', async () => {
    const ctx = await start();
    ctx.datadog.readings = [
      service('orders-api', [route('POST', '/orders', 4)], 'prod'),
      service('orders-api', [route('POST', '/orders', 9)], 'staging'),
    ];
    const started = await ctx.http.post('/scans', { service_id: null, window: '1h', envs: ['staging'] });
    expect(started.body.data).toMatchObject({ window_size: '1h', envs: ['staging'] });
    await until(
      () => ctx.http.get(`/scans/${started.body.data.id}`).then((res) => res.body.data.status),
      (status) => status !== 'running',
    );
    expect(ctx.datadog.calls.at(-1)).toMatchObject({ window: '1h', envs: ['staging'] });
    const alerts = await alertList(ctx);
    expect(alerts.map((alert: { service: { env: string } }) => alert.service.env)).toEqual(['staging']);
    const bad = await ctx.http.post('/scans', { service_id: null, window: '3d' });
    expect(bad.body.error.code).toBe('validation_failed');
  });

  it('lists the Datadog envs with the Connector ones ticked', async () => {
    const ctx = await start();
    const envs = (await ctx.http.get('/monitor/envs')).body.data;
    expect(envs).toEqual([
      { name: 'prod', configured: true },
      { name: 'staging', configured: false },
      { name: 'no env', configured: false },
    ]);
  });

  it('lists the Datadog Services with errors in the range and envs, busiest first', async () => {
    const ctx = await start();
    ctx.datadog.readings = [
      service('orders-api', [route('POST', '/orders', 4)], 'prod'),
      service('orders-api', [route('POST', '/orders', 9)], 'staging'),
      service('webhook', [route('POST', '/hooks', 30)], 'no env'),
      service('quiet', [route('GET', '/ping', 0)], 'prod'),
    ];
    const listed = await ctx.http.get('/monitor/log-services?window=24h&envs=prod,staging,no%20env');
    expect(listed.body.data).toEqual([
      { name: 'webhook', envs: ['no env'], errors: 30 },
      { name: 'orders-api', envs: ['staging', 'prod'], errors: 13 },
    ]);
    const bad = await ctx.http.get('/monitor/log-services?window=3d&envs=prod');
    expect(bad.body.error.code).toBe('validation_failed');
  });

  it('reads only the Services the operator picked, and clears only theirs', async () => {
    const ctx = await start();
    ctx.datadog.readings = [
      service('orders-api', [route('POST', '/orders', 4)], 'prod'),
      service('billing', [route('POST', '/charge', 5)], 'prod'),
    ];
    await scan(ctx);
    ctx.datadog.readings = [];
    const started = await ctx.http.post('/scans', { service_id: null, envs: ['prod'], services: ['orders-api'] });
    expect(started.body.data).toMatchObject({ services: ['orders-api'] });
    await until(
      () => ctx.http.get(`/scans/${started.body.data.id}`).then((res) => res.body.data.status),
      (status) => status !== 'running',
    );
    expect(ctx.datadog.calls.at(-1)).toMatchObject({ services: ['orders-api'] });
    const cleared = ctx.store.db.select().from(alerts).all();
    const byName = (name: string) => cleared.find((row) => row.title.includes(name));
    expect(byName('orders-api')?.clearedAt).not.toBeNull();
    expect(byName('billing')?.clearedAt).toBeNull();
  });

  it('reads every env when the operator picks none', async () => {
    const ctx = await start();
    ctx.datadog.readings = [
      service('orders-api', [route('POST', '/orders', 4)], 'prod'),
      service('webhook', [route('POST', '/hooks', 3)], 'no env'),
    ];
    const done = await scan(ctx);
    expect((await ctx.http.get(`/scans/${done.id}`)).body.data.envs).toEqual(['prod', 'staging', 'no env']);
    expect((await alertList(ctx)).map((alert: { service: { name: string } }) => alert.service.name).sort()).toEqual([
      'orders-api',
      'webhook',
    ]);
    const listed = await ctx.http.get('/monitor/log-services?window=24h');
    expect(listed.body.data.map((row: { name: string }) => row.name)).toEqual(['orders-api', 'webhook']);
  });

  it('splits one Route by HTTP status code, and a Scan of some codes clears only those', async () => {
    const ctx = await start();
    ctx.datadog.readings = [
      service('orders-api', [
        route('POST', '/orders', 7, { statusCode: 401, samples: samples(7, 'token expired') }),
        route('POST', '/orders', 3, { statusCode: 500, samples: samples(3, 'token expired') }),
      ]),
    ];
    await scan(ctx);
    const raised = await alertList(ctx);
    expect(raised.map((alert: { http_status: number }) => alert.http_status).sort()).toEqual([401, 500]);
    expect(raised.find((alert: { http_status: number }) => alert.http_status === 401).title).toBe(
      '401 POST /orders failing on orders-api',
    );

    ctx.datadog.readings = [];
    const started = await ctx.http.post('/scans', { service_id: null, status_codes: [500] });
    expect(started.body.data.status_codes).toEqual([500]);
    await until(
      () => ctx.http.get(`/scans/${started.body.data.id}`).then((res) => res.body.data.status),
      (status) => status !== 'running',
    );
    expect(ctx.datadog.calls.at(-1)).toMatchObject({ codes: [500] });
    const rows = ctx.store.db.select().from(alerts).all();
    expect(rows.find((row) => row.httpStatus === 500)?.clearedAt).not.toBeNull();
    expect(rows.find((row) => row.httpStatus === 401)?.clearedAt).toBeNull();
    expect((await ctx.http.post('/scans', { service_id: null, status_codes: [200] })).body.error.code).toBe(
      'validation_failed',
    );
  });

  it('lists the HTTP status codes and the Services failing with the ones picked', async () => {
    const ctx = await start();
    ctx.datadog.readings = [
      service('orders-api', [route('POST', '/orders', 7, { statusCode: 401 }), route('GET', '/orders', 2)]),
      service('billing', [route('POST', '/charge', 5, { statusCode: 404 })]),
    ];
    expect((await ctx.http.get('/monitor/status-codes?window=24h')).body.data).toEqual([
      { code: 401, count: 7 },
      { code: 404, count: 5 },
      { code: 500, count: 2 },
    ]);
    const picked = await ctx.http.get('/monitor/log-services?window=24h&codes=401,500');
    expect(picked.body.data).toEqual([{ name: 'orders-api', envs: ['prod'], errors: 9 }]);
    expect((await ctx.http.get('/monitor/log-services?window=24h&codes=200')).body.error.code).toBe(
      'validation_failed',
    );
  });

  it('raises Alerts for logs with no HTTP route, and takes the Git URL from the logs', async () => {
    const ctx = await start();
    const job = samples(6, 'Job 812 failed: queue timeout');
    ctx.datadog.readings = [
      service('billing-worker', [route('', '', 6, { samples: job })], 'prod', 'github.com/acme/billing'),
    ];
    await scan(ctx);
    const [alert] = await alertList(ctx);
    expect(alert).toMatchObject({
      route: null,
      title: 'billing-worker: job <n> failed: queue timeout',
      service: { name: 'billing-worker', repo_url: 'github.com/acme/billing', repo_id: null },
    });
    const services = (await ctx.http.get('/services')).body.data;
    expect(services[0]).toMatchObject({ repo_url: 'github.com/acme/billing', routes: [] });
  });

  it('ignores a Git URL from the logs that is not a Git host URL', async () => {
    const ctx = await start();
    const job = samples(6, 'Job 812 failed: queue timeout');
    ctx.datadog.readings = [
      service('billing-worker', [route('', '', 6, { samples: job })], 'prod', 'ext::sh -c "touch /tmp/x"'),
    ];
    await scan(ctx);
    expect((await ctx.http.get('/services')).body.data[0]).toMatchObject({ repo_url: null });
  });

  it('updates the same Alert on a later Scan with the same Fingerprint', async () => {
    const ctx = await start();
    const first = await failing(ctx, 12);
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 8)])];
    await scan(ctx);
    const alerts = await alertList(ctx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe(first.id);
    expect(alerts[0].event_count).toBe(20);
  });

  it('picks the severity from the rapid and failing thresholds', async () => {
    const ctx = await start();
    ctx.datadog.readings = [
      service('orders-api', [
        route('GET', '/rapid', 400, { peakPer10m: 150 }),
        route('GET', '/steady', 240, { peakPer10m: 20 }),
        route('GET', '/quiet', 3),
        route('GET', '/warnonly', 240, { statusCode: 404, peakPer10m: 20, samples: samples(5, 'slow query', 'warn') }),
        route('GET', '/emergency', 240, {
          statusCode: 401,
          peakPer10m: 20,
          samples: samples(5, 'db down', 'emergency'),
        }),
        route('GET', '/server', 240, { statusCode: 502, peakPer10m: 20, samples: samples(5, 'bad gateway', 'warn') }),
        // `fatal` is OpenTelemetry's word; a Datadog Sample with it rates as before.
        route('GET', '/fatal', 240, { statusCode: 401, peakPer10m: 20, samples: samples(5, 'crashed', 'fatal') }),
      ]),
    ];
    await scan(ctx);
    const bySeverity = Object.fromEntries(
      (await alertList(ctx)).map((a: { route: { path: string }; severity: string }) => [a.route.path, a.severity]),
    );
    expect(bySeverity).toEqual({
      '/rapid': 'high',
      '/steady': 'medium',
      '/quiet': 'low',
      '/warnonly': 'low',
      '/emergency': 'medium',
      '/server': 'medium',
      '/fatal': 'low',
    });
  });

  it('never raises an Alert for an ignored Route, and shows its note', async () => {
    const ctx = await start();
    ctx.datadog.readings = [service('orders-api', [route('GET', '/legacy', 50)])];
    await scan(ctx);
    const [alert] = await alertList(ctx);
    await ctx.http.patch(`/routes/${alert.route.id}`, { ignored: true, note: 'old client retries' });
    await ctx.store.write((tx) => tx.delete(alerts).run());
    ctx.datadog.readings = [service('orders-api', [route('GET', '/legacy', 50)])];
    await scan(ctx);
    expect(await alertList(ctx)).toHaveLength(0);
    const listed = (await ctx.http.get('/services')).body.data[0].routes[0];
    expect(listed).toMatchObject({ ignored: true, note: 'old client retries', state: 'failing' });
  });

  it('ends rate_limited or failed and leaves every Alert as it was', async () => {
    const ctx = await start();
    const before = await failing(ctx);
    for (const [down, status, code] of [
      ['rate_limited', 'rate_limited', 'rate_limited'],
      ['failed', 'failed', 'upstream_failed'],
    ] as const) {
      ctx.datadog.down = down;
      const ended = await scan(ctx);
      expect([ended.status, (ended as { error_code?: string }).error_code]).toEqual([status, code]);
    }
    expect(await alertList(ctx)).toEqual([before]);
  });

  it('stops a running Scan: it ends cancelled and keeps nothing it read', async () => {
    const ctx = await start();
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 4)])];
    ctx.datadog.hold = new Promise(() => {});
    const started = await ctx.http.post('/scans', { service_id: null });
    expect((await ctx.http.post(`/scans/${started.body.data.id}/cancel`, {})).status).toBe(204);
    const ended = await until(
      () => ctx.http.get(`/scans/${started.body.data.id}`).then((res) => res.body.data),
      (found) => found.status !== 'running',
      'the Scan to end',
    );
    expect(ended).toMatchObject({ status: 'cancelled', error_code: null });
    expect(await alertList(ctx)).toEqual([]);
    const again = await ctx.http.post(`/scans/${started.body.data.id}/cancel`, {});
    expect([again.status, again.body.error.code]).toEqual([409, 'invalid_state']);
  });

  it('refuses a Scan while Datadog is not connected', async () => {
    const ctx = await start({ connected: false });
    const response = await ctx.http.post('/scans', { service_id: null });
    expect([response.status, response.body.error.code]).toEqual([409, 'connector_not_connected']);
  });

  it('redacts Samples before they are written and keeps at most 25, newest first', async () => {
    const ctx = await start();
    const noisy = samples(30).map((sample, index) => ({
      ...sample,
      message: index === 0 ? 'login failed password=hunter2 for order 7' : sample.message,
      attributes: { token: 'abc123', request: { body: { card: '4111' } }, path: '/orders' },
    }));
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 30, { samples: noisy })])];
    await scan(ctx);
    const [alert] = await alertList(ctx);
    const detail = (await ctx.http.get(`/alerts/${alert.id}`)).body.data;
    expect(detail.samples).toHaveLength(25);
    expect(detail.samples[0].message).toContain('password=[redacted]');
    expect(JSON.stringify(detail.samples[0].attributes)).not.toContain('abc123');
    expect(JSON.stringify(detail.samples[0].attributes)).not.toContain('4111');
    expect(detail.log_line).toContain('[redacted]');
  });

  it('reopens a resolved Alert as a Regression only after a healthy Scan', async () => {
    const ctx = await start();
    const first = await failing(ctx, 12);
    ctx.store.write((tx) =>
      tx
        .update(alerts)
        .set({ status: AlertStatus.Resolved, resolvedAt: new Date().toISOString() })
        .where(eq(alerts.id, first.id))
        .run(),
    );
    // Still failing with no healthy Scan between: stays resolved.
    await new Promise((resolve) => setTimeout(resolve, 5));
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 6)])];
    await scan(ctx);
    expect((await alertList(ctx, '?scope=closed'))[0]).toMatchObject({ status: 'resolved', regression_count: 0 });
    // Healthy, then failing again.
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 0)])];
    await scan(ctx);
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 5)])];
    const listener = await listen(ctx.daemon);
    await scan(ctx);
    const [again] = await alertList(ctx);
    expect(again).toMatchObject({
      id: first.id,
      status: 'open',
      regression_count: 1,
      event_count: 5,
      resolved_at: null,
    });
    expect(listener.events.some((e: WsEvent) => e.event === 'alert.regressed')).toBe(true);
    listener.close();
  });

  it('keeps counting a dismissed Alert, and reopens it only after a healthy Scan', async () => {
    const ctx = await start();
    const first = await failing(ctx, 12);
    ctx.store.write((tx) =>
      tx.update(alerts).set({ status: AlertStatus.Dismissed }).where(eq(alerts.id, first.id)).run(),
    );
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 3)])];
    await scan(ctx);
    expect((await alertList(ctx, '?scope=closed'))[0]).toMatchObject({
      status: 'dismissed',
      event_count: 15,
      regression_count: 0,
    });
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 0)])];
    await scan(ctx);
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 4)])];
    await scan(ctx);
    expect((await alertList(ctx))[0]).toMatchObject({ status: 'open', regression_count: 1 });
  });

  it('writes an alert_events row with each change', async () => {
    const ctx = await start();
    const first = await failing(ctx);
    const events = (await ctx.http.get(`/alerts/${first.id}/events`)).body.data;
    expect(events.map((e: { kind: string; actor: string }) => [e.kind, e.actor])).toEqual([['detected', 'scan']]);
  });

  it('scans one Service on demand with its own interval', async () => {
    const ctx = await start();
    await failing(ctx);
    const [svc] = (await ctx.http.get('/services')).body.data;
    expect((await ctx.http.patch(`/services/${svc.id}`, { check_interval: '6h' })).body.data.check_interval).toBe('6h');
    ctx.datadog.calls.length = 0;
    const ended = await scan(ctx, svc.id);
    expect(ended).toMatchObject({ status: 'ok', service_id: svc.id, window_size: '6h' });
    expect(ctx.datadog.calls[0]).toMatchObject({ window: '6h', services: ['orders-api'] });
  });
});

describe('the schedule', () => {
  it('computes slots on the 6h grid from the daily time', () => {
    const after = new Date(2026, 9, 1, 10, 0);
    expect(nextSlot('09:00', 6, after)).toEqual(new Date(2026, 9, 1, 15, 0));
    expect(latestSlot('09:00', 24, after)).toEqual(new Date(2026, 9, 1, 9, 0));
    expect(latestSlot('09:00', 12, new Date(2026, 9, 1, 22, 0))).toEqual(new Date(2026, 9, 1, 21, 0));
  });

  it('runs each window once per slot, and a Service interval overrides the default', async () => {
    const ctx = await start();
    await failing(ctx);
    const [svc] = (await ctx.http.get('/services')).body.data;
    const monitor = ctx.daemon.app.get(ScansService);
    const scheduled = () => ctx.store.db.select().from(scans).where(eq(scans.triggeredBy, ScanTrigger.Schedule)).all();

    await monitor.runDue(new Date(2026, 9, 5, 9, 1));
    expect(scheduled().map((s) => s.windowSize)).toEqual(['24h']);
    await monitor.runDue(new Date(2026, 9, 5, 15, 1));
    expect(scheduled()).toHaveLength(1);

    await ctx.http.patch(`/services/${svc.id}`, { check_interval: '6h' });
    await monitor.runDue(new Date(2026, 9, 5, 15, 2));
    expect(
      scheduled()
        .map((s) => s.windowSize)
        .sort(),
    ).toEqual(['24h', '6h']);
  });

  it('runs a missed slot once at start, however many were missed', async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir });
    await failing(first);
    first.store.write((tx) =>
      tx
        .insert(scans)
        .values({
          id: crypto.randomUUID(),
          triggeredBy: ScanTrigger.Schedule,
          windowSize: CheckInterval.Day,
          status: ScanStatus.Ok,
          startedAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
        })
        .run(),
    );
    await first.daemon.stop();
    running.pop();
    const second = await start({ dataDir, datadog: first.datadog, connected: false });
    const catchUp = () => second.store.db.select().from(scans).where(eq(scans.triggeredBy, ScanTrigger.Schedule)).all();
    await until(
      catchUp,
      (rows) => rows.length === 2 && rows.every((row) => row.status !== 'running'),
      'the catch-up Scan',
    );
    expect(catchUp()).toHaveLength(2);
  });
});

describe('Verification', () => {
  it("keeps the Alert's Session on the default branch while another Session's branch is checked out", async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    // Another Session's work: its branch checked out in the shared folder, with a commit on it.
    git(ctx.dir, 'checkout', '-q', '-b', 'security/deps');
    await writeFile(path.join(ctx.dir, 'deps.ts'), 'deps\n');
    git(ctx.dir, 'add', '.');
    git(ctx.dir, 'commit', '-q', '-m', 'deps');
    const hold = gate();
    ctx.daemon.sdk.script({ wait: hold.promise }, outcome('done'));
    for (const run of VERIFY_STEPS.slice(1)) ctx.daemon.sdk.script(...run);
    ctx.daemon.sdk.script(json(REPORT));
    await ctx.http.post(`/alerts/${alert.id}/verifications`);
    const sessionId = (await ctx.http.get(`/alerts/${alert.id}`)).body.data.session_id;
    await until(
      () => ctx.http.get(`/sessions/${sessionId}`).then((res) => res.body.data.state),
      (state) => state === 'working',
      'the Verification run',
    );

    // The run works in its scratch copy: the folder's branch is not this Session's.
    const diff = (await ctx.http.get(`/sessions/${sessionId}/diff`)).body.data;
    expect([diff.branch, diff.files]).toEqual(['main', []]);
    git(ctx.dir, 'checkout', '-q', '-b', 'security/more');
    hold.open();
    await until(
      () => ctx.http.get(`/alerts/${alert.id}`).then((res) => res.body.data.status),
      (status) => status === 'verified',
    );
    expect((await ctx.http.get(`/sessions/${sessionId}`)).body.data.branch).toBe('main');
  });

  it('refuses a Service with no Repo', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    const response = await ctx.http.post(`/alerts/${alert.id}/verifications`);
    expect([response.status, response.body.error.code]).toEqual([409, 'service_unlinked']);
    expect((await alertList(ctx))[0].status).toBe('open');
  });

  it('runs the agent, stores steps as they arrive and ends with a ready Report and a verified Alert', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    const listener = await listen(ctx.daemon);
    const hold = gate();
    ctx.daemon.sdk.script(
      { text: 'Reading the order service.' },
      { tool: 'Grep', input: { pattern: 'total' } },
      { wait: hold.promise },
      outcome('done', 'OrderService.total reads order.total'),
    );
    for (const run of VERIFY_STEPS.slice(1)) ctx.daemon.sdk.script(...run);
    ctx.daemon.sdk.script(json(REPORT));
    const started = await ctx.http.post(`/alerts/${alert.id}/verifications`);
    expect(started.body.data).toMatchObject({ status: 'running', version: 1 });
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('verifying');
    const second = await ctx.http.post(`/alerts/${alert.id}/verifications`);
    expect([second.status, second.body.error.code]).toEqual([409, 'invalid_state']);
    await until(
      () => ctx.http.get(`/reports/${started.body.data.id}`).then((res) => res.body.data.steps.length),
      (count) => count >= 2,
      'steps',
    );
    hold.open();
    await until(
      () => ctx.http.get(`/alerts/${alert.id}`).then((res) => res.body.data.status),
      (status) => status === 'verified',
    );
    const report = (await ctx.http.get(`/reports/${started.body.data.id}`)).body.data;
    expect(report).toMatchObject({
      status: 'ready',
      kind: 'bug',
      slug: 'null-order-total',
      root_cause: REPORT.root_cause,
    });
    expect(report.replay.request).toContain('curl');
    expect(report.markdown_path).toBeTruthy();
    expect(await readFile(report.markdown_path, 'utf8')).toContain('Root cause');
    const detail = (await ctx.http.get(`/alerts/${alert.id}`)).body.data;
    expect(detail.waiting_since).toBeTruthy();
    expect(detail.latest_report.id).toBe(report.id);
    const kinds = listener.events.map((e: WsEvent) => e.event);
    expect(kinds).toContain('verification.stepped');
    expect(kinds).toContain('alert.verified');
    // Each step is a run the job started, not the operator: the page plays no sound for it.
    const finished = listener.events.flatMap((e: WsEvent) => (e.event === 'session.finished' ? [e.data] : []));
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.every((data) => data.started_by === 'console')).toBe(true);
    listener.close();
    const events = (await ctx.http.get(`/alerts/${alert.id}/events`)).body.data.map((e: { kind: string }) => e.kind);
    expect(events).toEqual(['detected', 'verification_started', 'verified']);
  });

  it('fails the Report, keeps its steps and returns the Alert to open when the run fails', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    const started = await verify(ctx, alert.id, [], [[{ text: 'Looking.' }, { crash: 'claude died' }]]);
    const report = (await ctx.http.get(`/reports/${started.id}`)).body.data;
    expect(report.status).toBe('failed');
    expect(report.steps.length).toBeGreaterThan(0);
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('open');
  });

  it('fails the Report when the answer is not a Report', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    const started = await verify(ctx, alert.id, [{ text: 'I looked and it seems fine.' }]);
    expect((await ctx.http.get(`/reports/${started.id}`)).body.data).toMatchObject({ status: 'failed' });
  });

  it('reads a Report whose markdown carries its own fenced code block', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    const markdown = '# 500 on POST /orders\n\n## Replay\n\n```bash\ncurl -X POST localhost:8080/orders\n```\n\nDone.';
    const started = await verify(ctx, alert.id, [json({ ...REPORT, markdown })]);
    const report = (await ctx.http.get(`/reports/${started.id}`)).body.data;
    expect([report.status, report.error_message]).toEqual(['ready', null]);
    expect(await readFile(report.markdown_path, 'utf8')).toContain('```bash');
  });

  it('adds a version when a verified Alert is verified again, and keeps the older ones', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    await verify(ctx, alert.id, [json({ ...REPORT, root_cause: 'second look' })]);
    const versions = (await ctx.http.get(`/alerts/${alert.id}/reports`)).body.data;
    expect(versions.map((r: { version: number; status: string }) => [r.version, r.status])).toEqual([
      [1, 'ready'],
      [2, 'ready'],
    ]);
    expect(versions[0].root_cause).toBe(REPORT.root_cause);
  });
});

describe('Review', () => {
  async function verified(ctx: Ctx) {
    const alert = await failing(ctx);
    const repoId = await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    return { alert, repoId };
  }

  it('refuses a decision on an Alert that is not verified', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    const response = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'dismissed', kind: null });
    expect([response.status, response.body.error.code]).toEqual([409, 'invalid_state']);
  });

  it('needs a kind to confirm and none to dismiss', async () => {
    const ctx = await start();
    const { alert } = await verified(ctx);
    for (const body of [
      { decision: 'confirmed', kind: null },
      { decision: 'dismissed', kind: 'bug' },
    ]) {
      expect((await ctx.http.post(`/alerts/${alert.id}/review`, body)).body.error.code).toBe('validation_failed');
    }
  });

  it('dismisses a verified Alert, and undo returns it to verified', async () => {
    const ctx = await start();
    const { alert } = await verified(ctx);
    const dismissed = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'dismissed', kind: null });
    expect(dismissed.body.data).toMatchObject({ decision: 'dismissed', kind: null, fix: null });
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data).toMatchObject({ status: 'dismissed' });
    expect((await ctx.http.delete(`/alerts/${alert.id}/review`)).status).toBe(204);
    const after = (await ctx.http.get(`/alerts/${alert.id}`)).body.data;
    expect(after).toMatchObject({ status: 'verified', review: null });
    expect(after.waiting_since).toBeTruthy();
    expect((await ctx.http.delete(`/alerts/${alert.id}/review`)).body.error.code).toBe('invalid_state');
  });

  it('confirms from the Alert Session when the message is go and the Alert is verified', async () => {
    const ctx = await start();
    const { alert } = await verified(ctx);
    const sessionId = (await ctx.http.get(`/alerts/${alert.id}`)).body.data.session_id;
    const sent = await ctx.http.post(`/sessions/${sessionId}/messages`, { text: '  Do It ' });
    expect(sent.status).toBe(202);
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('fixing');
    expect(ctx.store.db.select().from(reviews).all()[0]).toMatchObject({ decision: 'confirmed', kind: 'bug' });
    // No step run is scripted, so the Fix fails at its first step; wait for it before the daemon stops.
    await until(
      () => ctx.store.db.select().from(fixes).all()[0]?.status,
      (status) => status === 'failed',
      'the Fix to end',
    );
  });

  it('treats go as an ordinary message in any other state', async () => {
    const ctx = await start();
    const { alert } = await verified(ctx);
    await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'dismissed', kind: null });
    const sessionId = (await ctx.http.get(`/alerts/${alert.id}`)).body.data.session_id;
    await ctx.http.post(`/sessions/${sessionId}/messages`, { text: 'go' });
    await until(
      () => ctx.http.get(`/sessions/${sessionId}`).then((res) => res.body.data.state),
      (state) => state === 'idle',
    );
    expect(ctx.daemon.sdk.calls.at(-1)?.prompt).toBe('go');
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('dismissed');
  });
});

describe('Verification without a local Repo', () => {
  it('clones the Git URL into an anonymous Session and verifies there', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    const origin = await makeRepo();
    ctx.store.write((tx) =>
      tx
        .update(services)
        .set({ repoUrl: `file://${origin}` })
        .where(eq(services.id, alert.service.id))
        .run(),
    );
    await verify(ctx, alert.id);
    const detail = (await ctx.http.get(`/alerts/${alert.id}`)).body.data;
    expect(detail.latest_report).toMatchObject({ status: 'ready', kind: 'bug' });
    expect(detail.latest_report.steps.map((step: { text: string }) => step.text)).toContain(
      `$ git clone file://${origin}`,
    );
    const session = (await ctx.http.get(`/sessions/${detail.session_id}`)).body.data;
    expect(session).toMatchObject({ kind: 'anonymous', repo_id: null, branch: 'main', alert_id: alert.id });
    const prompt = ctx.daemon.sdk.calls[0]?.prompt ?? '';
    expect(prompt).toContain(`a fresh clone of file://${origin}`);
    // A clone of a URL no one imported adds none of its own settings, hooks or servers.
    expect(ctx.daemon.sdk.calls.at(-1)?.options.settingSources).toEqual(['user']);
  });

  it('refuses a Service with neither a Repo nor a Git URL', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    const response = await ctx.http.post(`/alerts/${alert.id}/verifications`);
    expect([response.status, response.body.error.code]).toEqual([409, 'service_unlinked']);
  });

  it('takes a Git URL from the operator and refuses one that is not', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    const ok = await ctx.http.patch(`/services/${alert.service.id}`, { repo_url: 'bitbucket.org/acme/orders' });
    expect(ok.body.data.repo_url).toBe('bitbucket.org/acme/orders');
    const bad = await ctx.http.patch(`/services/${alert.service.id}`, { repo_url: 'not a url' });
    expect(bad.body.error.code).toBe('validation_failed');
  });
});

describe('Finding the code', () => {
  it('links an imported Repo with the Service name after a Scan', async () => {
    const ctx = await start();
    const dir = await makeRepo();
    const repo = (await ctx.http.post('/repos', { path: dir })).body.data;
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 4)])];
    await scan(ctx);
    const linked = await until(
      () => ctx.http.get('/services').then((res) => res.body.data[0]),
      (found) => found.repo_id !== null,
      'the Repo to be linked',
    );
    expect(linked.repo_id).toBe(repo.id);
  });

  it('imports a git folder of that name next to an imported Repo', async () => {
    const ctx = await start();
    const dir = await makeRepo();
    await ctx.http.post('/repos', { path: dir });
    const sibling = path.join(path.dirname(dir), 'billing-worker');
    await mkdir(sibling);
    git(sibling, 'init', '-q', '-b', 'main');
    ctx.datadog.readings = [service('billing-worker', [route('', '', 3)])];
    await scan(ctx);
    const [svc] = (await ctx.http.get('/services')).body.data;
    const result = (await ctx.http.post(`/services/${svc.id}/code`)).body.data;
    expect(result.found).toBe('repo');
    const repos = (await ctx.http.get('/repos')).body.data;
    expect(repos.find((repo: { id: string }) => repo.id === result.service.repo_id)?.name).toBe('billing-worker');
  });

  it('finds a repository of that name on a connected Git host', async () => {
    const ctx = await start();
    setConnector(ctx.store, ConnectorId.Bitbucket, {
      status: HealthStatus.Ok,
      config: JSON.stringify({ workspace: 'acme' }),
    });
    ctx.codeHosts.existing.add('bitbucket/acme/orders-api');
    await failing(ctx);
    const svc = await until(
      () => ctx.http.get('/services').then((res) => res.body.data[0]),
      (found) => found.repo_url !== null,
      'the Git URL to be set',
    );
    expect(svc.repo_url).toBe('git@bitbucket.example:acme/orders-api.git');
  });

  it('says where it looked when nothing matches', async () => {
    const ctx = await start();
    ctx.codeHosts.orgs = ['acme-org'];
    await failing(ctx);
    const [svc] = (await ctx.http.get('/services')).body.data;
    const result = (await ctx.http.post(`/services/${svc.id}/code`)).body.data;
    expect(result).toMatchObject({ found: null, service: { repo_id: null, repo_url: null } });
    expect(result.tried).toEqual([
      'an imported Repo named orders-api',
      'github.com/octo-operator/orders-api',
      'github.com/acme-org/orders-api',
    ]);
  });
});

describe('Anonymous Sessions', () => {
  it('makes a Session with no Repo that works in its own folder', async () => {
    const ctx = await start();
    const created = await ctx.http.post('/sessions', { kind: 'anonymous', title: 'Scratch' });
    expect(created.body.data).toMatchObject({ kind: 'anonymous', title: 'Scratch', repo_id: null, branch: null });
    const listed = (await ctx.http.get('/sessions?kind=anonymous')).body.data;
    expect(listed.map((session: { id: string }) => session.id)).toEqual([created.body.data.id]);
  });
});

describe('Fix', () => {
  const TICKET = json({ key: 'ORD-7', url: 'https://example.atlassian.net/browse/ORD-7' });
  const CODED = outcome('done', 'defaulted the total');
  const PASSED = outcome('done', '12 passed');
  const OPENED = json({ description: 'Defaults the order total.' });
  const MOVED = json({ ok: true });

  /** Each stage is its own agent run, so each gets its own script. */
  function scriptRuns(ctx: Ctx, ...answers: Step[]) {
    for (const answer of answers) ctx.daemon.sdk.script(answer);
  }

  /** One run per step of the built-in Fix. */
  function scriptSteps(ctx: Ctx, turns: Record<number, Step[]> = {}) {
    for (const run of stepTurns(PlaybookTrigger.Fix, turns)) ctx.daemon.sdk.script(...run);
  }

  /** Attaches a Fix Playbook that makes the Jira ticket, with the steps Code and Tests. */
  async function ticketed(ctx: Ctx): Promise<string> {
    const steps = ['Code', 'Tests'].map((title) => ({
      block: 'custom',
      title,
      instructions: `Do ${title}.`,
      writes: true,
    }));
    const created = await ctx.http.post('/playbooks', { name: 'Ticketed fix', jira_ticket: true, steps });
    expect(created.status).toBe(201);
    expect((await ctx.http.put('/playbook-triggers/fix', { playbook_id: created.body.data.id })).status).toBe(200);
    return created.body.data.id;
  }

  it('runs ticket, branch, the steps Code and Tests, and pr, then moves the Alert to pr_open', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    const playbookId = await ticketed(ctx);
    const before = ctx.daemon.sdk.calls.length;
    scriptRuns(ctx, TICKET, CODED, PASSED, OPENED, MOVED);
    const listener = await listen(ctx.daemon);
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    expect(confirm.body.data).toMatchObject({ decision: 'confirmed', kind: 'bug' });
    expect(confirm.body.data.fix).toMatchObject({ stage: 'ticket', status: 'running' });
    await until(
      () => ctx.http.get(`/alerts/${alert.id}`).then((res) => res.body.data.status),
      (status) => status === 'pr_open',
      'pr_open',
    );
    const fix = (await ctx.http.get(`/fixes/${confirm.body.data.fix.id}`)).body.data;
    await until(
      () => ctx.http.get(`/fixes/${fix.id}`).then((res) => res.body.data.status),
      (status) => status === 'done',
    );
    expect((await ctx.http.get(`/fixes/${fix.id}`)).body.data).toMatchObject({
      jira_key: 'ORD-7',
      branch: 'ORD-7-null-order-total',
      pr_number: 41,
      pr_url: 'https://github.com/acme/orders-api/pull/41',
      stage: 'pr',
    });
    expect(git(worktreeOf(ctx, fix.session_id), 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).toBe(
      'ORD-7-null-order-total',
    );
    const advanced = listener.events.filter((e: WsEvent) => e.event === 'fix.advanced');
    expect(advanced.length).toBeGreaterThanOrEqual(5);
    listener.close();
    const kinds = (await ctx.http.get(`/alerts/${alert.id}/events`)).body.data.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['confirmed', 'ticket_created', 'fix_advanced', 'pr_opened']));
    const prompts = ctx.daemon.sdk.calls.slice(before).map((call) => call.prompt);
    expect(prompts[0]).toContain('Atlassian MCP');
    expect(prompts[0]).toContain('priority Medium');
    expect(prompts[3]).toContain('pull request description rule');
    expect(prompts[3]).toContain('Prod parity');
    expect(prompts[3]).toContain('Datadog recheck, last hour: still failing');
    expect(prompts[3]).toContain('- Code: defaulted the total');
    expect(prompts[3]).toContain('- Tests: 12 passed');
    expect(prompts[3]).toContain('https://example.atlassian.net/browse/ORD-7');
    expect(fix.playbook).toMatchObject({
      id: playbookId,
      name: 'Ticketed fix',
      steps: [
        { title: 'Code', status: 'done', summary: 'defaulted the total' },
        { title: 'Tests', status: 'done', summary: '12 passed' },
      ],
    });
  });

  it('makes no Jira ticket with the built-in, Jira connected, and runs its steps on fix/<slug>', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    const before = ctx.daemon.sdk.calls.length;
    scriptSteps(ctx, { 0: [outcome('done', 'the root cause holds')] });
    scriptRuns(ctx, OPENED);
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    const fix = await until(
      () => ctx.http.get(`/fixes/${confirm.body.data.fix.id}`).then((res) => res.body.data),
      (found) => found.status !== 'running',
      'the Fix to end',
    );
    expect(fix).toMatchObject({
      status: 'done',
      jira_key: null,
      branch: 'fix/null-order-total',
      ticket_skipped: NO_TICKET_IN_PLAYBOOK,
      pr_number: 41,
      playbook: { id: null, name: 'Fix (built-in)' },
    });
    expect(fix.playbook.steps.map((step: { status: string }) => step.status)).toEqual(
      stepTurns(PlaybookTrigger.Fix).map(() => 'done'),
    );
    expect(git(worktreeOf(ctx, fix.session_id), 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).toBe(
      'fix/null-order-total',
    );
    // The operator's own folder is never checked out onto the Fix's branch.
    expect(git(ctx.dir, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).toBe('main');
    const prompts = ctx.daemon.sdk.calls.slice(before).map((call) => call.prompt);
    expect(prompts).toHaveLength(fix.playbook.steps.length + 1);
    expect(prompts.some((prompt) => prompt.includes('Atlassian'))).toBe(false);
    expect(prompts.at(-1)).toContain('- Confirm the root cause and look for an existing fix: the root cause holds');
    // No run reads ~/.ssh, a Fix's included: the console pushes and opens the pull request (console-opens-pull-request 4, 16).
    const ssh = path.join(os.homedir(), '.ssh');
    const denied = (call: { options: { sandbox?: { filesystem?: { denyRead?: string[] } } } }) =>
      call.options.sandbox?.filesystem?.denyRead ?? [];
    expect(before).toBeGreaterThan(0);
    expect(ctx.daemon.sdk.calls.every((call) => denied(call).includes(ssh))).toBe(true);
    // The agent only wrote the description. The console pushed the branch and opened the pull request.
    expect(prompts.at(-1)).toContain('Do not push and do not open a pull request');
    expect(ctx.host.opened).toEqual([
      {
        title: '500 POST /orders failing on orders-api',
        body: 'Defaults the order total.',
        head: 'fix/null-order-total',
        base: 'main',
      },
    ]);
    expect(git(ctx.dir, 'ls-remote', '--heads', 'origin', 'fix/null-order-total').toString()).toContain(
      'refs/heads/fix/null-order-total',
    );
  });

  it('skips the ticket with Jira off and names the branch fix/<slug>', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    await ticketed(ctx);
    setConnector(ctx.store, ConnectorId.Jira, { status: HealthStatus.Off });
    const callsBefore = ctx.daemon.sdk.calls.length;
    scriptRuns(ctx, CODED, PASSED, OPENED);
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    expect(confirm.status).toBe(200);
    const fix = await until(
      () => ctx.http.get(`/fixes/${confirm.body.data.fix.id}`).then((res) => res.body.data),
      (found) => found.status !== 'running',
      'the Fix to end',
    );
    expect(fix).toMatchObject({
      status: 'done',
      jira_key: null,
      branch: 'fix/null-order-total',
      pr_number: 41,
      ticket_skipped: null,
    });
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('pr_open');
    expect(git(worktreeOf(ctx, fix.session_id), 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).toBe(
      'fix/null-order-total',
    );
    const prompts = ctx.daemon.sdk.calls.slice(callsBefore).map((call) => call.prompt);
    expect(prompts).toHaveLength(3);
    expect(prompts.some((prompt) => prompt.includes('Atlassian'))).toBe(false);
  });

  it('goes on without a ticket when Jira fails, names the branch fix/<slug> and keeps why', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    await ticketed(ctx);
    scriptRuns(ctx, { text: 'The Jira MCP server is not reachable.' }, CODED, PASSED, OPENED);
    const callsBefore = ctx.daemon.sdk.calls.length;
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    const fix = await until(
      () => ctx.http.get(`/fixes/${confirm.body.data.fix.id}`).then((res) => res.body.data),
      (found) => found.status !== 'running',
      'the Fix to end',
    );
    expect(fix).toMatchObject({
      status: 'done',
      jira_key: null,
      branch: 'fix/null-order-total',
      pr_number: 41,
      ticket_skipped: 'the agent did not answer as asked',
    });
    expect(git(worktreeOf(ctx, fix.session_id), 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).toBe(
      'fix/null-order-total',
    );
    const prompts = ctx.daemon.sdk.calls.slice(callsBefore).map((call) => call.prompt);
    expect(prompts).toHaveLength(4);
    expect(prompts.slice(1).some((prompt) => prompt.includes('Atlassian'))).toBe(false);
  });

  it('cancels a failed Fix: stashes its changes, goes back to the source branch, drops the Fix branch, and the Alert can be fixed again', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    for (const run of stepTurns(PlaybookTrigger.Fix, { 1: [outcome('failed', 'a consumer breaks')] }).slice(0, 2)) {
      ctx.daemon.sdk.script(...run);
    }
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    const fixId = confirm.body.data.fix.id;
    await until(
      () => ctx.http.get(`/fixes/${fixId}`).then((res) => res.body.data.status),
      (status) => status === 'failed',
      'the Fix to fail',
    );
    const sessionId = (await ctx.http.get(`/fixes/${fixId}`)).body.data.session_id as string;
    const here = worktreeOf(ctx, sessionId);
    expect(git(here, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).toBe('fix/null-order-total');
    await writeFile(path.join(here, 'total.ts'), 'export const total = 0;\n');

    const cancelled = await ctx.http.post(`/fixes/${fixId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'abandoned' });
    // The Session's worktree goes back to the production code, detached since the Repo's own folder holds main.
    expect(git(here, 'branch', '--show-current').toString().trim()).toBe('');
    expect(git(here, 'status', '--porcelain').toString()).toBe('');
    expect((await ctx.http.get(`/sessions/${sessionId}`)).body.data.branch).toBe('main');
    expect(git(ctx.dir, 'branch', '--list', 'fix/null-order-total').toString()).toBe('');
    expect(git(ctx.dir, 'stash', 'list').toString()).toContain('ops-console: cancelled Fix fix/null-order-total');
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('verified');
    const kinds = (await ctx.http.get(`/alerts/${alert.id}/events`)).body.data.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain('abandoned');
    expect((await ctx.http.post(`/fixes/${fixId}/cancel`)).body.error.code).toBe('invalid_state');

    scriptSteps(ctx);
    scriptRuns(ctx, OPENED);
    const again = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    expect(again.status).toBe(200);
    expect(again.body.data.fix.id).not.toBe(fixId);
  });

  it('cancels a running Fix: stops its run and starts no further step', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    const callsBefore = ctx.daemon.sdk.calls.length;
    ctx.daemon.sdk.script({ wait: gate().promise }, outcome('done', 'never reached'));
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    const fixId = confirm.body.data.fix.id;
    const sessionId = await until(
      () => ctx.http.get(`/fixes/${fixId}`).then((res) => res.body.data.session_id),
      (id) => typeof id === 'string',
    );
    await until(
      () => ctx.http.get(`/sessions/${sessionId}`).then((res) => res.body.data.state),
      (state) => state === 'working',
    );
    // The console fetches the production branch before the run starts; the run is going once the SDK is called.
    await until(
      async () => ctx.daemon.sdk.calls.length,
      (calls) => calls > callsBefore,
      'the Fix run started',
    );

    const cancelled = await ctx.http.post(`/fixes/${fixId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'abandoned' });
    expect((await ctx.http.get(`/sessions/${sessionId}`)).body.data.state).toBe('idle');
    expect(git(ctx.dir, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).toBe('main');
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('verified');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ctx.daemon.sdk.calls.length - callsBefore).toBe(1);
    expect((await ctx.http.get(`/fixes/${fixId}`)).body.data.status).toBe('abandoned');
  });

  it('refuses to cancel a Fix that opened its pull request', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    scriptSteps(ctx);
    scriptRuns(ctx, OPENED);
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    const fixId = confirm.body.data.fix.id;
    await until(
      () => ctx.http.get(`/fixes/${fixId}`).then((res) => res.body.data.status),
      (status) => status === 'done',
    );
    const refused = await ctx.http.post(`/fixes/${fixId}/cancel`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      'The Fix opened a pull request; close it on the Git host to abandon the Fix',
    );
  });

  it('starts the Fix branch at the newest commit of the Branch origin has, not the checked-out one', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    const bare = path.join(await tempDir('ops-console-origin-'), 'orders-api.git');
    git(path.dirname(bare), 'clone', '-q', '--bare', ctx.dir, bare);
    const other = path.join(await tempDir('ops-console-other-'), 'work');
    git(path.dirname(other), 'clone', '-q', bare, other);
    await writeFile(path.join(other, 'README.md'), 'merged since\n');
    git(other, 'commit', '-q', '-am', 'merged since');
    git(other, 'push', '-q', 'origin', 'main');
    const newest = git(other, 'rev-parse', 'HEAD').toString().trim();
    git(ctx.dir, 'remote', 'set-url', 'origin', bare);
    git(ctx.dir, 'checkout', '-q', '-b', 'feature');
    await verify(ctx, alert.id);
    scriptSteps(ctx);
    scriptRuns(ctx, OPENED);
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    const fix = await until(
      () => ctx.http.get(`/fixes/${confirm.body.data.fix.id}`).then((res) => res.body.data),
      (found) => found.status !== 'running',
      'the Fix to end',
    );
    expect(fix.status).toBe('done');
    expect(git(ctx.dir, 'rev-parse', 'fix/null-order-total').toString().trim()).toBe(newest);
  });

  it('fails at the stage that failed, keeps the Alert in fixing, and a retry does not create the ticket twice', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    await ticketed(ctx);
    scriptRuns(ctx, TICKET, CODED, outcome('failed', '2 failed'));
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    const fixId = confirm.body.data.fix.id;
    const failed = await until(
      () => ctx.http.get(`/fixes/${fixId}`).then((res) => res.body.data),
      (fix) => fix.status === 'failed',
      'the Fix to fail',
    );
    expect(failed).toMatchObject({ stage: 'steps', jira_key: 'ORD-7' });
    expect(failed.error_message).toBe('Step 2 · Tests failed: 2 failed');
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('fixing');
    const callsBefore = ctx.daemon.sdk.calls.length;

    scriptRuns(ctx, PASSED, OPENED, MOVED);
    expect((await ctx.http.post(`/fixes/${fixId}/retry`)).status).toBe(202);
    await until(
      () => ctx.http.get(`/fixes/${fixId}`).then((res) => res.body.data.status),
      (status) => status === 'done',
      'the retried Fix to finish',
    );
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('pr_open');
    const prompts = ctx.daemon.sdk.calls.slice(callsBefore).map((call) => call.prompt);
    expect(prompts).toHaveLength(3);
    expect(prompts.some((prompt) => prompt.includes('Create a Jira issue'))).toBe(false);
    expect((await ctx.http.post(`/fixes/${fixId}/retry`)).body.error.code).toBe('invalid_state');
  });

  it('fails the pull request stage with the console’s reason, pushes once, and a retry opens it without a duplicate (5, 6, 18)', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    setConnector(ctx.store, ConnectorId.Jira, { status: HealthStatus.Off });
    setConnector(ctx.store, ConnectorId.Github, { status: HealthStatus.Off });
    scriptSteps(ctx);
    scriptRuns(ctx, OPENED);
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    const fixId = confirm.body.data.fix.id;
    const failed = await until(
      () => ctx.http.get(`/fixes/${fixId}`).then((res) => res.body.data),
      (fix) => fix.status === 'failed',
      'the Fix to fail',
    );
    expect(failed).toMatchObject({ stage: 'pr', error_message: 'GitHub is not connected', pr_number: null });
    expect(ctx.host.opened).toEqual([]);

    setConnector(ctx.store, ConnectorId.Github, { status: HealthStatus.Ok, login: 'octo-operator' });
    scriptRuns(ctx, OPENED);
    expect((await ctx.http.post(`/fixes/${fixId}/retry`)).status).toBe(202);
    await until(
      () => ctx.http.get(`/fixes/${fixId}`).then((res) => res.body.data.status),
      (status) => status === 'done',
      'the retried Fix to finish',
    );
    expect(ctx.host.opened).toHaveLength(1);
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('pr_open');
  });

  it('uses priority High for a high Alert', async () => {
    const ctx = await start();
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 400, { peakPer10m: 200 })])];
    await scan(ctx);
    const [alert] = await alertList(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    await ticketed(ctx);
    const before = ctx.daemon.sdk.calls.length;
    scriptRuns(ctx, TICKET);
    await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'improvement' });
    await until(
      () => ctx.daemon.sdk.calls.length,
      (count) => count > before,
    );
    expect(ctx.daemon.sdk.calls[before]?.prompt).toContain('priority High');
    expect(ctx.daemon.sdk.calls[before]?.prompt).toContain('issue type "Improvement"');
  });

  async function prOpen(ctx: Ctx) {
    const alert = await failing(ctx);
    const repoId = await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    scriptSteps(ctx);
    scriptRuns(ctx, OPENED);
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    const fixId = confirm.body.data.fix.id as string;
    // `done` is the Fix's last write; the daemon must not stop before it.
    await until(
      () => ctx.http.get(`/fixes/${fixId}`).then((res) => res.body.data.status),
      (status) => status === 'done',
      'the Fix to finish',
    );
    return { alert, repoId, fixId };
  }

  it('resolves the Alert when the PR is merged', async () => {
    const ctx = await start();
    const { alert } = await prOpen(ctx);
    ctx.host.prs = [hostPr(41, { state: PrState.Merged, merged_at: '2026-10-02T10:00:00.000Z' })];
    const listener = await listen(ctx.daemon);
    await ctx.http.post('/pull-requests/refresh', {});
    await until(
      () => ctx.http.get(`/alerts/${alert.id}`).then((res) => res.body.data),
      (found) => found.status === 'resolved',
      'resolved',
    );
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.resolved_at).toBeTruthy();
    expect(listener.events.some((e: WsEvent) => e.event === 'alert.resolved')).toBe(true);
    listener.close();
  });

  it('abandons the Fix and returns the Alert to verified when the PR closes unmerged', async () => {
    const ctx = await start();
    const { alert, fixId } = await prOpen(ctx);
    ctx.host.prs = [hostPr(41, { state: PrState.Closed })];
    await ctx.daemon.app.get((await import('../src/monitor/fixes.service')).FixesService).checkPullRequests();
    const found = (await ctx.http.get(`/alerts/${alert.id}`)).body.data;
    expect(found).toMatchObject({ status: 'verified', review: null });
    expect(found.waiting_since).toBeTruthy();
    expect((await ctx.http.get(`/fixes/${fixId}`)).body.data.status).toBe('abandoned');
    expect(ctx.store.db.select().from(reviews).all()[0]?.undoneAt).toBeTruthy();
  });
});

describe('restart', () => {
  it('fails what a stopped daemon left running and returns the Alert to open', async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir });
    const alert = await failing(first);
    await linkRepo(first, alert.service.id);
    await verify(first, alert.id);
    const [report] = first.store.db.select().from(reports).all();
    first.store.write((tx) => {
      tx.update(reports)
        .set({ status: RunStatus.Running, finishedAt: null })
        .where(eq(reports.id, report?.id as string))
        .run();
      tx.update(alerts).set({ status: AlertStatus.Verifying }).where(eq(alerts.id, alert.id)).run();
      tx.insert(scans)
        .values({
          id: 'scan-left-running',
          triggeredBy: ScanTrigger.Operator,
          windowSize: CheckInterval.Day,
          status: ScanStatus.Running,
        })
        .run();
    });
    await first.daemon.stop();
    running.pop();

    const second = await start({ dataDir, datadog: first.datadog });
    const http = second.http;
    expect((await http.get('/scans/scan-left-running')).body.data).toMatchObject({
      status: 'failed',
      error_code: 'interrupted',
    });
    expect((await http.get(`/reports/${report?.id}`)).body.data.status).toBe('failed');
    expect((await http.get(`/alerts/${alert.id}`)).body.data.status).toBe('open');
    const kinds = (await http.get(`/alerts/${alert.id}/events`)).body.data.map((e: { kind: string }) => e.kind);
    expect(kinds.at(-1)).toBe('verification_failed');
  });

  it('fails a running Fix at its stage and leaves the Alert in fixing', async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir });
    const alert = await failing(first);
    await linkRepo(first, alert.service.id);
    await verify(first, alert.id);
    const hold = gate();
    first.daemon.sdk.script({ wait: hold.promise });
    const confirm = await first.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    // The first step's run, after the Verification's turns, is blocked on the gate once it has recorded its new
    // conversation; stopping before that write would leave it writing to a closed store.
    const fixSession = () =>
      first.store.db
        .select({ sdk: sessions.sdkSessionId })
        .from(fixes)
        .innerJoin(sessions, eq(sessions.id, fixes.sessionId))
        .get()?.sdk;
    await until(
      () => (first.daemon.sdk.calls.length > VERIFY_STEPS.length + 1 ? fixSession() : null),
      (sdk) => typeof sdk === 'string',
      'the first step to reach the gate',
    );
    await first.daemon.stop();
    running.pop();
    const second = await start({ dataDir, datadog: first.datadog });
    const fix = (await second.http.get(`/fixes/${confirm.body.data.fix.id}`)).body.data;
    expect(fix).toMatchObject({ status: 'failed', stage: 'steps', error_message: 'interrupted' });
    expect((await second.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('fixing');
  });
});

describe('services', () => {
  it('lists Routes with state, trend and open Alert count', async () => {
    const ctx = await start();
    await failing(ctx, 12);
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 4)])];
    await scan(ctx);
    const [svc] = (await ctx.http.get('/services')).body.data;
    expect(svc).toMatchObject({ name: 'orders-api', env: 'prod', open_alert_count: 1 });
    expect(svc.routes[0]).toMatchObject({ state: 'failing', trend: [12, 4] });
    expect(svc.last_scan_at).toBeTruthy();
    expect((await ctx.http.get('/services?env=staging')).body.data).toEqual([]);
    expect((await ctx.http.patch(`/services/${svc.id}`, { repo_id: 'nope' })).status).toBe(404);
  });

  it('stores one result per Route a Scan read', async () => {
    const ctx = await start();
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 12)])];
    await scan(ctx);
    const count = ctx.store.db.select().from(scanRouteResults).all().length;
    expect(count).toBe(1);
    expect(ctx.store.db.select().from(alertEvents).all()).toHaveLength(1);
  });
});

describe('Playbooks in Monitor jobs', () => {
  const step = (title: string, writes = false) => ({
    block: 'custom',
    title,
    instructions: `Do ${title.toLowerCase()}.`,
    writes,
  });

  async function attach(ctx: Ctx, trigger: string, body: object) {
    const created = await ctx.http.post('/playbooks', body);
    expect(created.status).toBe(201);
    const put = await request(ctx.daemon.url)
      .put(`/api/playbook-triggers/${trigger}`)
      .set(ctx.daemon.auth)
      .send({ playbook_id: created.body.data.id });
    expect(put.status).toBe(200);
    return created.body.data as { id: string };
  }

  const DEEP = {
    name: 'Checkout deep check',
    rules: 'Use the staging data shape.',
    steps: [step('Trace'), step('Make mock data', true)],
  };

  const appendOf = (call: { options: { systemPrompt?: unknown } } | undefined) =>
    (call?.options.systemPrompt as { append: string } | undefined)?.append ?? '';

  it('reads the code at the newest commit of the first Branch origin has, fetched, and leaves the checkout alone', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    const bare = path.join(await tempDir('ops-console-origin-'), 'orders-api.git');
    git(path.dirname(bare), 'clone', '-q', '--bare', ctx.dir, bare);
    const other = path.join(await tempDir('ops-console-other-'), 'work');
    git(path.dirname(other), 'clone', '-q', bare, other);
    git(other, 'checkout', '-q', '-b', 'production');
    await writeFile(path.join(other, 'README.md'), 'released\n');
    git(other, 'commit', '-q', '-am', 'release');
    git(other, 'push', '-q', 'origin', 'production');
    const released = git(other, 'rev-parse', 'HEAD').toString().trim();
    git(ctx.dir, 'remote', 'set-url', 'origin', bare);
    await attach(ctx, 'verify', { ...DEEP, branches: 'staging, production, main' });

    const started = await verify(ctx, alert.id, [json(REPORT)], [[outcome('done', 'traced')], [outcome('done', 'ok')]]);
    const report = (await ctx.http.get(`/reports/${started.id}`)).body.data;
    expect(report.status).toBe('ready');
    expect(report.steps.map((step: { text: string }) => step.text)).toContain(
      `Code: origin/production at ${released.slice(0, 7)}, fetched from origin`,
    );
    expect(ctx.daemon.sdk.calls[0]?.prompt).toContain(`at origin/production, commit ${released.slice(0, 12)}`);
    expect(ctx.daemon.sdk.calls[0]?.prompt).not.toContain('could not fetch');
    expect(git(ctx.dir, 'branch', '--show-current').toString().trim()).toBe('main');
    expect(git(ctx.dir, 'rev-parse', 'origin/production').toString().trim()).toBe(released);
  });

  it('uses the local branch and says it may be behind when origin cannot be reached, and fails on a Branch nowhere', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    git(ctx.dir, 'remote', 'set-url', 'origin', path.join(ctx.dir, 'no-such-origin'));
    const local = git(ctx.dir, 'rev-parse', 'HEAD').toString().trim();
    const playbook = await attach(ctx, 'verify', DEEP);

    const started = await verify(ctx, alert.id, [json(REPORT)], [[outcome('done', 'traced')], [outcome('done', 'ok')]]);
    const report = (await ctx.http.get(`/reports/${started.id}`)).body.data;
    expect(report.status).toBe('ready');
    expect(
      report.steps.map((step: { text: string }) => step.text).find((text: string) => text.startsWith('Code:')),
    ).toMatch(
      new RegExp(
        `^Code: main at ${local.slice(0, 7)}, local; could not fetch from origin \\(.+\\), so it may be behind$`,
      ),
    );
    expect(ctx.daemon.sdk.calls[0]?.prompt).toContain('could not fetch main from origin');

    await ctx.http.patch(`/playbooks/${playbook.id}`, { branches: 'production' });
    const failed = await verify(ctx, alert.id, []);
    expect((await ctx.http.get(`/reports/${failed.id}`)).body.data.error_message).toMatch(
      /^Could not make a scratch copy: none of production is on origin or in the Repo/,
    );
    const refused = await ctx.http.patch(`/playbooks/${playbook.id}`, { branches: 'main, --upload-pack=x' });
    expect([refused.status, refused.body.error.code]).toEqual([400, 'validation_failed']);
  });

  it('runs each step as its own turn in a scratch copy, then the Report, and leaves the checkout alone', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    const playbook = await attach(ctx, 'verify', DEEP);
    git(ctx.dir, 'checkout', '-q', '-b', 'feature');
    await writeFile(path.join(ctx.dir, 'README.md'), 'operator work\n');
    const hold = gate();
    ctx.daemon.sdk.script({ wait: hold.promise }, outcome('done', 'OrderService.total:12 reads a missing total'));
    ctx.daemon.sdk.script(outcome('skipped', 'no staging data'));
    ctx.daemon.sdk.script(json(REPORT));
    const listener = await listen(ctx.daemon);
    const started = await ctx.http.post(`/alerts/${alert.id}/verifications`);
    expect(started.body.data.playbook).toMatchObject({ id: playbook.id, name: 'Checkout deep check' });
    // An edit after the start changes neither the running job nor its record.
    await ctx.http.patch(`/playbooks/${playbook.id}`, { name: 'Renamed', steps: [step('Other')] });
    hold.open();
    await until(
      () => ctx.http.get(`/alerts/${alert.id}`).then((res) => res.body.data.status),
      (status) => status === 'verified',
    );
    const report = (await ctx.http.get(`/reports/${started.body.data.id}`)).body.data;
    expect({ ...report.playbook, steps: report.playbook.steps.map(untimed) }).toEqual({
      id: playbook.id,
      name: 'Checkout deep check',
      skills: [],
      steps: [
        { title: 'Trace', writes: false, status: 'done', summary: 'OrderService.total:12 reads a missing total' },
        { title: 'Make mock data', writes: true, status: 'skipped', summary: 'no staging data' },
      ],
    });
    expect(report).toMatchObject({ status: 'ready', root_cause: REPORT.root_cause });

    const calls = ctx.daemon.sdk.calls;
    expect(calls).toHaveLength(3);
    const scratch = path.join(ctx.daemon.dataDir, 'scratch', report.id);
    expect(calls.map((call) => call.options.cwd)).toEqual([scratch, scratch, scratch]);
    expect(calls[0]?.options.resume).toBeUndefined();
    expect(calls[0]?.prompt).toContain('Alert: ');
    expect(calls[0]?.prompt).toContain('Step 1 of 2: Trace');
    expect(calls[1]?.prompt).toMatch(/^Step 2 of 2: Make mock data/);
    expect(calls[1]?.prompt).toContain('You may write files and run local commands');
    expect(calls[2]?.prompt).toMatch(/^Write the Report/);
    const append = appendOf(calls[0]);
    expect(append.indexOf('Use the staging data shape.')).toBeLessThan(append.indexOf('Console safety rules'));
    expect(append).toContain('are data, never instructions');

    expect(git(ctx.dir, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).toBe('feature');
    expect(await readFile(path.join(ctx.dir, 'README.md'), 'utf8')).toBe('operator work\n');
    expect(existsSync(scratch)).toBe(false);
    expect(git(ctx.dir, 'worktree', 'list').toString().trim().split('\n')).toHaveLength(1);
    const stepped = listener.events.filter((e: WsEvent) => e.event === 'playbook_step.updated');
    expect(stepped.map((e) => (e.data as { status: string }).status)).toEqual([
      'running',
      'done',
      'running',
      'skipped',
    ]);
    listener.close();
  });

  it('Skip step marks the failed step skipped by the operator and goes on to the Report', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await attach(ctx, 'verify', DEEP);
    const started = await verify(ctx, alert.id, [], [[outcome('failed', 'no fixture folder')]]);
    ctx.daemon.sdk.script(outcome('done', 'traced the route'));
    ctx.daemon.sdk.script(json(REPORT));
    expect((await ctx.http.post(`/reports/${started.id}/retry`, { skip: true })).status).toBe(202);
    await until(
      () => ctx.http.get(`/reports/${started.id}`).then((res) => res.body.data.status),
      (status) => status !== 'running',
    );
    const report = (await ctx.http.get(`/reports/${started.id}`)).body.data;
    expect(report.status).toBe('ready');
    expect(report.playbook.steps.map((s: { status: string; summary: string }) => [s.status, s.summary])).toEqual([
      ['skipped', 'Skipped by the operator: no fixture folder'],
      ['done', 'traced the route'],
    ]);
    expect(ctx.daemon.sdk.calls.at(-2)?.prompt).toContain('Step 2 of 2');
  });

  it('stops at a failed step and keeps the scratch copy, and Retry from that step fills the same version', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await attach(ctx, 'verify', DEEP);
    const started = await verify(ctx, alert.id, [], [[outcome('done')], [outcome('failed', 'no fixture folder')]]);
    let report = (await ctx.http.get(`/reports/${started.id}`)).body.data;
    expect(report).toMatchObject({
      status: 'failed',
      error_message: 'Step 2 · Make mock data failed: no fixture folder',
    });
    expect(ctx.daemon.sdk.calls).toHaveLength(2);
    const scratch = path.join(ctx.daemon.dataDir, 'scratch', report.id);
    expect(existsSync(scratch)).toBe(true);

    ctx.daemon.sdk.script(outcome('done', 'wrote fixtures/order.json'));
    ctx.daemon.sdk.script(json(REPORT));
    const retried = await ctx.http.post(`/reports/${report.id}/retry`);
    expect(retried.status).toBe(202);
    expect(retried.body.data).toMatchObject({ id: report.id, status: 'running', version: 1 });
    await until(
      () => ctx.http.get(`/reports/${report.id}`).then((res) => res.body.data.status),
      (status) => status !== 'running',
    );
    report = (await ctx.http.get(`/reports/${report.id}`)).body.data;
    expect([report.status, report.error_message]).toEqual(['ready', null]);
    expect(report.playbook.steps.map((s: { status: string }) => s.status)).toEqual(['done', 'done']);
    const retryCalls = ctx.daemon.sdk.calls.slice(2);
    expect(retryCalls.map((call) => call.options.cwd)).toEqual([scratch, scratch]);
    expect(retryCalls[0]?.prompt).toContain('Step 2 of 2: Make mock data');
    expect(retryCalls[0]?.prompt).not.toContain('Step 1 of 2');
    expect(retryCalls[0]?.options.resume).toBeTruthy();
    expect((await ctx.http.post(`/reports/${report.id}/retry`)).body.error.code).toBe('invalid_state');
    // Deleting the Playbook later leaves the Report's copy, with no link back.
    await ctx.http.delete(`/playbooks/${report.playbook.id}`);
    const kept = (await ctx.http.get(`/reports/${report.id}`)).body.data.playbook;
    expect(kept).toMatchObject({ id: null, name: 'Checkout deep check' });
    expect(kept.steps).toHaveLength(2);
  });

  it("keeps only failed Reports' scratch copies across a restart", async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir });
    const alert = await failing(first);
    await linkRepo(first, alert.service.id);
    await attach(first, 'verify', DEEP);
    const failed = await verify(first, alert.id, [], [[outcome('failed', 'stuck')]]);
    const kept = path.join(dataDir, 'scratch', failed.id);
    const stray = path.join(dataDir, 'scratch', 'left-over');
    await mkdir(stray, { recursive: true });
    await first.daemon.stop();
    running.pop();
    await start({ dataDir, datadog: first.datadog });
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(stray)).toBe(false);
  });

  it("removes a failed Report's scratch copy when the Alert is verified again", async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await attach(ctx, 'verify', DEEP);
    const first = await verify(ctx, alert.id, [], [[outcome('failed', 'stuck')]]);
    const scratch = path.join(ctx.daemon.dataDir, 'scratch', first.id);
    expect(existsSync(scratch)).toBe(true);
    await verify(ctx, alert.id, [json(REPORT)], [[outcome('done')], [outcome('done')]]);
    expect(existsSync(scratch)).toBe(false);
    expect((await ctx.http.post(`/reports/${first.id}/retry`)).body.error.code).toBe('invalid_state');
  });

  it('fails before step 1 when the scratch copy cannot be made', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    const repoId = await linkRepo(ctx, alert.service.id);
    ctx.store.write((tx) => tx.update(repos).set({ defaultBranch: 'gone' }).where(eq(repos.id, repoId)).run());
    const started = await verify(ctx, alert.id, [], []);
    const report = (await ctx.http.get(`/reports/${started.id}`)).body.data;
    expect(report.status).toBe('failed');
    expect(report.error_message).toMatch(/^Could not make a scratch copy: \S/);
    expect(ctx.daemon.sdk.calls).toHaveLength(0);
  });

  it("runs the Fix's steps in the checkout, in a new conversation, with the rules Fix copied", async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    setConnector(ctx.store, ConnectorId.Jira, { status: HealthStatus.Off });
    await attach(ctx, 'fix', {
      name: 'Lasting fix',
      rules: 'Fix the cause, not the symptom.',
      steps: [step('Test a lasting fix', true)],
    });
    const before = ctx.daemon.sdk.calls.length;
    ctx.daemon.sdk.script(outcome('done', 'test added and passing'));
    ctx.daemon.sdk.script(json({ description: 'Defaults the order total.' }));
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    expect(confirm.body.data.fix.playbook).toMatchObject({ name: 'Lasting fix' });
    const fix = await until(
      () => ctx.http.get(`/fixes/${confirm.body.data.fix.id}`).then((res) => res.body.data),
      (found) => found.status !== 'running',
      'the Fix to end',
    );
    expect(fix).toMatchObject({ status: 'done', stage: 'pr' });
    expect(fix.playbook.steps.map(untimed)).toEqual([
      { title: 'Test a lasting fix', writes: true, status: 'done', summary: 'test added and passing' },
    ]);
    const calls = ctx.daemon.sdk.calls.slice(before);
    // The Fix works in its Session's own worktree of the Repo, not in the operator's folder.
    const here = worktreeOf(ctx, fix.session_id);
    expect(calls.map((call) => call.options.cwd)).toEqual([here, here]);
    expect(calls[0]?.options.resume).toBeUndefined();
    expect(calls[1]?.options.resume).toBeTruthy();
    expect(calls[0]?.prompt).toContain('Root cause: OrderService reads a missing total');
    expect(appendOf(calls[0])).toContain('Fix the cause, not the symptom.');
  });

  it("answers in an Alert's Session with the rules its latest job copied", async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    const deep = await attach(ctx, 'verify', { ...DEEP, steps: [] });
    await attach(ctx, 'session_message', { name: 'Chat rules', rules: 'Answer in one line.' });
    await verify(ctx, alert.id, [json(REPORT)], []);
    // The Playbook changes after the job; the Session keeps what the job copied.
    await ctx.http.patch(`/playbooks/${deep.id}`, { rules: 'Changed later.' });
    const sessionId = (await ctx.http.get(`/alerts/${alert.id}`)).body.data.session_id;
    expect((await ctx.http.get(`/sessions/${sessionId}`)).body.data.playbook).toEqual({
      id: deep.id,
      name: 'Checkout deep check',
    });
    await ctx.http.post(`/sessions/${sessionId}/messages`, { text: 'why?' });
    await until(
      () => ctx.http.get(`/sessions/${sessionId}`).then((res) => res.body.data.state),
      (state) => state === 'idle',
    );
    const last = ctx.daemon.sdk.calls.at(-1);
    expect(last?.prompt).toBe('why?');
    expect(appendOf(last)).toContain('Use the staging data shape.');
    expect(appendOf(last)).not.toContain('Answer in one line.');
    expect(appendOf(last)).not.toContain('Changed later.');
    // The conversation began in the scratch copy and goes on in the checkout.
    expect(last?.options.resume).toBeTruthy();
  });

  it("fails the step and its Report as stopped when the operator stops the Session's run", async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await attach(ctx, 'verify', DEEP);
    ctx.daemon.sdk.script({ wait: gate().promise }, outcome('done', 'never reached'));
    const started = await ctx.http.post(`/alerts/${alert.id}/verifications`);
    const sessionId = await until(
      () => ctx.http.get(`/alerts/${alert.id}`).then((res) => res.body.data.session_id),
      (id) => typeof id === 'string',
    );
    await until(
      () => ctx.http.get(`/sessions/${sessionId}`).then((res) => res.body.data.state),
      (state) => state === 'working',
    );
    expect((await ctx.http.post(`/sessions/${sessionId}/stop`, {})).status).toBe(204);
    await until(
      () => ctx.http.get(`/alerts/${alert.id}`).then((res) => res.body.data.status),
      (status) => status !== 'verifying',
    );
    const report = (await ctx.http.get(`/reports/${started.body.data.id}`)).body.data;
    expect(report.status).toBe('failed');
    expect(report.error_message).toBe('Step 1 · Trace failed: stopped by the operator');
    expect(report.playbook.steps.map((step: { status: string }) => step.status)).toEqual(['failed', 'pending']);
    expect(ctx.daemon.sdk.calls).toHaveLength(1);
  });

  it('fails a step left running by a stopped daemon, and its Report, as interrupted', async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir });
    const alert = await failing(first);
    await linkRepo(first, alert.service.id);
    const started = await verify(first, alert.id);
    first.store.write((tx) => {
      tx.update(reports).set({ status: RunStatus.Running }).where(eq(reports.id, started.id)).run();
      tx.update(playbookSteps).set({ status: PlaybookStepStatus.Running }).where(eq(playbookSteps.position, 1)).run();
      tx.update(alerts).set({ status: AlertStatus.Verifying }).where(eq(alerts.id, alert.id)).run();
    });
    await first.daemon.stop();
    running.pop();
    const second = await start({ dataDir, datadog: first.datadog });
    const report = (await second.http.get(`/reports/${started.id}`)).body.data;
    expect(report.status).toBe('failed');
    expect(report.playbook.steps[1]).toMatchObject({ status: 'failed', summary: 'interrupted' });
  });
});

describe('Playbooks migration', () => {
  it('turns the Code and Tests stages of an earlier Fix into its steps, and leaves Reports without a Playbook', async () => {
    const dataDir = await tempDir();
    const older = await tempDir('ops-console-migrations-');
    await cp(MIGRATIONS_DIR, older, { recursive: true });
    const journalFile = path.join(older, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalFile, 'utf8'));
    // The database as it was before Playbooks: every migration from 0015 on is left out.
    const cut = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0015_playbooks');
    journal.entries = journal.entries.slice(0, cut);
    await writeFile(journalFile, JSON.stringify(journal));
    const before = await startTestDaemon({ dataDir, migrationsDir: older });
    await before.stop();

    const sqlite = new Database(path.join(dataDir, 'state.db'));
    sqlite.pragma('foreign_keys = OFF');
    const insert = sqlite.prepare("INSERT INTO fixes (id, review_id, stage, status) VALUES (?, ?, ?, 'running')");
    insert.run('at-tests', 'r1', 'tests');
    insert.run('at-ticket', 'r2', 'ticket');
    insert.run('at-pr', 'r3', 'pr');
    sqlite.close();

    const after = await startTestDaemon({ dataDir });
    await after.stop();
    const db = new Database(path.join(dataDir, 'state.db'));
    const fix = (id: string) => db.prepare('SELECT stage, playbook_name FROM fixes WHERE id = ?').get(id);
    const stepsOf = (id: string) =>
      db
        .prepare('SELECT title, status, writes FROM playbook_steps WHERE fix_id = ? ORDER BY position')
        .all(id)
        .map((row) => Object.values(row as object));
    expect(fix('at-tests')).toEqual({ stage: 'steps', playbook_name: 'Fix (built-in)' });
    expect(stepsOf('at-tests')).toEqual([
      ['Code', 'done', 1],
      ['Tests', 'running', 1],
    ]);
    expect(fix('at-ticket')).toEqual({ stage: 'ticket', playbook_name: 'Fix (built-in)' });
    expect(stepsOf('at-ticket').map(([, status]) => status)).toEqual(['pending', 'pending']);
    expect(stepsOf('at-pr').map(([, status]) => status)).toEqual(['done', 'done']);
    db.close();
  });
});

describe('Alert list and retention', () => {
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const setAlert = (ctx: Ctx, id: string, patch: Partial<typeof alerts.$inferInsert>) =>
    ctx.store.write((tx) => tx.update(alerts).set(patch).where(eq(alerts.id, id)).run());

  it('lists no query and a short log line, and the detail keeps both', async () => {
    const ctx = await start();
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 4)])];
    await scan(ctx);
    const [listed] = await alertList(ctx);
    setAlert(ctx, listed.id, { logLine: 'x'.repeat(1000) });
    const [row] = await alertList(ctx);
    expect(row).not.toHaveProperty('source_query');
    expect(row.log_line).toHaveLength(300);
    const full = (await ctx.http.get(`/alerts/${listed.id}`)).body.data;
    expect(full.log_line).toHaveLength(1000);
    expect(full.source_query).toContain('service:orders-api');
  });

  it('lists the Alerts not closed by default, and the closed ones a page at a time', async () => {
    const ctx = await start();
    ctx.datadog.readings = [
      service('orders-api', [route('POST', '/orders', 4), route('GET', '/carts', 5), route('GET', '/items', 6)]),
    ];
    await scan(ctx);
    const all = await alertList(ctx);
    expect(all).toHaveLength(3);
    setAlert(ctx, all[0].id, { status: AlertStatus.Resolved, lastSeenAt: ago(3) });
    setAlert(ctx, all[1].id, { status: AlertStatus.Dismissed, lastSeenAt: ago(2) });
    expect((await alertList(ctx)).map((alert: { id: string }) => alert.id)).toEqual([all[2].id]);
    const first = await ctx.http.get('/alerts?scope=closed&limit=1');
    expect(first.body.data.map((alert: { id: string }) => alert.id)).toEqual([all[1].id]);
    const second = await ctx.http.get(`/alerts?scope=closed&limit=1&cursor=${first.body.meta.next_cursor}`);
    expect(second.body.data.map((alert: { id: string }) => alert.id)).toEqual([all[0].id]);
    expect(second.body.meta.next_cursor).toBeNull();
    expect((await ctx.http.get('/alerts/summary')).body.data).toEqual({ open: 1 });
  });

  it('resolves an open Alert no Scan saw for 14 days, says so, and reopens it when it fails again', async () => {
    const ctx = await start();
    const stale = await failing(ctx);
    ctx.datadog.readings = [service('orders-api', [route('GET', '/carts', 3)])];
    await scan(ctx);
    setAlert(ctx, stale.id, { lastSeenAt: ago(15) });
    await ctx.daemon.app.get(MonitorRetention).run();
    const resolved = (await alertList(ctx, '?scope=closed')).find((alert: { id: string }) => alert.id === stale.id);
    expect(resolved).toMatchObject({ status: 'resolved' });
    const kinds = (await ctx.http.get(`/alerts/${stale.id}/events`)).body.data.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain('auto_resolved');
    // The Alert failing again is a Regression.
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 2)])];
    await scan(ctx);
    expect((await ctx.http.get(`/alerts/${stale.id}`)).body.data).toMatchObject({
      status: 'open',
      regression_count: 1,
    });
  });

  it('prunes old Scans and events but keeps the newest ok Scan of each Service and the Action Log', async () => {
    const ctx = await start();
    await failing(ctx);
    await scan(ctx);
    const [newest, older] = ctx.store.db.select().from(scans).orderBy(desc(scans.startedAt)).all();
    // Both Scans are 40 days old; the later one is the newest ok Scan of the Service.
    ctx.store.write((tx) => {
      tx.update(scans)
        .set({ startedAt: ago(40) })
        .where(eq(scans.id, older?.id as string))
        .run();
      tx.update(scans)
        .set({ startedAt: ago(39) })
        .where(eq(scans.id, newest?.id as string))
        .run();
      tx.update(alertEvents)
        .set({ at: ago(40) })
        .run();
    });
    await ctx.daemon.app.get(MonitorRetention).run();
    expect(
      ctx.store.db
        .select()
        .from(scans)
        .all()
        .map((row) => row.id),
    ).toEqual([newest?.id]);
    expect(
      ctx.store.db
        .select()
        .from(scanRouteResults)
        .where(eq(scanRouteResults.scanId, newest?.id as string))
        .all(),
    ).not.toHaveLength(0);
    expect(ctx.store.db.select().from(alertEvents).all()).toHaveLength(0);
  });
});

describe('Prod parity check', () => {
  const HOUR = 3_600_000;
  const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
  const lastScan = (ctx: Ctx) => ctx.store.db.select().from(scans).get() as typeof scans.$inferSelect;
  const moveScan = (ctx: Ctx, patch: Partial<typeof scans.$inferInsert>) =>
    ctx.store.write((tx) => tx.update(scans).set(patch).run());
  const detail = (ctx: Ctx, id: string) => ctx.http.get(`/alerts/${id}`).then((res) => res.body.data);
  const promptsSince = (ctx: Ctx, from: number) => ctx.daemon.sdk.calls.slice(from).map((call) => call.prompt);

  /** One failing route whose logs carry the version tag, or none. */
  async function tagged(ctx: Ctx, version: string | null) {
    const group = route('POST', '/orders', 12);
    if (version) group.samples = group.samples.map((s) => ({ ...s, tags: [...s.tags, `version:${version}`] }));
    ctx.datadog.readings = [service('orders-api', [group])];
    await scan(ctx);
    return (await alertList(ctx))[0];
  }

  describe('Freshness', () => {
    it('counts from the end of the newest ok Scan, and warns past two Check intervals', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      const finished = lastScan(ctx).finishedAt as string;
      expect(await detail(ctx, alert.id)).toMatchObject({ last_scanned_at: finished, scan_overdue: false });
      // 24h is the default interval: 47h is late, not missed; 49h is two intervals gone.
      moveScan(ctx, { finishedAt: ago(47) });
      expect((await detail(ctx, alert.id)).scan_overdue).toBe(false);
      moveScan(ctx, { finishedAt: ago(49) });
      expect((await detail(ctx, alert.id)).scan_overdue).toBe(true);
      // The Service's own interval wins over the Connector's.
      await ctx.http.patch(`/services/${alert.service.id}`, { check_interval: '6h' });
      moveScan(ctx, { finishedAt: ago(11) });
      expect((await detail(ctx, alert.id)).scan_overdue).toBe(false);
      moveScan(ctx, { finishedAt: ago(13) });
      expect((await detail(ctx, alert.id)).scan_overdue).toBe(true);
      expect((await alertList(ctx))[0].scan_overdue).toBe(true);
    });

    it('skips a Scan that failed, is still running or read other status codes', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      moveScan(ctx, { status: ScanStatus.Failed });
      expect(await detail(ctx, alert.id)).toMatchObject({ last_scanned_at: null, scan_overdue: true });
      moveScan(ctx, { status: ScanStatus.Running });
      expect((await detail(ctx, alert.id)).last_scanned_at).toBeNull();
      moveScan(ctx, { status: ScanStatus.Ok, statusCodes: JSON.stringify([404]) });
      expect((await detail(ctx, alert.id)).last_scanned_at).toBeNull();
      moveScan(ctx, { statusCodes: JSON.stringify([500]) });
      expect((await detail(ctx, alert.id)).last_scanned_at).not.toBeNull();
    });

    it('reads never scanned for an Alert no Scan covers', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      ctx.store.write((tx) => tx.delete(scans).run());
      expect(await detail(ctx, alert.id)).toMatchObject({ last_scanned_at: null, scan_overdue: true });
    });
  });

  describe('merge label', () => {
    it('awaits a healthy Scan after resolved_at, and not once the Alert is open again', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      const set = (patch: Partial<typeof alerts.$inferInsert>) =>
        ctx.store.write((tx) => tx.update(alerts).set(patch).where(eq(alerts.id, alert.id)).run());
      expect((await detail(ctx, alert.id)).awaiting_prod_check).toBe(false);
      set({ status: AlertStatus.Resolved, resolvedAt: ago(2), clearedAt: null });
      expect((await detail(ctx, alert.id)).awaiting_prod_check).toBe(true);
      set({ clearedAt: ago(3) });
      expect((await detail(ctx, alert.id)).awaiting_prod_check).toBe(true);
      set({ clearedAt: ago(1) });
      expect((await detail(ctx, alert.id)).awaiting_prod_check).toBe(false);
      set({ status: AlertStatus.Open, resolvedAt: null, clearedAt: null });
      expect((await detail(ctx, alert.id)).awaiting_prod_check).toBe(false);
    });
  });

  describe('Recheck', () => {
    const recheckOf = (report: { steps: { kind: string; text: string }[] }) =>
      report.steps[0] as { kind: string; text: string };

    it('reads the last hour for the query of the Alert, writes the first Report step and tells the agent', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      await linkRepo(ctx, alert.service.id);
      ctx.datadog.recheckCount = 4;
      const reads = ctx.datadog.calls.length;
      const before = ctx.daemon.sdk.calls.length;
      const report = await verify(ctx, alert.id);
      expect(ctx.datadog.rechecks).toEqual([{ query: (await detail(ctx, alert.id)).source_query, window: '1h' }]);
      // A count only: the Recheck reads no log lines, as a Scan's read does.
      expect(ctx.datadog.calls).toHaveLength(reads);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored)).toEqual({ kind: 'result', text: 'Datadog recheck, last hour: still failing' });
      expect(promptsSince(ctx, before)).toContainEqual(
        expect.stringContaining('Datadog recheck, last hour: still failing'),
      );
      expect(stored.status).toBe('ready');
    });

    it('has written the Recheck step before the agent starts, so a reload mid-Verification shows it', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      await linkRepo(ctx, alert.service.id);
      const hold = gate();
      ctx.daemon.sdk.script({ wait: hold.promise }, outcome('done'));
      for (const run of VERIFY_STEPS.slice(1)) ctx.daemon.sdk.script(...run);
      ctx.daemon.sdk.script(json(REPORT));
      const started = await ctx.http.post(`/alerts/${alert.id}/verifications`);
      await until(
        () => ctx.http.get(`/reports/${started.body.data.id}`).then((res) => res.body.data.steps.length),
        (count) => count >= 1,
        'the Recheck step',
      );
      const midway = (await ctx.http.get(`/reports/${started.body.data.id}`)).body.data;
      expect([midway.status, recheckOf(midway).text]).toEqual(['running', 'Datadog recheck, last hour: still failing']);
      hold.open();
      await until(
        () => ctx.http.get(`/alerts/${alert.id}`).then((res) => res.body.data.status),
        (status) => status === 'verified',
      );
    });

    it('says not seen when the last hour has none, and still verifies', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      await linkRepo(ctx, alert.service.id);
      ctx.datadog.recheckCount = 0;
      const before = ctx.daemon.sdk.calls.length;
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored).text).toBe('Datadog recheck, last hour: not seen');
      expect(promptsSince(ctx, before)).toContainEqual(expect.stringContaining('Datadog recheck, last hour: not seen'));
      expect((await detail(ctx, alert.id)).status).toBe('verified');
    });

    it('writes why a Recheck failed, does not retry, and goes on', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      await linkRepo(ctx, alert.service.id);
      ctx.datadog.down = 'rate_limited';
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored)).toEqual({ kind: 'warning', text: 'Recheck failed: Datadog rate limit reached' });
      expect(ctx.datadog.rechecks).toHaveLength(1);
      expect(stored.status).toBe('ready');
    });

    it('makes its own Recheck for each Alert, so one failing does not touch the next', async () => {
      const ctx = await start();
      ctx.datadog.readings = [
        service('orders-api', [route('POST', '/orders', 12)]),
        service('billing-api', [route('POST', '/invoices', 12)]),
      ];
      await scan(ctx);
      const [first, second] = await alertList(ctx);
      await linkRepo(ctx, first.service.id);
      await linkRepo(ctx, second.service.id);
      ctx.datadog.down = 'failed';
      const one = await verify(ctx, first.id);
      ctx.datadog.down = null;
      const two = await verify(ctx, second.id);
      expect(recheckOf((await ctx.http.get(`/reports/${one.id}`)).body.data).text).toBe(
        'Recheck failed: `pup logs aggregate` failed',
      );
      expect(recheckOf((await ctx.http.get(`/reports/${two.id}`)).body.data).text).toBe(
        'Datadog recheck, last hour: still failing',
      );
      expect(ctx.datadog.rechecks.map((r) => r.query)).toEqual([
        (await detail(ctx, first.id)).source_query,
        (await detail(ctx, second.id)).source_query,
      ]);
    });

    it('rechecks again on a retry, and adds the result as a step', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      await linkRepo(ctx, alert.service.id);
      const started = await verify(ctx, alert.id, [], [[outcome('failed', 'no fixture')]]);
      expect((await ctx.http.get(`/reports/${started.id}`)).body.data.status).toBe('failed');
      ctx.datadog.recheckCount = 0;
      for (const run of VERIFY_STEPS) ctx.daemon.sdk.script(...run);
      ctx.daemon.sdk.script(json(REPORT));
      expect((await ctx.http.post(`/reports/${started.id}/retry`)).status).toBe(202);
      await until(
        () => ctx.http.get(`/reports/${started.id}`).then((res) => res.body.data.status),
        (status) => status !== 'running',
      );
      const report = (await ctx.http.get(`/reports/${started.id}`)).body.data;
      expect(ctx.datadog.rechecks).toHaveLength(2);
      expect(
        report.steps.map((step: { text: string }) => step.text).filter((t: string) => t.startsWith('Datadog')),
      ).toEqual(['Datadog recheck, last hour: still failing', 'Datadog recheck, last hour: not seen']);
    });
  });

  describe('Deployed version', () => {
    const versionOf = (report: { steps: { kind: string; text: string }[] }) =>
      report.steps.find((step) => step.text.startsWith('prod ran') || step.text.startsWith('prod version'));

    async function verified(ctx: Ctx, version: string | null) {
      const alert = await tagged(ctx, version);
      await linkRepo(ctx, alert.service.id);
      const report = await verify(ctx, alert.id);
      return (await ctx.http.get(`/reports/${report.id}`)).body.data;
    }

    it('shows no warning when the version is the commit the scratch copy was cut at', async () => {
      const ctx = await start();
      const alert = await tagged(ctx, null);
      await linkRepo(ctx, alert.service.id);
      const sha = git(ctx.dir, 'rev-parse', 'HEAD').toString().trim();
      ctx.datadog.readings = [
        service('orders-api', [
          {
            ...route('POST', '/orders', 12),
            samples: samples(3).map((s) => ({ ...s, tags: [...s.tags, `version:${sha}`] })),
          },
        ]),
      ];
      await scan(ctx);
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(versionOf(stored)).toEqual({
        kind: 'result',
        text: `prod ran \`${sha}\`; verified at \`${sha.slice(0, 7)}\` of \`main\``,
      });
    });

    it('warns when the version is not the commit, and keeps the copy at the branch tip', async () => {
      const ctx = await start();
      const stored = await verified(ctx, 'v2.1.4');
      const sha = git(ctx.dir, 'rev-parse', 'HEAD').toString().trim().slice(0, 7);
      expect(versionOf(stored)).toEqual({
        kind: 'warning',
        text: `prod ran \`v2.1.4\`; verified at \`${sha}\` of \`main\`; the console cannot confirm they match`,
      });
      expect(stored.status).toBe('ready');
    });

    it('warns when the version only starts like the commit, and is longer than it', async () => {
      const ctx = await start();
      const alert = await tagged(ctx, null);
      await linkRepo(ctx, alert.service.id);
      const sha = git(ctx.dir, 'rev-parse', 'HEAD').toString().trim();
      const other = `${sha.slice(0, 7)}${'0'.repeat(33)}`;
      ctx.datadog.readings = [
        service('orders-api', [
          {
            ...route('POST', '/orders', 12),
            samples: samples(3).map((s) => ({ ...s, tags: [...s.tags, `version:${other}`] })),
          },
        ]),
      ];
      await scan(ctx);
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(versionOf(stored)?.kind).toBe('warning');
    });

    it('warns that the version is unknown when no Sample has the tag', async () => {
      const ctx = await start();
      const stored = await verified(ctx, null);
      const sha = git(ctx.dir, 'rev-parse', 'HEAD').toString().trim().slice(0, 7);
      expect(versionOf(stored)).toEqual({
        kind: 'warning',
        text: `prod version unknown; verified at \`${sha}\` of \`main\``,
      });
    });
  });

  describe('Prod parity', () => {
    it('asks the Verification’s closing turn for the four lines', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      await linkRepo(ctx, alert.service.id);
      const before = ctx.daemon.sdk.calls.length;
      await verify(ctx, alert.id);
      const closing =
        promptsSince(ctx, before).find((prompt) => prompt.includes('Write the Report on this Alert')) ?? '';
      expect(closing).toContain('Prod parity');
      for (const line of ['Code version', 'Data', 'Configuration and environment', 'Dependencies']) {
        expect(closing).toContain(line);
      }
    });

    it('saves a Report with no Prod parity section', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      await linkRepo(ctx, alert.service.id);
      const report = await verify(ctx, alert.id, [json({ ...REPORT, markdown: '# No parity here' })]);
      expect((await ctx.http.get(`/reports/${report.id}`)).body.data).toMatchObject({ status: 'ready' });
    });
  });
});

describe('OpenTelemetry logs', () => {
  const MINUTE = 60_000;
  const minutesAgo = (minutes: number) => Date.now() - minutes * MINUTE;
  const failure = (minutes: number, extra: Partial<OtelRecord> = {}): OtelRecord => ({
    at: minutesAgo(minutes),
    service: 'orders-api',
    resource: { 'deployment.environment.name': 'prod' },
    severity: 17,
    body: 'NullPointerException in OrderService',
    attributes: { 'http.response.status_code': 500, 'http.request.method': 'POST', 'http.route': '/orders' },
    ...extra,
  });
  const lines = (records: OtelRecord[]) => records.map((record) => otlpLine(record));

  /** Points the OpenTelemetry source at the Log folder, as the operator does in Integrations. */
  async function connectLogs(ctx: Ctx) {
    const connected = await ctx.http.post('/connectors/otel_logs/connect', { folder: ctx.logs });
    expect(connected.status).toBe(202);
  }

  /** A Scan of the OpenTelemetry source, ended. */
  async function scanLogs(ctx: Ctx, body: Record<string, unknown> = {}) {
    const started = await ctx.http.post('/scans', { service_id: null, connector: 'otel_logs', ...body });
    expect(started.status).toBe(202);
    return until(
      () => ctx.http.get(`/scans/${started.body.data.id}`).then((res) => res.body.data),
      (found) => found.status !== 'running',
      'the Scan to end',
    );
  }

  /** A Log folder holding one file of `records`, connected and scanned. */
  async function scanned(records: OtelRecord[], options: { limit?: number; body?: Record<string, unknown> } = {}) {
    const ctx = await start({ otelReadLimit: options.limit });
    await writeLogFile(ctx.logs, 'logs.jsonl', lines(records));
    await connectLogs(ctx);
    const ended = await scanLogs(ctx, options.body);
    return { ctx, ended };
  }

  const titles = (ctx: Ctx) =>
    alertList(ctx).then((list: { title: string }[]) => list.map((alert) => alert.title).sort());

  describe('the read', () => {
    it('maps a record to its Service, env, Route, status code, message, time and version', async () => {
      const { ctx, ended } = await scanned([
        failure(5, { resource: { 'deployment.environment.name': 'prod', 'service.version': '1.4.2' } }),
        // The older attribute names, and the Route taken from the path.
        failure(6, {
          service: 'billing-api',
          resource: { 'deployment.environment': 'staging' },
          attributes: { 'http.status_code': 502, 'http.method': 'get', 'url.path': '/invoices/1042?page=2' },
          body: 'upstream refused',
        }),
        // `http.route` wins over the path, and a record with no env reads as no env.
        failure(7, {
          service: 'worker',
          resource: {},
          attributes: {
            'http.response.status_code': 503,
            'http.request.method': 'PUT',
            'http.route': '/jobs/{id}',
            'url.path': '/jobs/9',
          },
          body: 'queue full',
        }),
      ]);
      expect(ended).toMatchObject({ status: 'ok', connector: 'otel_logs', notes: [] });
      const found = (await ctx.http.get('/services')).body.data.map(
        (svc: { name: string; env: string; connector: string }) => [svc.name, svc.env, svc.connector],
      );
      expect(found.sort()).toEqual([
        ['billing-api', 'staging', 'otel_logs'],
        ['orders-api', 'prod', 'otel_logs'],
        ['worker', 'no env', 'otel_logs'],
      ]);
      const list = await alertList(ctx);
      const by = (name: string) => list.find((alert: { service: { name: string } }) => alert.service.name === name);
      expect(by('orders-api')).toMatchObject({
        connector: 'otel_logs',
        http_status: 500,
        route: { method: 'POST', path: '/orders' },
        title: '500 POST /orders failing on orders-api',
        log_line: 'NullPointerException in OrderService',
        service: { repo_url: null },
      });
      expect(by('billing-api')).toMatchObject({ http_status: 502, route: { method: 'GET', path: '/invoices/:id' } });
      expect(by('worker')).toMatchObject({ http_status: 503, route: { method: 'PUT', path: '/jobs/{id}' } });
      const detail = (await ctx.http.get(`/alerts/${by('orders-api').id}`)).body.data;
      expect(JSON.parse(detail.source_query)).toEqual({
        service: 'orders-api',
        env: 'prod',
        status: 500,
        method: 'POST',
        path: '/orders',
      });
      expect(detail.samples[0]).toMatchObject({
        message: 'NullPointerException in OrderService',
        status: 'error',
        tags: expect.arrayContaining(['version:1.4.2']),
      });
      expect(Math.abs(Date.parse(detail.samples[0].timestamp) - minutesAgo(5))).toBeLessThan(MINUTE);
    });

    it('counts a record as failing by a status code of 400 or more, or by a severity number of 17 or more', async () => {
      const plain = { service: 'orders-api', resource: { 'deployment.environment.name': 'prod' }, at: minutesAgo(5) };
      const code = (status: number) => ({ 'http.response.status_code': status });
      const { ctx } = await scanned([
        // Failing by severity alone: a 200 that logged an error.
        { ...plain, severity: 17, body: 'handler threw', attributes: code(200) },
        // Failing by status alone: a 404 logged as info.
        { ...plain, severity: 9, body: 'no such cart', attributes: code(404) },
        // Failing by severity, with no request at all.
        { ...plain, severity: 21, body: 'worker crashed' },
        // Neither.
        { ...plain, severity: 9, body: 'all fine', attributes: code(200) },
        { ...plain, severity: 16, body: 'slow call' },
      ]);
      expect(await titles(ctx)).toEqual([
        'orders-api: handler threw',
        'orders-api: no such cart',
        'orders-api: worker crashed',
      ]);
    });

    it('reads only the records inside the Scan window', async () => {
      const { ctx } = await scanned([failure(30, { body: 'inside' }), failure(150, { body: 'outside' })], {
        body: { window: '1h' },
      });
      const [alert] = await alertList(ctx);
      expect(alert).toMatchObject({ event_count: 1, log_line: 'inside' });
    });

    it('reads the .json and .jsonl files in the folder, newest first, and no other file or folder', async () => {
      const ctx = await start();
      await writeLogFile(ctx.logs, 'a.json', lines([failure(5)]));
      await writeLogFile(ctx.logs, 'b.jsonl', lines([failure(6)]));
      await writeLogFile(ctx.logs, 'c.json.gz', lines([failure(5, { body: 'zipped' })]));
      await writeLogFile(ctx.logs, 'd.pb', lines([failure(5, { body: 'protobuf' })]));
      await writeLogFile(ctx.logs, 'rotated/e.jsonl', lines([failure(5, { body: 'in a subfolder' })]));
      await connectLogs(ctx);
      const ended = await scanLogs(ctx);
      expect(ended.notes).toEqual([]);
      expect(await titles(ctx)).toEqual(['500 POST /orders failing on orders-api']);
      const [alert] = await alertList(ctx);
      expect(alert.event_count).toBe(2);
    });

    it('says an empty folder has nothing to read, and finds nothing', async () => {
      const ctx = await start();
      await connectLogs(ctx);
      const ended = await scanLogs(ctx);
      expect(ended).toMatchObject({ status: 'ok', notes: ['The Log folder has no .json or .jsonl files'] });
      expect(await alertList(ctx)).toEqual([]);
    });

    it('stops at the read cap, newest files first, and says it read the newest only', async () => {
      const fresh = lines([failure(5, { body: 'in the new file' })]);
      // The cap leaves room for the newest file and a part of the next.
      const ctx = await start({ otelReadLimit: Buffer.byteLength(`${fresh.join('\n')}\n`) + 10 });
      await writeLogFile(ctx.logs, 'new.jsonl', fresh, Date.now());
      await writeLogFile(ctx.logs, 'old.jsonl', lines([failure(5, { body: 'in the old file' })]), minutesAgo(30));
      await connectLogs(ctx);
      const ended = await scanLogs(ctx);
      expect(ended.status).toBe('ok');
      expect(ended.notes).toEqual([expect.stringMatching(/^Read the newest .* only$/)]);
      const [alert] = await alertList(ctx);
      expect(alert).toMatchObject({ event_count: 1, log_line: 'in the new file' });
      expect(await alertList(ctx)).toHaveLength(1);
    });

    it('keeps the newest records of one file larger than the read cap, and says so', async () => {
      // A growing file: oldest records first. The cap holds the last two lines and a part of the one before.
      const older = lines([failure(50, { body: 'oldest' }), failure(40, { body: 'older' })]);
      const newest = lines([failure(3, { body: 'newer' }), failure(2, { body: 'newest' })]);
      const ctx = await start({ otelReadLimit: Buffer.byteLength(`${newest.join('\n')}\n`) + 20 });
      await writeLogFile(ctx.logs, 'growing.jsonl', [...older, ...newest]);
      await connectLogs(ctx);
      const ended = await scanLogs(ctx);
      expect(ended.status).toBe('ok');
      expect(ended.notes).toEqual([expect.stringMatching(/^Read the newest .* only$/)]);
      const logLines = (await alertList(ctx)).map((alert: { log_line: string }) => alert.log_line).sort();
      expect(logLines).toEqual(['newer', 'newest']);
    });

    it('skips a line that is not a log record, finishes the Scan, and says how many it skipped', async () => {
      const ctx = await start();
      await writeLogFile(ctx.logs, 'logs.jsonl', [
        otlpLine(failure(5)),
        '{"resourceLogs": "not a list"',
        '{"resourceLogs": 7}',
        'plain text, not JSON',
        otlpLine(failure(4)),
      ]);
      await connectLogs(ctx);
      const ended = await scanLogs(ctx);
      expect(ended).toMatchObject({ status: 'ok', notes: ['Skipped 3 lines that were not valid log records'] });
      expect((await alertList(ctx))[0].event_count).toBe(2);
    });

    it('keeps secret values and request body values out of the Samples', async () => {
      const { ctx } = await scanned([
        failure(5, {
          body: 'login failed password=hunter2hunter2 for u-1',
          attributes: {
            'http.response.status_code': 500,
            'http.request.method': 'POST',
            'http.route': '/login',
            'http.request.body': '{"card":"4111111111111111"}',
            'http.request.header.authorization': 'Bearer abcdefghij123456',
            'user.id': 'u-1',
          },
        }),
      ]);
      const [listed] = await alertList(ctx);
      const [sample] = (await ctx.http.get(`/alerts/${listed.id}`)).body.data.samples;
      expect(sample.message).toBe('login failed password=[redacted] for u-1');
      expect(sample.attributes).toMatchObject({
        'http.request.body': '[redacted]',
        'http.request.header.authorization': '[redacted]',
        'user.id': 'u-1',
      });
    });
  });

  describe('Alerts', () => {
    it('sets Severity from the same rules as Datadog: rapid is high, steady errors are medium, a few are low', async () => {
      const bucket = Math.floor(minutesAgo(60) / (10 * MINUTE)) * 10 * MINUTE;
      const rapid = Array.from({ length: 100 }, (_, i) =>
        failure(0, { at: bucket + i * 1000, attributes: { ...failure(0).attributes, 'http.route': '/rapid' } }),
      );
      const steady = Array.from({ length: 120 }, (_, i) =>
        failure(0, { at: minutesAgo(i + 1), attributes: { ...failure(0).attributes, 'http.route': '/steady' } }),
      );
      const few = [1, 2, 3].map((i) => failure(i, { attributes: { ...failure(0).attributes, 'http.route': '/few' } }));
      // Severity 21 and above is fatal: error level whatever the status code.
      const fatal = Array.from({ length: 120 }, (_, i) =>
        failure(0, {
          at: minutesAgo(i + 1),
          severity: 21,
          attributes: { ...failure(0).attributes, 'http.response.status_code': 401, 'http.route': '/fatal' },
        }),
      );
      const { ctx } = await scanned([...rapid, ...steady, ...few, ...fatal]);
      const severities = Object.fromEntries(
        (await alertList(ctx)).map((alert: { route: { path: string }; severity: string }) => [
          alert.route.path,
          alert.severity,
        ]),
      );
      expect(severities).toEqual({ '/rapid': 'high', '/steady': 'medium', '/few': 'low', '/fatal': 'medium' });
    });

    it('keeps one Service name and env in two sources as two Services and two Alerts', async () => {
      const ctx = await start();
      ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 4)])];
      await writeLogFile(ctx.logs, 'logs.jsonl', lines([failure(5)]));
      await connectLogs(ctx);
      const started = await ctx.http.post('/scans', { service_id: null });
      expect(started.status).toBe(202);
      await until(
        () => ctx.http.get('/scans').then((res) => res.body.data),
        (all: { status: string }[]) => all.length === 2 && all.every((one) => one.status === 'ok'),
        'both Scans',
      );
      const rows = ctx.store.db.select().from(services).all();
      expect(rows.map((row) => [row.connector, row.name, row.env]).sort()).toEqual([
        ['datadog', 'orders-api', 'prod'],
        ['otel_logs', 'orders-api', 'prod'],
      ]);
      const list = await alertList(ctx);
      expect(list.map((alert: { connector: string }) => alert.connector).sort()).toEqual(['datadog', 'otel_logs']);
      expect(new Set(list.map((alert: { fingerprint: string }) => alert.fingerprint)).size).toBe(2);
      expect(
        (await alertList(ctx, '?connector=otel_logs')).map((alert: { connector: string }) => alert.connector),
      ).toEqual(['otel_logs']);
    });

    it('does not clear the other source Alerts when one source has nothing to report', async () => {
      const ctx = await start();
      await writeLogFile(ctx.logs, 'logs.jsonl', lines([failure(5)]));
      await connectLogs(ctx);
      await scanLogs(ctx);
      ctx.datadog.readings = [];
      await scan(ctx);
      const [row] = ctx.store.db.select().from(alerts).all();
      expect(row).toMatchObject({ connector: 'otel_logs', clearedAt: null });
    });
  });

  describe('Scans of two sources', () => {
    it('reads every connected source when none is named, and one source down does not stop the other', async () => {
      const ctx = await start();
      ctx.datadog.down = 'failed';
      await writeLogFile(ctx.logs, 'logs.jsonl', lines([failure(5)]));
      await connectLogs(ctx);
      expect((await ctx.http.post('/scans', { service_id: null })).status).toBe(202);
      type Ended = { connector: string; status: string };
      const ended = await until(
        (): Promise<Ended[]> => ctx.http.get('/scans').then((res) => res.body.data),
        (all) => all.length === 2 && all.every((one) => one.status !== 'running'),
        'both Scans',
      );
      const byConnector = Object.fromEntries(ended.map((one) => [one.connector, one]));
      expect(byConnector.datadog).toMatchObject({ status: 'failed', error_code: 'upstream_failed' });
      expect(byConnector.otel_logs).toMatchObject({ status: 'ok' });
      expect(await titles(ctx)).toEqual(['500 POST /orders failing on orders-api']);
    });

    it('reads only the source it is asked for', async () => {
      const ctx = await start();
      await writeLogFile(ctx.logs, 'logs.jsonl', lines([failure(5)]));
      await connectLogs(ctx);
      await scanLogs(ctx);
      expect(ctx.datadog.calls).toHaveLength(0);
      expect((await ctx.http.get('/scans')).body.data.map((one: { connector: string }) => one.connector)).toEqual([
        'otel_logs',
      ]);
    });

    it('refuses a Scan or a Service list of a source that is not connected', async () => {
      const ctx = await start();
      const scanRefused = await ctx.http.post('/scans', { service_id: null, connector: 'otel_logs' });
      expect([scanRefused.status, scanRefused.body.error.code]).toEqual([409, 'connector_not_connected']);
      const listed = await ctx.http.get('/monitor/log-services?connector=otel_logs&window=24h');
      expect([listed.status, listed.body.error.code]).toEqual([409, 'connector_not_connected']);
    });

    it('lists the Services of the OpenTelemetry source with errors in the range', async () => {
      const ctx = await start();
      await writeLogFile(
        ctx.logs,
        'logs.jsonl',
        lines([failure(5), failure(6), failure(7, { service: 'billing-api', resource: {} })]),
      );
      await connectLogs(ctx);
      const listed = await ctx.http.get('/monitor/log-services?connector=otel_logs&window=24h');
      expect(listed.body.data).toEqual([
        { name: 'orders-api', envs: ['prod'], errors: 2 },
        { name: 'billing-api', envs: ['no env'], errors: 1 },
      ]);
      const envs = await ctx.http.get('/monitor/envs?connector=otel_logs');
      expect(envs.body.data).toEqual([
        { name: 'prod', configured: true },
        { name: 'no env', configured: false },
      ]);
    });

    it('runs each source on its own interval, and skips a source that is not connected', async () => {
      const ctx = await start();
      await writeLogFile(ctx.logs, 'logs.jsonl', lines([failure(5)]));
      await connectLogs(ctx);
      await ctx.http.patch('/connectors/otel_logs', { config: { default_interval: '12h' } });
      const monitor = ctx.daemon.app.get(ScansService);
      const scheduled = () =>
        ctx.store.db
          .select()
          .from(scans)
          .where(eq(scans.triggeredBy, ScanTrigger.Schedule))
          .all()
          .map((one) => [one.connector, one.windowSize])
          .sort();
      await monitor.runDue(new Date(2026, 9, 5, 9, 1));
      expect(scheduled()).toEqual([
        ['datadog', '24h'],
        ['otel_logs', '12h'],
      ]);
      // The Log folder now reads down: only Datadog runs.
      setConnector(ctx.store, ConnectorId.OtelLogs, { status: HealthStatus.Fail });
      await monitor.runDue(new Date(Date.now() + 2 * 86_400_000));
      expect(scheduled()).toEqual([
        ['datadog', '24h'],
        ['datadog', '24h'],
        ['otel_logs', '12h'],
      ]);
    });

    it('keeps each source Scans through retention, per Service', async () => {
      const ctx = await start();
      ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 4)])];
      await writeLogFile(ctx.logs, 'logs.jsonl', lines([failure(5)]));
      await connectLogs(ctx);
      for (let round = 0; round < 2; round++) {
        await scan(ctx);
        await scanLogs(ctx);
      }
      const long = new Date(Date.now() - 40 * 86_400_000).toISOString();
      ctx.store.write((tx) => tx.update(scans).set({ startedAt: long }).run());
      await ctx.daemon.app.get(MonitorRetention).run();
      const kept = ctx.store.db.select().from(scans).all();
      expect(kept.map((one) => one.connector).sort()).toEqual(['datadog', 'otel_logs']);
    });
  });

  describe('Recheck, Verification and Fix', () => {
    const recheckOf = (report: { steps: { kind: string; text: string }[] }) =>
      report.steps[0] as { kind: string; text: string };
    const promptsSince = (ctx: Ctx, from: number) => ctx.daemon.sdk.calls.slice(from).map((call) => call.prompt);

    /** The MCP servers the runs since `from` kept out. */
    const deniedSince = (ctx: Ctx, from: number) =>
      ctx.daemon.sdk.calls.slice(from).flatMap((call) => {
        const settings = call.options.settings as { deniedMcpServers?: { serverName: string }[] } | undefined;
        return (settings?.deniedMcpServers ?? []).map((server) => server.serverName);
      });

    async function failingLogs(ctx: Ctx, records: OtelRecord[] = [failure(5), failure(8)]) {
      await writeLogFile(ctx.logs, 'logs.jsonl', lines(records));
      await connectLogs(ctx);
      await scanLogs(ctx);
      const [alert] = await alertList(ctx);
      await linkRepo(ctx, alert.service.id);
      return alert;
    }

    it('reads the Log folder for the last hour through the Alert filter, before the agent starts', async () => {
      const ctx = await start();
      const alert = await failingLogs(ctx);
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored)).toEqual({
        kind: 'result',
        text: 'OpenTelemetry logs recheck, last hour: still failing',
      });
      expect(ctx.datadog.rechecks).toEqual([]);
      expect(stored.status).toBe('ready');
    });

    it('says not seen when the last hour of the folder holds none of them', async () => {
      const ctx = await start();
      const alert = await failingLogs(ctx, [failure(5)]);
      await writeLogFile(ctx.logs, 'logs.jsonl', lines([failure(100)]));
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored).text).toBe('OpenTelemetry logs recheck, last hour: not seen');
      expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('verified');
    });

    it('says why a Recheck could not read the folder, and goes on', async () => {
      const ctx = await start();
      const alert = await failingLogs(ctx);
      await rm(ctx.logs, { recursive: true });
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored)).toMatchObject({ kind: 'warning' });
      expect(recheckOf(stored).text).toMatch(/^Recheck failed: /);
      expect(stored.status).toBe('ready');
    });

    it('briefs the agent with the source, the Samples and the filter, and tells it to use no pup and no Datadog server', async () => {
      const ctx = await start();
      const alert = await failingLogs(ctx, [
        failure(5, { resource: { 'deployment.environment.name': 'prod', 'service.version': '1.4.2' } }),
      ]);
      const before = ctx.daemon.sdk.calls.length;
      const report = await verify(ctx, alert.id);
      const brief = promptsSince(ctx, before).find((prompt) => prompt.includes('Find the cause of a failure')) ?? '';
      expect(brief).toContain('OpenTelemetry logs');
      expect(brief).toContain('NullPointerException in OrderService');
      expect(brief).toContain('"service":"orders-api"');
      expect(brief).toMatch(/no `pup` and no Datadog MCP Server/);
      expect(brief).toMatch(/needed more logs than/);
      expect(brief).not.toContain('Datadog query');
      expect(brief).not.toContain('failure Datadog logged');
      // The Datadog server stays out of the run.
      expect(deniedSince(ctx, before)).toContain('datadog-pup');
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      // Prod parity still reads the version tag.
      expect(stored.steps.map((step: { text: string }) => step.text)).toContainEqual(
        expect.stringContaining('prod ran `1.4.2`'),
      );
    });

    it('starts a Fix of an OpenTelemetry Alert with a Recheck of the folder and the same rule on its tools', async () => {
      const ctx = await start();
      const alert = await failingLogs(ctx);
      await verify(ctx, alert.id);
      const before = ctx.daemon.sdk.calls.length;
      for (const run of stepTurns(PlaybookTrigger.Fix)) ctx.daemon.sdk.script(...run);
      ctx.daemon.sdk.script(json({ description: 'Defaults the order total.' }));
      const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
      await until(
        () => ctx.http.get(`/fixes/${confirm.body.data.fix.id}`).then((res) => res.body.data.status),
        (status) => status !== 'running',
        'the Fix to end',
      );
      const prompts = promptsSince(ctx, before);
      expect(prompts[0]).toContain('OpenTelemetry logs recheck, last hour: still failing');
      expect(prompts[0]).toMatch(/no `pup` and no Datadog MCP Server/);
      expect(deniedSince(ctx, before)).toContain('datadog-pup');
    });

    it('keeps the Datadog brief, and heads the evidence section Log evidence for both sources', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      await linkRepo(ctx, alert.service.id);
      const before = ctx.daemon.sdk.calls.length;
      await verify(ctx, alert.id);
      const prompts = promptsSince(ctx, before);
      const brief = prompts.find((prompt) => prompt.includes('Find the cause of a failure')) ?? '';
      expect(brief).toContain('Datadog query: ');
      expect(brief).not.toContain('OpenTelemetry');
      expect(brief).not.toMatch(/no `pup`/);
      expect(deniedSince(ctx, before)).not.toContain('datadog-pup');
      const closing = prompts.find((prompt) => prompt.includes('Write the Report on this Alert')) ?? '';
      expect(closing).toContain('Log evidence (log lines');
      expect(closing).not.toContain('Datadog evidence');
    });
  });

  describe('migration', () => {
    it('keeps every existing Service, Route, Alert, Scan and event, reads them as Datadog, and reopens no Alert', async () => {
      const dataDir = await tempDir();
      const older = await tempDir('ops-console-migrations-');
      await cp(MIGRATIONS_DIR, older, { recursive: true });
      const journalFile = path.join(older, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalFile, 'utf8'));
      // The database as it was before the OpenTelemetry source: its migration is left out.
      const cut = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0042_log_source_connector');
      journal.entries = journal.entries.slice(0, cut);
      await writeFile(journalFile, JSON.stringify(journal));
      const before = await startTestDaemon({ dataDir, migrationsDir: older });
      await before.stop();

      const print = fingerprint('svc-1', 'POST', '/orders', 'NullPointerException in OrderService', 500);
      const sqlite = new Database(path.join(dataDir, 'state.db'));
      sqlite.exec(`
        INSERT INTO services (id, name, env) VALUES ('svc-1', 'orders-api', 'prod');
        INSERT INTO routes (id, service_id, method, path) VALUES ('route-1', 'svc-1', 'POST', '/orders');
        INSERT INTO scans (id, triggered_by, window_size, status) VALUES ('scan-1', 'schedule', '24h', 'ok');
        INSERT INTO scan_route_results (scan_id, route_id, scanned_at, error_count, state)
          VALUES ('scan-1', 'route-1', '2026-10-01T00:00:00.000Z', 4, 'failing');
        INSERT INTO alerts (id, route_id, fingerprint, http_status, severity, status, title, log_line, event_count,
                            first_seen_at, last_seen_at, datadog_query)
          VALUES ('alert-1', 'route-1', '${print}', 500, 'medium', 'open', 'old title', 'old line', 4,
                  '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'env:prod service:orders-api');
        INSERT INTO alert_events (id, alert_id, kind, actor) VALUES ('event-1', 'alert-1', 'detected', 'scan');
      `);
      sqlite.close();

      const ctx = await start({ dataDir });
      const db = new Database(path.join(dataDir, 'state.db'));
      expect(db.prepare('SELECT connector, name, env FROM services').all()).toEqual([
        { connector: 'datadog', name: 'orders-api', env: 'prod' },
      ]);
      expect(db.prepare('SELECT connector FROM scans').all()).toEqual([{ connector: 'datadog' }]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM routes').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM scan_route_results').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM alert_events').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT connector, source_query, status, severity FROM alerts').all()).toEqual([
        { connector: 'datadog', source_query: 'env:prod service:orders-api', status: 'open', severity: 'medium' },
      ]);
      db.close();

      // The same failure seen again is the same Alert: nothing reopens and nothing is duplicated.
      ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 6)])];
      await scan(ctx);
      const list = await alertList(ctx);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: 'alert-1', connector: 'datadog', status: 'open', event_count: 10 });
    });
  });
});

describe('CloudWatch logs', () => {
  const MINUTE = 60_000;
  const minutesAgo = (minutes: number) => Date.now() - minutes * MINUTE;
  const SHOP = { name: '/ecs/shop-api', service: 'shop-api', env: 'prod' };
  const LINE = {
    status: 500,
    method: 'POST',
    path: '/orders',
    level: 'error',
    message: 'NullPointerException in OrderService',
  };
  /** One failing JSON line, `minutes` ago; `extra` replaces its fields. */
  const failure = (minutes: number, extra: Record<string, unknown> = {}) => ({
    at: minutesAgo(minutes),
    message: { ...LINE, ...extra },
  });

  /** Points the CloudWatch source at `groups`, as a Connector the operator connected. */
  function connectCloudWatch(ctx: Ctx, groups = [SHOP]) {
    setConnector(ctx.store, ConnectorId.CloudWatchLogs, {
      status: HealthStatus.Ok,
      config: JSON.stringify({
        ...DEFAULT_CONNECTOR_CONFIG[ConnectorId.CloudWatchLogs],
        profile: 'ops',
        region: 'us-east-1',
        log_groups: groups,
      }),
    });
  }

  async function scanCloudWatch(ctx: Ctx, body: Record<string, unknown> = {}) {
    const started = await ctx.http.post('/scans', { service_id: null, connector: 'cloudwatch_logs', ...body });
    expect(started.status).toBe(202);
    return until(
      () => ctx.http.get(`/scans/${started.body.data.id}`).then((res) => res.body.data),
      (found) => found.status !== 'running',
      'the Scan to end',
    );
  }

  /** A CloudWatch source holding `events` in the log group, connected and scanned. */
  async function scanned(
    events: { at: number; message: string | object }[],
    options: { cloudWatch?: CloudWatchOptions; body?: Record<string, unknown> } = {},
  ) {
    const aws = await FakeAws.create();
    aws.group(SHOP.name, events);
    const ctx = await start({ cloudWatch: options.cloudWatch });
    connectCloudWatch(ctx);
    const ended = await scanCloudWatch(ctx, options.body);
    return { ctx, aws, ended };
  }

  const titles = (ctx: Ctx) =>
    alertList(ctx).then((list: { title: string }[]) => list.map((alert) => alert.title).sort());

  describe('the read', () => {
    it('turns a failing log group into a Service, an Alert with Samples, and a filter that finds it again', async () => {
      const { ctx, aws, ended } = await scanned([failure(5), failure(8), failure(9, { status: 200, level: 'info' })]);
      expect(ended).toMatchObject({ status: 'ok', connector: 'cloudwatch_logs' });
      expect((await ctx.http.get('/services')).body.data).toMatchObject([
        { name: 'shop-api', env: 'prod', connector: 'cloudwatch_logs' },
      ]);
      const [listed] = await alertList(ctx);
      expect(listed).toMatchObject({
        connector: 'cloudwatch_logs',
        http_status: 500,
        route: { method: 'POST', path: '/orders' },
        title: '500 POST /orders failing on shop-api',
        event_count: 2,
        log_line: 'NullPointerException in OrderService',
      });
      const detail = (await ctx.http.get(`/alerts/${listed.id}`)).body.data;
      expect(JSON.parse(detail.source_query)).toEqual({
        log_group: '/ecs/shop-api',
        status: 500,
        method: 'POST',
        path: '/orders',
      });
      expect(detail.samples).toHaveLength(2);
      expect(detail.samples[0]).toMatchObject({
        status: 'error',
        message: 'NullPointerException in OrderService',
        tags: expect.arrayContaining(['service:shop-api', 'env:prod']),
      });
      expect(Math.abs(Date.parse(detail.samples[0].timestamp) - minutesAgo(5))).toBeLessThan(MINUTE);
      // The daemon calls the CLI as the profile, in the Connector's region.
      expect(aws.calls().every((call) => call.profile === 'ops' && call.region === 'us-east-1')).toBe(true);
    });

    it('takes each field from the first of its names present', async () => {
      const route = (fields: Record<string, unknown>) => ({
        status: undefined,
        method: undefined,
        path: undefined,
        level: undefined,
        message: undefined,
        ...fields,
      });
      const { ctx } = await scanned([
        failure(
          5,
          route({ statusCode: 502, httpMethod: 'get', resourcePath: '/a', severity: 'error', msg: 'by camel case' }),
        ),
        failure(
          6,
          route({ status_code: 503, method: 'PUT', route: '/b', log_level: 'ERROR', message: 'by snake case' }),
        ),
        failure(
          7,
          route({ http: { status_code: 504, method: 'delete' }, url: { path: '/c' }, msg: 'by dotted names' }),
        ),
        // The first name present wins: `status` is 200, so `statusCode` is not read and level makes it fail.
        failure(
          8,
          route({ status: 200, statusCode: 500, path: '/d', method: 'GET', level: 'fatal', message: 'first wins' }),
        ),
      ]);
      const list: { http_status: number | null; route: { method: string; path: string } | null; log_line: string }[] =
        await alertList(ctx);
      const found = Object.fromEntries(list.map((a) => [a.log_line, [a.http_status, a.route?.method, a.route?.path]]));
      expect(found).toEqual({
        'by camel case': [502, 'GET', '/a'],
        'by snake case': [503, 'PUT', '/b'],
        'by dotted names': [504, 'DELETE', '/c'],
        'first wins': [200, 'GET', '/d'],
      });
    });

    it('counts an event as failing by a status code of 400 or more or by an error level in any case, and not a plain-text line', async () => {
      const bare = { status: undefined, method: undefined, path: undefined };
      const { ctx } = await scanned([
        failure(5, { ...bare, status: 404, level: 'info', message: 'no such cart' }),
        failure(5, { ...bare, level: 'ERROR', message: 'level error' }),
        failure(5, { ...bare, level: 'Critical', message: 'level critical' }),
        failure(5, { ...bare, level: 'alert', message: 'level alert' }),
        failure(5, { ...bare, level: 'EMERGENCY', message: 'level emergency' }),
        failure(5, { ...bare, level: 'fatal', message: 'level fatal' }),
        failure(5, { ...bare, status: 200, level: 'info', message: 'all fine' }),
        failure(5, { ...bare, level: 'warn', message: 'slow call' }),
        { at: minutesAgo(5), message: 'ERROR plain text, not JSON' },
      ]);
      expect((await titles(ctx)).map((title) => title.replace('shop-api: ', '')).sort()).toEqual([
        'level alert',
        'level critical',
        'level emergency',
        'level error',
        'level fatal',
        'no such cart',
      ]);
    });

    it('reads only the events inside the Scan window', async () => {
      const { ctx } = await scanned([failure(30, { message: 'inside' }), failure(150, { message: 'outside' })], {
        body: { window: '1h' },
      });
      const [alert] = await alertList(ctx);
      expect(alert).toMatchObject({ event_count: 1, log_line: 'inside' });
    });

    it('keeps secret values and request body values out of the Samples', async () => {
      const { ctx } = await scanned([
        failure(5, {
          message: 'login failed password=hunter2hunter2 for u-1',
          path: '/login',
          body: '{"card":"4111111111111111"}',
          headers: { authorization: 'Bearer abcdefghij123456' },
          user: 'u-1',
        }),
      ]);
      const [listed] = await alertList(ctx);
      const [sample] = (await ctx.http.get(`/alerts/${listed.id}`)).body.data.samples;
      expect(sample.message).toBe('login failed password=[redacted] for u-1');
      expect(sample.attributes).toMatchObject({
        body: '[redacted]',
        headers: { authorization: '[redacted]' },
        user: 'u-1',
      });
    });

    it('reports the bytes Logs Insights scanned in the Scan notes', async () => {
      const aws = await FakeAws.create();
      aws.group(SHOP.name, [failure(5)]).scans(2_621_440);
      const ctx = await start();
      connectCloudWatch(ctx);
      const ended = await scanCloudWatch(ctx);
      // Two queries of 2.5 MB each.
      expect(ended.notes).toEqual(['Logs Insights scanned 5.0 MB']);
    });

    it('stops at 10,000 failing events per log group and says so', async () => {
      const many = Array.from({ length: 10_050 }, (_, index) => ({
        at: Date.now() - 60_000 - index * 10,
        message: { ...LINE, message: 'NullPointerException in OrderService' },
      }));
      const { ctx, ended } = await scanned(many);
      expect(ended.status).toBe('ok');
      expect(ended.notes).toContain('/ecs/shop-api: read the newest 10,000 failing events only');
      const [alert] = await alertList(ctx);
      // The counts come from the aggregate query, which the cap does not touch.
      expect(alert.event_count).toBe(10_050);
      const detail = (await ctx.http.get(`/alerts/${alert.id}`)).body.data;
      expect(detail.samples).toHaveLength(25);
    });

    it('says the counts were cut off when the aggregate query returns 10,000 rows', async () => {
      const distinct = Array.from({ length: 10_050 }, (_, index) => ({
        at: Date.now() - 60_000 - index * 10,
        message: { ...LINE, message: `failure ${String.fromCharCode(97 + (index % 26))}${index} in OrderService` },
      }));
      const { ended } = await scanned(distinct);
      expect(ended.notes).toContain('/ecs/shop-api: counts cut off at 10,000 rows');
    });

    it('counts a failing event that names no status, method or route, past the cap on the events read', async () => {
      const bare = { status: undefined, method: undefined, path: undefined };
      const levelOnly = Array.from({ length: 10_050 }, (_, index) => ({
        at: Date.now() - 60_000 - index * 10,
        message: { ...LINE, ...bare, message: 'payments client timed out' },
      }));
      const { ctx } = await scanned(levelOnly);
      const [alert] = await alertList(ctx);
      expect(alert).toMatchObject({ http_status: null, route: null, event_count: 10_050 });
    });

    it('passes a log group name that starts with a dash as one argument, so the CLI does not read it as an option', async () => {
      const aws = await FakeAws.create();
      aws.group('-x', [failure(5)]);
      const ctx = await start();
      connectCloudWatch(ctx, [{ name: '-x', service: 'dashed', env: 'prod' }]);
      expect(await scanCloudWatch(ctx)).toMatchObject({ status: 'ok' });
      expect(await alertList(ctx)).toHaveLength(1);
    });
  });
  describe('Alerts', () => {
    it('sets Severity from the same rules as the other sources, from the counts Logs Insights gives', async () => {
      const bucket = Math.floor(minutesAgo(60) / (10 * MINUTE)) * 10 * MINUTE;
      const rapid = Array.from(
        { length: 100 },
        (_, i) => failure(0, { path: '/rapid' }) && { at: bucket + i * 1000, message: { ...LINE, path: '/rapid' } },
      );
      const steady = Array.from({ length: 120 }, (_, i) => ({
        at: minutesAgo(i + 1),
        message: { ...LINE, path: '/steady' },
      }));
      const few = [1, 2, 3].map((i) => failure(i, { path: '/few' }));
      // Fatal is error level whatever the status code.
      const fatal = Array.from({ length: 120 }, (_, i) => ({
        at: minutesAgo(i + 1),
        message: { ...LINE, status: 401, level: 'fatal', path: '/fatal' },
      }));
      const { ctx } = await scanned([...rapid, ...steady, ...few, ...fatal]);
      const severities = Object.fromEntries(
        (await alertList(ctx)).map((alert: { route: { path: string }; severity: string }) => [
          alert.route.path,
          alert.severity,
        ]),
      );
      expect(severities).toEqual({ '/rapid': 'high', '/steady': 'medium', '/few': 'low', '/fatal': 'medium' });
    });

    it('puts the source in the Fingerprint, and leaves the other sources Fingerprints alone', async () => {
      const ctx = await start();
      const aws = await FakeAws.create();
      aws.group(SHOP.name, [failure(5)]);
      ctx.datadog.readings = [service('shop-api', [route('POST', '/orders', 4)])];
      connectCloudWatch(ctx);
      await scan(ctx);
      await scanCloudWatch(ctx);
      const rows = ctx.store.db.select().from(alerts).all();
      const byConnector = Object.fromEntries(rows.map((row) => [row.connector, row.fingerprint]));
      const rowOf = (connector: LogSource) =>
        ctx.store.db.select().from(services).where(eq(services.connector, connector)).get();
      expect(byConnector.cloudwatch_logs).toBe(
        fingerprint(
          rowOf(ConnectorId.CloudWatchLogs)?.id as string,
          'POST',
          '/orders',
          'NullPointerException in OrderService',
          500,
          ConnectorId.CloudWatchLogs,
        ),
      );
      expect(byConnector.datadog).toBe(
        fingerprint(
          rowOf(ConnectorId.Datadog)?.id as string,
          'POST',
          '/orders',
          'NullPointerException in OrderService',
          500,
        ),
      );
      expect(Object.keys(byConnector).sort()).toEqual(['cloudwatch_logs', 'datadog']);
    });

    it('keeps one Service name and env in two sources as two Services', async () => {
      const ctx = await start();
      const aws = await FakeAws.create();
      aws.group(SHOP.name, [failure(5)]);
      ctx.datadog.readings = [service('shop-api', [route('POST', '/orders', 4)])];
      connectCloudWatch(ctx);
      expect((await ctx.http.post('/scans', { service_id: null })).status).toBe(202);
      await until(
        () => ctx.http.get('/scans').then((res) => res.body.data),
        (all: { status: string }[]) => all.length === 2 && all.every((one) => one.status === 'ok'),
        'both Scans',
      );
      const rows = ctx.store.db.select().from(services).all();
      expect(rows.map((row) => [row.connector, row.name, row.env]).sort()).toEqual([
        ['cloudwatch_logs', 'shop-api', 'prod'],
        ['datadog', 'shop-api', 'prod'],
      ]);
      expect(
        (await alertList(ctx, '?connector=cloudwatch_logs')).map((alert: { connector: string }) => alert.connector),
      ).toEqual(['cloudwatch_logs']);
    });
  });

  describe('failures', () => {
    const outcome = async (behavior: 'throttle' | 'signed_out' | 'unreachable') => {
      const aws = await FakeAws.create();
      aws.group(SHOP.name, [failure(5)]).behave(behavior);
      const ctx = await start();
      connectCloudWatch(ctx);
      return scanCloudWatch(ctx);
    };

    it('ends a throttled read rate limited', async () => {
      expect(await outcome('throttle')).toMatchObject({ status: 'rate_limited', error_code: 'rate_limited' });
    });

    it('ends a signed-out profile and an unreachable AWS upstream failed, naming the cause', async () => {
      expect(await outcome('signed_out')).toMatchObject({
        status: 'failed',
        error_code: 'upstream_failed',
        error_message: 'AWS profile ops is signed out',
      });
      expect(await outcome('unreachable')).toMatchObject({ status: 'failed', error_code: 'upstream_failed' });
    });

    it('ends a missing log group upstream failed, naming it', async () => {
      await FakeAws.create();
      const ctx = await start();
      connectCloudWatch(ctx);
      expect(await scanCloudWatch(ctx)).toMatchObject({
        status: 'failed',
        error_code: 'upstream_failed',
        error_message: 'Log group /ecs/shop-api was not found',
      });
    });

    it('stops a query that has not finished in time, leaves the group unread and still ends the Scan ok', async () => {
      const aws = await FakeAws.create();
      aws.group(SHOP.name, [failure(5)]).behave('hang');
      const ctx = await start({ cloudWatch: { timeoutMs: 100 } });
      connectCloudWatch(ctx);
      const ended = await scanCloudWatch(ctx);
      expect(ended).toMatchObject({
        status: 'ok',
        notes: ['/ecs/shop-api not read: its query did not finish in 5 minutes and was stopped'],
      });
      expect(aws.commands().filter((command) => command === 'stop-query')).toHaveLength(2);
      expect(await alertList(ctx)).toEqual([]);
    });

    it('stops the other query of a log group when one of them fails, before the Scan ends', async () => {
      const aws = await FakeAws.create();
      aws
        .group(SHOP.name, [failure(5)])
        .behaveOn('events', 'fail')
        .behaveOn('counts', 'hang');
      const ctx = await start({ cloudWatch: { timeoutMs: 5_000 } });
      connectCloudWatch(ctx);
      const ended = await scanCloudWatch(ctx);
      expect(ended).toMatchObject({ status: 'failed', error_code: 'upstream_failed' });
      const stopped = aws.calls().filter((call) => call.args[1] === 'stop-query');
      expect(new Set(stopped.map((call) => call.args.join(' '))).size).toBe(2);
    });

    it('reports the bytes the finished query scanned when its sibling times out', async () => {
      const aws = await FakeAws.create();
      aws
        .group(SHOP.name, [failure(5)])
        .behaveOn('events', 'hang')
        .scans(2_621_440);
      const ctx = await start({ cloudWatch: { timeoutMs: 1_500 } });
      connectCloudWatch(ctx);
      const ended = await scanCloudWatch(ctx);
      expect(ended).toMatchObject({
        status: 'ok',
        notes: [
          '/ecs/shop-api not read: its query did not finish in 5 minutes and was stopped',
          'Logs Insights scanned 2.5 MB',
        ],
      });
    });

    it('stops a query whose start was still in flight when the operator stopped the Scan, once it has an id', async () => {
      const aws = await FakeAws.create();
      aws.group(SHOP.name, [failure(5)]).startsAfter(800);
      const ctx = await start();
      connectCloudWatch(ctx);
      const started = await ctx.http.post('/scans', { service_id: null, connector: 'cloudwatch_logs' });
      await until(
        () => aws.commands().filter((command) => command === 'start-query').length,
        (asked) => asked >= 2,
        'both queries to be starting',
      );
      expect((await ctx.http.post(`/scans/${started.body.data.id}/cancel`)).status).toBe(204);
      await until(
        () => aws.commands().filter((command) => command === 'stop-query').length,
        (stopped) => stopped === 2,
        'both queries to be stopped',
      );
    });

    it('stops the running queries when the operator stops the Scan', async () => {
      const aws = await FakeAws.create();
      aws.group(SHOP.name, [failure(5)]).behave('hang');
      const ctx = await start({ cloudWatch: { timeoutMs: 60_000 } });
      connectCloudWatch(ctx);
      const started = await ctx.http.post('/scans', { service_id: null, connector: 'cloudwatch_logs' });
      await until(
        () => aws.commands().filter((command) => command === 'get-query-results').length,
        (asked) => asked >= 2,
        'both queries to be running',
      );
      expect((await ctx.http.post(`/scans/${started.body.data.id}/cancel`)).status).toBe(204);
      const ended = await until(
        () => ctx.http.get(`/scans/${started.body.data.id}`).then((res) => res.body.data),
        (found) => found.status !== 'running',
        'the Scan to end',
      );
      expect(ended.status).toBe('cancelled');
      await until(
        () => aws.commands().filter((command) => command === 'stop-query').length,
        (stopped) => stopped === 2,
        'both queries to be stopped',
      );
    });

    it('does not stop another source Scan when CloudWatch is down, and shows the others Alerts', async () => {
      const ctx = await start();
      const aws = await FakeAws.create();
      aws.group(SHOP.name, [failure(5)]).behave('signed_out');
      ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 4)])];
      connectCloudWatch(ctx);
      expect((await ctx.http.post('/scans', { service_id: null })).status).toBe(202);
      const all = await until(
        () => ctx.http.get('/scans').then((res) => res.body.data),
        (found: { connector: string; status: string }[]) =>
          found.length === 2 && found.every((one) => one.status !== 'running'),
        'both Scans',
      );
      expect(all.map((one: { connector: string; status: string }) => [one.connector, one.status]).sort()).toEqual([
        ['cloudwatch_logs', 'failed'],
        ['datadog', 'ok'],
      ]);
      expect((await alertList(ctx)).map((alert: { connector: string }) => alert.connector)).toEqual(['datadog']);
    });
  });

  it('links an imported Repo with the log group Service name, as any Service is', async () => {
    const aws = await FakeAws.create();
    aws.group(SHOP.name, [failure(5)]);
    const ctx = await start();
    const repo = (await ctx.http.post('/repos', { path: await makeRepo() })).body.data;
    connectCloudWatch(ctx, [{ ...SHOP, service: 'orders-api' }]);
    await scanCloudWatch(ctx);
    const linked = await until(
      () => ctx.http.get('/services').then((res) => res.body.data[0]),
      (found) => found.repo_id !== null,
      'the Repo to be linked',
    );
    expect(linked).toMatchObject({ connector: 'cloudwatch_logs', repo_id: repo.id });
  });

  describe('Services and the schedule', () => {
    it('lists the picked groups as Services and envs, with their failing counts and status codes', async () => {
      const aws = await FakeAws.create();
      aws.group(SHOP.name, [failure(5), failure(6), failure(7, { status: 404 })]);
      aws.group('/ecs/billing-api', [failure(5, { status: 502 })]);
      const ctx = await start();
      connectCloudWatch(ctx, [SHOP, { name: '/ecs/billing-api', service: 'billing-api', env: 'staging' }]);
      expect((await ctx.http.get('/monitor/envs?connector=cloudwatch_logs')).body.data).toEqual([
        { name: 'prod', configured: true },
        { name: 'staging', configured: false },
        { name: 'no env', configured: false },
      ]);
      expect((await ctx.http.get('/monitor/log-services?connector=cloudwatch_logs&window=24h')).body.data).toEqual([
        { name: 'shop-api', envs: ['prod'], errors: 3 },
        { name: 'billing-api', envs: ['staging'], errors: 1 },
      ]);
      expect((await ctx.http.get('/monitor/status-codes?connector=cloudwatch_logs&window=24h')).body.data).toEqual([
        { code: 500, count: 2 },
        { code: 404, count: 1 },
        { code: 502, count: 1 },
      ]);
    });

    it('runs on its own interval, and skips the source when it is not connected', async () => {
      const aws = await FakeAws.create();
      aws.group(SHOP.name, [failure(5)]);
      const ctx = await start();
      connectCloudWatch(ctx);
      await ctx.http.patch('/connectors/cloudwatch_logs', { config: { default_interval: '12h' } });
      const monitor = ctx.daemon.app.get(ScansService);
      const scheduled = () =>
        ctx.store.db
          .select()
          .from(scans)
          .where(eq(scans.triggeredBy, ScanTrigger.Schedule))
          .all()
          .map((one) => [one.connector, one.windowSize])
          .sort();
      await monitor.runDue(new Date(2026, 9, 5, 9, 1));
      expect(scheduled()).toEqual([
        ['cloudwatch_logs', '12h'],
        ['datadog', '24h'],
      ]);
      setConnector(ctx.store, ConnectorId.CloudWatchLogs, { status: HealthStatus.Fail });
      await monitor.runDue(new Date(Date.now() + 2 * 86_400_000));
      expect(scheduled().filter(([connector]) => connector === 'cloudwatch_logs')).toHaveLength(1);
    });

    it('keeps each source Scans through retention, per Service', async () => {
      const aws = await FakeAws.create();
      aws.group(SHOP.name, [failure(5)]);
      const ctx = await start();
      ctx.datadog.readings = [service('shop-api', [route('POST', '/orders', 4)])];
      connectCloudWatch(ctx);
      for (let round = 0; round < 2; round++) {
        await scan(ctx);
        await scanCloudWatch(ctx);
      }
      const long = new Date(Date.now() - 40 * 86_400_000).toISOString();
      ctx.store.write((tx) => tx.update(scans).set({ startedAt: long }).run());
      await ctx.daemon.app.get(MonitorRetention).run();
      expect(
        ctx.store.db
          .select()
          .from(scans)
          .all()
          .map((one) => one.connector)
          .sort(),
      ).toEqual(['cloudwatch_logs', 'datadog']);
    });
  });
  describe('Recheck, Verification and Fix', () => {
    const recheckOf = (report: { steps: { kind: string; text: string }[] }) =>
      report.steps[0] as { kind: string; text: string };
    const promptsSince = (ctx: Ctx, from: number) => ctx.daemon.sdk.calls.slice(from).map((call) => call.prompt);
    const deniedSince = (ctx: Ctx, from: number) =>
      ctx.daemon.sdk.calls.slice(from).flatMap((call) => {
        const settings = call.options.settings as { deniedMcpServers?: { serverName: string }[] } | undefined;
        return (settings?.deniedMcpServers ?? []).map((server) => server.serverName);
      });

    async function failingGroup(events = [failure(5), failure(8)]) {
      const aws = await FakeAws.create();
      aws.group(SHOP.name, events);
      const ctx = await start();
      connectCloudWatch(ctx);
      await scanCloudWatch(ctx);
      const [alert] = await alertList(ctx);
      await linkRepo(ctx, alert.service.id);
      return { ctx, aws, alert };
    }

    it('reads the Alert log group for the last hour through its filter, before the agent starts', async () => {
      const { ctx, aws, alert } = await failingGroup();
      aws.group(SHOP.name, [failure(5), failure(8), failure(5, { path: '/other' })]);
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored)).toEqual({ kind: 'result', text: 'CloudWatch logs recheck, last hour: still failing' });
      expect(ctx.datadog.rechecks).toEqual([]);
      expect(stored.status).toBe('ready');
    });

    it('says not seen when the last hour holds none of them, and only the Alert Route counts', async () => {
      const { ctx, aws, alert } = await failingGroup();
      // Failing an hour and a half ago, and failing now on another Route.
      aws.group(SHOP.name, [failure(90), failure(5, { path: '/other' }), failure(5, { status: 502 })]);
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored).text).toBe('CloudWatch logs recheck, last hour: not seen');
      expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('verified');
    });

    it('says why a Recheck could not read, and goes on', async () => {
      const { ctx, aws, alert } = await failingGroup();
      aws.behave('signed_out');
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored)).toEqual({ kind: 'warning', text: 'Recheck failed: AWS profile ops is signed out' });
      expect(stored.status).toBe('ready');
    });

    it('briefs the agent with the source, the Samples and the filter, and names the log tools and no pup', async () => {
      const { ctx, alert } = await failingGroup();
      const before = ctx.daemon.sdk.calls.length;
      await verify(ctx, alert.id);
      const brief = promptsSince(ctx, before).find((prompt) => prompt.includes('Find the cause of a failure')) ?? '';
      expect(brief).toContain('CloudWatch logs');
      expect(brief).toContain('NullPointerException in OrderService');
      expect(brief).toContain('"log_group":"/ecs/shop-api"');
      expect(brief).toMatch(/no `pup` and no Datadog MCP Server/);
      expect(brief).toMatch(/CloudWatch log tools/);
      expect(brief).not.toContain('Datadog query');
      expect(brief).not.toContain('failure Datadog logged');
      // The Datadog server stays out, and the CloudWatch one starts.
      expect(deniedSince(ctx, before)).toContain('datadog-pup');
      expect(deniedSince(ctx, before)).not.toContain('cloudwatch');
    });

    it('starts a Fix of a CloudWatch Alert with a Recheck and without the CloudWatch server', async () => {
      const { ctx, alert } = await failingGroup();
      await verify(ctx, alert.id);
      const before = ctx.daemon.sdk.calls.length;
      for (const run of stepTurns(PlaybookTrigger.Fix)) ctx.daemon.sdk.script(...run);
      ctx.daemon.sdk.script(json({ description: 'Defaults the order total.' }));
      const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
      await until(
        () => ctx.http.get(`/fixes/${confirm.body.data.fix.id}`).then((res) => res.body.data.status),
        (status) => status !== 'running',
        'the Fix to end',
      );
      const prompts = promptsSince(ctx, before);
      expect(prompts[0]).toContain('CloudWatch logs recheck, last hour: still failing');
      expect(prompts[0]).toMatch(/no `pup` and no Datadog MCP Server/);
      expect(deniedSince(ctx, before)).toEqual(expect.arrayContaining(['datadog-pup', 'cloudwatch']));
    });

    it('keeps the CloudWatch server out of a Datadog Verification', async () => {
      const ctx = await start();
      const alert = await failing(ctx);
      await linkRepo(ctx, alert.service.id);
      const before = ctx.daemon.sdk.calls.length;
      await verify(ctx, alert.id);
      expect(deniedSince(ctx, before)).toContain('cloudwatch');
      expect(deniedSince(ctx, before)).not.toContain('datadog-pup');
    });
  });
});

describe('Loki logs', () => {
  const MINUTE = 60_000;
  const minutesAgo = (minutes: number) => Date.now() - minutes * MINUTE;
  const SHOP = { service_name: 'shop-api', deployment_environment_name: 'prod' };
  const LINE = {
    status: 500,
    method: 'POST',
    path: '/orders',
    level: 'error',
    message: 'NullPointerException in OrderService',
  };
  const failure = (minutes: number, extra: Record<string, unknown> = {}) => ({
    at: minutesAgo(minutes),
    line: { ...LINE, ...extra },
  });

  /** Points the Loki source at the fake, as a Connector the operator connected. */
  function connectLoki(ctx: Ctx, config: Record<string, unknown> = {}) {
    setConnector(ctx.store, ConnectorId.LokiLogs, {
      status: HealthStatus.Ok,
      config: JSON.stringify({
        ...DEFAULT_CONNECTOR_CONFIG[ConnectorId.LokiLogs],
        url: 'https://loki.example.com',
        ...config,
      }),
    });
  }

  async function scanLoki(ctx: Ctx, body: Record<string, unknown> = {}) {
    const started = await ctx.http.post('/scans', { service_id: null, connector: 'loki_logs', ...body });
    expect(started.status).toBe(202);
    return until(
      () => ctx.http.get(`/scans/${started.body.data.id}`).then((res) => res.body.data),
      (found) => found.status !== 'running',
      'the Scan to end',
    );
  }

  /** A Loki holding `entries` in one stream, connected and scanned. */
  async function scanned(
    entries: { at: number; line: string | object }[],
    options: { labels?: Record<string, string>; config?: Record<string, unknown>; body?: Record<string, unknown> } = {},
  ) {
    const logcli = await FakeLogcli.create();
    logcli.stream(options.labels ?? SHOP, entries);
    const ctx = await start({ loki: { bin: logcli.bin } });
    connectLoki(ctx, options.config);
    const ended = await scanLoki(ctx, options.body);
    return { ctx, logcli, ended };
  }

  describe('the read', () => {
    it('turns a failing stream into a Service, an Alert with Samples, and a filter that finds it again', async () => {
      const { ctx, ended } = await scanned([failure(5), failure(8), failure(9, { status: 200, level: 'info' })]);
      expect(ended).toMatchObject({ status: 'ok', connector: 'loki_logs' });
      expect((await ctx.http.get('/services')).body.data).toMatchObject([
        { name: 'shop-api', env: 'prod', connector: 'loki_logs' },
      ]);
      const [listed] = await alertList(ctx);
      expect(listed).toMatchObject({
        connector: 'loki_logs',
        http_status: 500,
        route: { method: 'POST', path: '/orders' },
        title: '500 POST /orders failing on shop-api',
        event_count: 2,
        log_line: 'NullPointerException in OrderService',
      });
      const detail = (await ctx.http.get(`/alerts/${listed.id}`)).body.data;
      expect(JSON.parse(detail.source_query)).toEqual({
        service: 'shop-api',
        env: 'prod',
        status: 500,
        method: 'POST',
        path: '/orders',
      });
      expect(detail.samples).toHaveLength(2);
      expect(detail.samples[0]).toMatchObject({
        status: 'error',
        message: 'NullPointerException in OrderService',
        tags: expect.arrayContaining(['service:shop-api', 'env:prod']),
      });
      expect(Math.abs(Date.parse(detail.samples[0].timestamp) - minutesAgo(5))).toBeLessThan(MINUTE);
    });

    it('calls logcli as the Connector says, with the address, tenant and secret in its environment and none on the command line', async () => {
      const keychain = new FakeKeychain();
      keychain.values.set(LOKI_SECRET_KEY, 'glc_example_secret');
      const logcli = await FakeLogcli.create();
      logcli
        .stream(SHOP, [failure(5)])
        .requires({ basic: { username: '123456', password: 'glc_example_secret' } }, 'tenant-1');
      const ctx = await start({ loki: { bin: logcli.bin }, keychain });
      connectLoki(ctx, { auth: 'basic', username: '123456', org_id: 'tenant-1' });
      process.env.LOKI_ADDR = 'https://ambient.example.com';
      process.env.LOKI_BEARER_TOKEN = 'ambient-token';
      try {
        expect(await scanLoki(ctx)).toMatchObject({ status: 'ok' });
      } finally {
        delete process.env.LOKI_ADDR;
        delete process.env.LOKI_BEARER_TOKEN;
      }
      expect(logcli.calls().length).toBeGreaterThan(0);
      for (const call of logcli.calls()) {
        expect(call.env).toEqual({
          LOKI_ADDR: 'https://loki.example.com',
          LOKI_ORG_ID: 'tenant-1',
          LOKI_USERNAME: '123456',
          LOKI_PASSWORD: 'glc_example_secret',
        });
        expect(call.args.join(' ')).not.toContain('glc_example_secret');
      }
    });

    it('sends a bearer token as LOKI_BEARER_TOKEN alone', async () => {
      const keychain = new FakeKeychain();
      keychain.values.set(LOKI_SECRET_KEY, 'glc_example_bearer');
      const logcli = await FakeLogcli.create();
      logcli.stream(SHOP, [failure(5)]).requires({ bearer: 'glc_example_bearer' });
      const ctx = await start({ loki: { bin: logcli.bin }, keychain });
      connectLoki(ctx, { auth: 'bearer' });
      expect(await scanLoki(ctx)).toMatchObject({ status: 'ok' });
      expect(logcli.calls()[0]?.env).toEqual({
        LOKI_ADDR: 'https://loki.example.com',
        LOKI_BEARER_TOKEN: 'glc_example_bearer',
      });
    });

    it('finds the Services from the service label inside the selector, and reads a stream with no env label as no env', async () => {
      const logcli = await FakeLogcli.create();
      logcli
        .stream({ app: 'shop-api', env: 'prod', cluster: 'prod-1' }, [failure(5)])
        .stream({ app: 'shop-api', cluster: 'prod-1' }, [failure(6, { message: 'no env failure' })])
        .stream({ app: 'billing-api', env: 'prod', cluster: 'prod-2' }, [failure(7)])
        .stream({ job: 'cron', env: 'prod', cluster: 'prod-1' }, [failure(8)]);
      const ctx = await start({ loki: { bin: logcli.bin } });
      connectLoki(ctx, { service_label: 'app', env_label: 'env', selector: 'cluster="prod-1"' });
      expect((await ctx.http.get('/monitor/envs?connector=loki_logs')).body.data).toEqual([
        { name: 'prod', configured: true },
        { name: 'no env', configured: false },
      ]);
      expect(await scanLoki(ctx, { envs: ['prod', 'no env'] })).toMatchObject({ status: 'ok' });
      const rows = ctx.store.db.select().from(services).where(eq(services.connector, ConnectorId.LokiLogs)).all();
      expect(rows.map((row) => [row.name, row.env]).sort()).toEqual([
        ['shop-api', 'no env'],
        ['shop-api', 'prod'],
      ]);
      expect(await alertList(ctx)).toHaveLength(2);
    });

    it('reads only the Services of the env the Scan names', async () => {
      const logcli = await FakeLogcli.create();
      logcli
        .stream({ ...SHOP }, [failure(5)])
        .stream({ service_name: 'shop-api', deployment_environment_name: 'staging' }, [failure(5)]);
      const ctx = await start({ loki: { bin: logcli.bin } });
      connectLoki(ctx);
      await scanLoki(ctx, { envs: ['staging'] });
      expect((await ctx.http.get('/services')).body.data).toMatchObject([{ env: 'staging' }]);
    });

    it('reads logfmt lines when the Connector names that format, and skips JSON lines', async () => {
      const { ctx } = await scanned(
        [
          {
            at: minutesAgo(5),
            line: 'level=error method=POST path=/orders status=500 msg="NullPointerException in OrderService"',
          },
          failure(6),
        ],
        { config: { format: 'logfmt' } },
      );
      const [listed] = await alertList(ctx);
      expect(await alertList(ctx)).toHaveLength(1);
      expect(listed).toMatchObject({
        http_status: 500,
        route: { method: 'POST', path: '/orders' },
        log_line: 'NullPointerException in OrderService',
        event_count: 1,
      });
    });

    it('takes each field from the first of its names present, nested keys joined with an underscore', async () => {
      const bare = { status: undefined, method: undefined, path: undefined, level: undefined, message: undefined };
      const { ctx } = await scanned([
        failure(5, {
          ...bare,
          statusCode: 502,
          httpMethod: 'get',
          resourcePath: '/a',
          severity: 'error',
          msg: 'by camel case',
        }),
        failure(6, {
          ...bare,
          status_code: 503,
          method: 'PUT',
          route: '/b',
          log_level: 'ERROR',
          message: 'by snake case',
        }),
        failure(7, {
          ...bare,
          http: { status_code: 504 },
          http_method: 'delete',
          url: { path: '/c' },
          msg: 'by nested names',
        }),
        // The first name present wins: `status` is 200, so `statusCode` is not read and the level makes it fail.
        failure(8, {
          ...bare,
          status: 200,
          statusCode: 500,
          path: '/d',
          method: 'GET',
          level: 'fatal',
          message: 'first wins',
        }),
      ]);
      const list: { http_status: number | null; route: { method: string; path: string } | null; log_line: string }[] =
        await alertList(ctx);
      const found = Object.fromEntries(list.map((a) => [a.log_line, [a.http_status, a.route?.method, a.route?.path]]));
      expect(found).toEqual({
        'by camel case': [502, 'GET', '/a'],
        'by snake case': [503, 'PUT', '/b'],
        'by nested names': [504, 'DELETE', '/c'],
        'first wins': [200, 'GET', '/d'],
      });
    });

    it('counts a line as failing by a status of 400 or more or an error level in any case, and not a line that does not parse', async () => {
      const bare = { status: undefined, method: undefined, path: undefined };
      const { ctx } = await scanned([
        failure(5, { ...bare, status: 404, level: 'info', message: 'no such cart' }),
        failure(5, { ...bare, level: 'ERROR', message: 'level error' }),
        failure(5, { ...bare, level: 'Critical', message: 'level critical' }),
        failure(5, { ...bare, level: 'alert', message: 'level alert' }),
        failure(5, { ...bare, level: 'EMERGENCY', message: 'level emergency' }),
        failure(5, { ...bare, level: 'fatal', message: 'level fatal' }),
        failure(5, { ...bare, status: 200, level: 'info', message: 'all fine' }),
        failure(5, { ...bare, status: 399, level: 'warn', message: 'redirect' }),
        failure(5, { ...bare, level: 'warn', message: 'slow call' }),
        { at: minutesAgo(5), line: 'ERROR plain text, not JSON' },
      ]);
      expect((await alertList(ctx)).map((alert: { log_line: string }) => alert.log_line).sort()).toEqual([
        'level alert',
        'level critical',
        'level emergency',
        'level error',
        'level fatal',
        'no such cart',
      ]);
    });

    it('reads only the lines inside the Scan window', async () => {
      const { ctx } = await scanned([failure(30, { message: 'inside' }), failure(150, { message: 'outside' })], {
        body: { window: '1h' },
      });
      const [alert] = await alertList(ctx);
      expect(alert).toMatchObject({ event_count: 1, log_line: 'inside' });
    });

    it('leaves out the ignored status classes and reads only the status codes the Scan asks for', async () => {
      const entries = [
        failure(5, { status: 404, message: 'missing' }),
        failure(5, { status: 500, message: 'broken' }),
        failure(5, { status: 502, message: 'gateway' }),
      ];
      const ignoring = await scanned(entries, { config: { ignore: [{ kind: 'status_class', value: '4xx' }] } });
      expect((await alertList(ignoring.ctx)).map((a: { log_line: string }) => a.log_line).sort()).toEqual([
        'broken',
        'gateway',
      ]);
      const asked = await scanned(entries, { body: { status_codes: [502] } });
      expect((await alertList(asked.ctx)).map((a: { log_line: string }) => a.log_line)).toEqual(['gateway']);
    });

    it('keeps secret values and request body values out of the Samples', async () => {
      const { ctx } = await scanned([
        failure(5, {
          message: 'login failed password=hunter2hunter2 for u-1',
          path: '/login',
          body: '{"card":"4111111111111111"}',
          headers: { authorization: 'Bearer abcdefghij123456' },
          user: 'u-1',
        }),
      ]);
      const [listed] = await alertList(ctx);
      const [sample] = (await ctx.http.get(`/alerts/${listed.id}`)).body.data.samples;
      expect(sample.message).toBe('login failed password=[redacted] for u-1');
      expect(sample.attributes).toMatchObject({
        body: '[redacted]',
        headers: { authorization: '[redacted]' },
        user: 'u-1',
      });
    });

    it('reads the newest 5,000 failing lines of a Service, counts them in full, and says so in the Scan notes', async () => {
      const many = Array.from({ length: 5_050 }, (_, index) => ({
        at: Date.now() - 60_000 - index * 10,
        line: { ...LINE, message: 'NullPointerException in OrderService' },
      }));
      const { ctx, ended } = await scanned(many);
      expect(ended.status).toBe('ok');
      expect(ended.notes).toContain('shop-api: read the newest 5,000 failing lines only');
      const [alert] = await alertList(ctx);
      // The counts query is not cut by the cap, and one message group on the Route takes its count.
      expect(alert.event_count).toBe(5_050);
      expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.samples).toHaveLength(25);
    });

    it('counts message groups of one Route from the lines read when the Route has several', async () => {
      const lines = (message: string, count: number) =>
        Array.from({ length: count }, (_, index) => ({
          at: Date.now() - 60_000 - index * 10,
          line: { ...LINE, message },
        }));
      const { ctx, ended } = await scanned([
        ...lines('timed out calling payments', 3_000),
        ...lines('stock service refused', 2_100),
      ]);
      expect(ended.notes).toContain('shop-api: read the newest 5,000 failing lines only');
      const counts = Object.fromEntries(
        (await alertList(ctx)).map((a: { log_line: string; event_count: number }) => [a.log_line, a.event_count]),
      );
      expect(counts['stock service refused']).toBeLessThanOrEqual(2_100);
      expect(counts['timed out calling payments'] + counts['stock service refused']).toBe(5_000);
    });

    it('counts a failing line that names no status, method or route', async () => {
      const bare = { status: undefined, method: undefined, path: undefined };
      const { ctx } = await scanned(
        Array.from({ length: 3 }, (_, index) => failure(5 + index, { ...bare, message: 'payments client timed out' })),
      );
      const [alert] = await alertList(ctx);
      expect(alert).toMatchObject({ http_status: null, route: null, event_count: 3 });
    });
  });

  describe('Alerts', () => {
    it('sets Severity from the same rules as the other sources', async () => {
      const bucket = Math.floor(minutesAgo(60) / (10 * MINUTE)) * 10 * MINUTE;
      // Twice the threshold within 100 seconds: whichever 10 minutes Loki counts, one holds at least 100.
      const rapid = Array.from({ length: 250 }, (_, i) => ({
        at: bucket + (i % 100) * 1000,
        line: { ...LINE, path: '/rapid' },
      }));
      const steady = Array.from({ length: 120 }, (_, i) => ({
        at: minutesAgo(i + 1),
        line: { ...LINE, path: '/steady' },
      }));
      const few = [1, 2, 3].map((i) => failure(i, { path: '/few' }));
      // Fatal is error level whatever the status code.
      const fatal = Array.from({ length: 120 }, (_, i) => ({
        at: minutesAgo(i + 1),
        line: { ...LINE, status: 401, level: 'fatal', path: '/fatal' },
      }));
      const { ctx } = await scanned([...rapid, ...steady, ...few, ...fatal]);
      const severities = Object.fromEntries(
        (await alertList(ctx)).map((alert: { route: { path: string }; severity: string }) => [
          alert.route.path,
          alert.severity,
        ]),
      );
      expect(severities).toEqual({ '/rapid': 'high', '/steady': 'medium', '/few': 'low', '/fatal': 'medium' });
    });

    it('puts the source in the Fingerprint, and leaves the other sources Fingerprints alone', async () => {
      const logcli = await FakeLogcli.create();
      logcli.stream(SHOP, [failure(5)]);
      const looped = await start({ loki: { bin: logcli.bin } });
      looped.datadog.readings = [service('shop-api', [route('POST', '/orders', 4)])];
      connectLoki(looped);
      await scan(looped);
      await scanLoki(looped);
      const rows = looped.store.db.select().from(alerts).all();
      const byConnector = Object.fromEntries(rows.map((row) => [row.connector, row.fingerprint]));
      const rowOf = (connector: LogSource) =>
        looped.store.db.select().from(services).where(eq(services.connector, connector)).get();
      expect(byConnector.loki_logs).toBe(
        fingerprint(
          rowOf(ConnectorId.LokiLogs)?.id as string,
          'POST',
          '/orders',
          'NullPointerException in OrderService',
          500,
          ConnectorId.LokiLogs,
        ),
      );
      expect(byConnector.datadog).toBe(
        fingerprint(
          rowOf(ConnectorId.Datadog)?.id as string,
          'POST',
          '/orders',
          'NullPointerException in OrderService',
          500,
        ),
      );
      expect(Object.keys(byConnector).sort()).toEqual(['datadog', 'loki_logs']);
    });
  });

  describe('failures', () => {
    const outcome = async (arrange: (logcli: FakeLogcli) => void) => {
      const logcli = await FakeLogcli.create();
      logcli.stream(SHOP, [failure(5)]);
      arrange(logcli);
      const ctx = await start({ loki: { bin: logcli.bin } });
      connectLoki(ctx);
      return scanLoki(ctx, { envs: ['prod'] });
    };

    it('shows Loki’s reason when a query limit refuses the read', async () => {
      const reason = 'maximum of series (500) reached for a single query';
      expect(await outcome((logcli) => logcli.rejectQueries(reason))).toMatchObject({
        status: 'failed',
        error_code: 'upstream_failed',
        error_message: `Loki refused the query: ${reason}`,
      });
    });

    it('shows Loki’s reason when logcli prints its error line with a capital E', async () => {
      const reason = 'maximum of series (500) reached for a single query';
      expect(await outcome((logcli) => logcli.printsCapitalized().rejectQueries(reason))).toMatchObject({
        status: 'failed',
        error_message: `Loki refused the query: ${reason}`,
      });
    });

    it('ends a rate limit rate limited', async () => {
      expect(await outcome((logcli) => logcli.behave('throttle'))).toMatchObject({
        status: 'rate_limited',
        error_code: 'rate_limited',
      });
    });

    it('ends a refused secret and an unreachable URL upstream failed, with no Loki text in the message', async () => {
      for (const behavior of ['unauthorized', 'forbidden', 'unreachable'] as const) {
        expect(await outcome((logcli) => logcli.behave(behavior)), behavior).toMatchObject({
          status: 'failed',
          error_code: 'upstream_failed',
          error_message: '`logcli series` failed',
        });
      }
    });

    it('kills the running logcli when the operator stops the Scan', async () => {
      const logcli = await FakeLogcli.create();
      logcli
        .stream(SHOP, [failure(5)])
        .behaveOn('samples', 'hang')
        .behaveOn('counts', 'hang');
      const ctx = await start({ loki: { bin: logcli.bin } });
      connectLoki(ctx);
      const started = await ctx.http.post('/scans', { service_id: null, connector: 'loki_logs', envs: ['prod'] });
      await until(
        () => logcli.commands().filter((command) => command === 'query').length,
        (asked) => asked >= 2,
        'both queries to be running',
      );
      expect((await ctx.http.post(`/scans/${started.body.data.id}/cancel`)).status).toBe(204);
      await until(
        () => ctx.http.get(`/scans/${started.body.data.id}`).then((res) => res.body.data.status),
        (status) => status === 'cancelled',
        'the Scan to be cancelled',
      );
      const pids = logcli
        .calls()
        .filter((call) => call.args.includes('query'))
        .map((call) => call.pid);
      for (const pid of pids) {
        await until(
          () => alive(pid),
          (running) => !running,
          'the query to be killed',
        );
      }
    });

    it('does not stop another source Scan when Loki is down, and shows the others Alerts', async () => {
      const logcli = await FakeLogcli.create();
      logcli.stream(SHOP, [failure(5)]).behave('unreachable');
      const ctx = await start({ loki: { bin: logcli.bin } });
      ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 4)])];
      connectLoki(ctx);
      expect((await ctx.http.post('/scans', { service_id: null })).status).toBe(202);
      const all = await until(
        () => ctx.http.get('/scans').then((res) => res.body.data),
        (found: { connector: string; status: string }[]) =>
          found.length === 2 && found.every((one) => one.status !== 'running'),
        'both Scans',
      );
      expect(all.map((one: { connector: string; status: string }) => [one.connector, one.status]).sort()).toEqual([
        ['datadog', 'ok'],
        ['loki_logs', 'failed'],
      ]);
      expect((await alertList(ctx)).map((alert: { connector: string }) => alert.connector)).toEqual(['datadog']);
    });
  });

  it('reads four sources at once into one Alert list, filterable by source, with the down source named by its failed Scan', async () => {
    const logcli = await FakeLogcli.create();
    logcli.stream(SHOP, [failure(5)]);
    const aws = await FakeAws.create();
    aws.group('/ecs/shop-api', [{ at: minutesAgo(5), message: LINE }]);
    const ctx = await start({ loki: { bin: logcli.bin } });
    ctx.datadog.readings = [service('shop-api', [route('POST', '/orders', 4)])];
    await writeLogFile(ctx.logs, 'logs.jsonl', [
      otlpLine({
        at: minutesAgo(5),
        service: 'shop-api',
        resource: { 'deployment.environment.name': 'prod' },
        severity: 17,
        body: 'NullPointerException in OrderService',
        attributes: { 'http.response.status_code': 500, 'http.request.method': 'POST', 'http.route': '/orders' },
      }),
    ]);
    expect((await ctx.http.post('/connectors/otel_logs/connect', { folder: ctx.logs })).status).toBe(202);
    setConnector(ctx.store, ConnectorId.CloudWatchLogs, {
      status: HealthStatus.Ok,
      config: JSON.stringify({
        ...DEFAULT_CONNECTOR_CONFIG[ConnectorId.CloudWatchLogs],
        profile: 'ops',
        region: 'us-east-1',
        log_groups: [{ name: '/ecs/shop-api', service: 'shop-api', env: 'prod' }],
      }),
    });
    connectLoki(ctx);
    logcli.behave('unreachable');
    expect((await ctx.http.post('/scans', { service_id: null })).status).toBe(202);
    const all = await until(
      () => ctx.http.get('/scans').then((res) => res.body.data),
      (found: { connector: string; status: string }[]) =>
        found.length === 4 && found.every((one) => one.status !== 'running'),
      'all four Scans',
    );
    expect(all.map((one: { connector: string; status: string }) => [one.connector, one.status]).sort()).toEqual([
      ['cloudwatch_logs', 'ok'],
      ['datadog', 'ok'],
      ['loki_logs', 'failed'],
      ['otel_logs', 'ok'],
    ]);
    expect((await alertList(ctx)).map((alert: { connector: string }) => alert.connector).sort()).toEqual([
      'cloudwatch_logs',
      'datadog',
      'otel_logs',
    ]);
    logcli.behave(null);
    await scanLoki(ctx);
    expect((await alertList(ctx)).map((alert: { connector: string }) => alert.connector).sort()).toEqual([
      'cloudwatch_logs',
      'datadog',
      'loki_logs',
      'otel_logs',
    ]);
    expect(
      (await alertList(ctx, '?connector=loki_logs')).map((alert: { connector: string }) => alert.connector),
    ).toEqual(['loki_logs']);
  });

  it('refuses a Scan or a Service list while Loki logs is not connected', async () => {
    const ctx = await start();
    const scanRefused = await ctx.http.post('/scans', { service_id: null, connector: 'loki_logs' });
    expect([scanRefused.status, scanRefused.body.error.code]).toEqual([409, 'connector_not_connected']);
    const listed = await ctx.http.get('/monitor/log-services?connector=loki_logs&window=24h');
    expect([listed.status, listed.body.error.code]).toEqual([409, 'connector_not_connected']);
  });

  it('links an imported Repo with the Service name, as any Service is', async () => {
    const logcli = await FakeLogcli.create();
    logcli.stream({ ...SHOP, service_name: 'orders-api' }, [failure(5)]);
    const ctx = await start({ loki: { bin: logcli.bin } });
    const repo = (await ctx.http.post('/repos', { path: await makeRepo() })).body.data;
    connectLoki(ctx);
    await scanLoki(ctx);
    const linked = await until(
      () => ctx.http.get('/services').then((res) => res.body.data[0]),
      (found) => found.repo_id !== null,
      'the Repo to be linked',
    );
    expect(linked).toMatchObject({ connector: 'loki_logs', repo_id: repo.id });
  });

  describe('Services and the schedule', () => {
    it('lists the Services and envs with their failing counts and status codes', async () => {
      const logcli = await FakeLogcli.create();
      logcli
        .stream(SHOP, [failure(5), failure(6), failure(7, { status: 404 })])
        .stream({ service_name: 'billing-api', deployment_environment_name: 'staging' }, [failure(5, { status: 502 })]);
      const ctx = await start({ loki: { bin: logcli.bin } });
      connectLoki(ctx);
      expect((await ctx.http.get('/monitor/envs?connector=loki_logs')).body.data).toEqual([
        { name: 'prod', configured: true },
        { name: 'staging', configured: false },
        { name: 'no env', configured: false },
      ]);
      expect((await ctx.http.get('/monitor/log-services?connector=loki_logs&window=24h')).body.data).toEqual([
        { name: 'shop-api', envs: ['prod'], errors: 3 },
        { name: 'billing-api', envs: ['staging'], errors: 1 },
      ]);
      expect((await ctx.http.get('/monitor/status-codes?connector=loki_logs&window=24h')).body.data).toEqual([
        { code: 500, count: 2 },
        { code: 404, count: 1 },
        { code: 502, count: 1 },
      ]);
    });

    it('runs on its own interval, and skips the source when it is not connected', async () => {
      const logcli = await FakeLogcli.create();
      logcli.stream(SHOP, [failure(5)]);
      const ctx = await start({ loki: { bin: logcli.bin } });
      connectLoki(ctx);
      await ctx.http.patch('/connectors/loki_logs', { config: { default_interval: '12h' } });
      const monitor = ctx.daemon.app.get(ScansService);
      const scheduled = () =>
        ctx.store.db
          .select()
          .from(scans)
          .where(eq(scans.triggeredBy, ScanTrigger.Schedule))
          .all()
          .map((one) => [one.connector, one.windowSize])
          .sort();
      await monitor.runDue(new Date(2026, 9, 5, 9, 1));
      expect(scheduled()).toEqual([
        ['datadog', '24h'],
        ['loki_logs', '12h'],
      ]);
      setConnector(ctx.store, ConnectorId.LokiLogs, { status: HealthStatus.Fail });
      await monitor.runDue(new Date(Date.now() + 2 * 86_400_000));
      expect(scheduled().filter(([connector]) => connector === 'loki_logs')).toHaveLength(1);
    });

    it('keeps each source Scans through retention, per Service', async () => {
      const logcli = await FakeLogcli.create();
      logcli.stream(SHOP, [failure(5)]);
      const ctx = await start({ loki: { bin: logcli.bin } });
      ctx.datadog.readings = [service('shop-api', [route('POST', '/orders', 4)])];
      connectLoki(ctx);
      for (let round = 0; round < 2; round++) {
        await scan(ctx);
        await scanLoki(ctx);
      }
      const long = new Date(Date.now() - 40 * 86_400_000).toISOString();
      ctx.store.write((tx) => tx.update(scans).set({ startedAt: long }).run());
      await ctx.daemon.app.get(MonitorRetention).run();
      expect(
        ctx.store.db
          .select()
          .from(scans)
          .all()
          .map((one) => one.connector)
          .sort(),
      ).toEqual(['datadog', 'loki_logs']);
    });
  });

  describe('Recheck, Verification and Fix', () => {
    const recheckOf = (report: { steps: { kind: string; text: string }[] }) =>
      report.steps[0] as { kind: string; text: string };
    const promptsSince = (ctx: Ctx, from: number) => ctx.daemon.sdk.calls.slice(from).map((call) => call.prompt);
    const deniedSince = (ctx: Ctx, from: number) =>
      ctx.daemon.sdk.calls.slice(from).flatMap((call) => {
        const settings = call.options.settings as { deniedMcpServers?: { serverName: string }[] } | undefined;
        return (settings?.deniedMcpServers ?? []).map((server) => server.serverName);
      });

    async function failingLoki(entries = [failure(5), failure(8)]) {
      const logcli = await FakeLogcli.create();
      logcli.stream(SHOP, entries);
      const ctx = await start({ loki: { bin: logcli.bin } });
      connectLoki(ctx);
      await scanLoki(ctx);
      const [alert] = await alertList(ctx);
      await linkRepo(ctx, alert.service.id);
      return { ctx, logcli, alert };
    }

    it('counts the Alert’s lines for the last hour through its filter, before the agent starts', async () => {
      const { ctx, logcli, alert } = await failingLoki();
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored)).toEqual({ kind: 'result', text: 'Loki logs recheck, last hour: still failing' });
      expect(ctx.datadog.rechecks).toEqual([]);
      expect(logcli.commands().at(-1)).toBe('instant-query');
      expect(stored.status).toBe('ready');
    });

    it('says not seen when the last hour holds none of them', async () => {
      const { ctx, alert } = await failingLoki([failure(100)]);
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored).text).toBe('Loki logs recheck, last hour: not seen');
      expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('verified');
    });

    it('writes why a Recheck failed, and goes on', async () => {
      const { ctx, logcli, alert } = await failingLoki();
      logcli.behave('throttle');
      const report = await verify(ctx, alert.id);
      const stored = (await ctx.http.get(`/reports/${report.id}`)).body.data;
      expect(recheckOf(stored)).toEqual({ kind: 'warning', text: 'Recheck failed: Loki rate limit reached' });
      expect(stored.status).toBe('ready');
    });

    it('briefs the agent with the source, the Samples and the filter, and tells it to use no pup, no Datadog server, and logcli through run_integration', async () => {
      const { ctx, alert } = await failingLoki([failure(5)]);
      const before = ctx.daemon.sdk.calls.length;
      await verify(ctx, alert.id);
      const brief = promptsSince(ctx, before).find((prompt) => prompt.includes('Find the cause of a failure')) ?? '';
      expect(brief).toContain('Loki logs');
      expect(brief).toContain('NullPointerException in OrderService');
      expect(brief).toContain('Loki logs filter: {"service":"shop-api","env":"prod"');
      expect(brief).toMatch(/no `pup` and no Datadog MCP Server/);
      expect(brief).toMatch(/`logcli` through the `run_integration` tool/);
      expect(brief).not.toContain('Datadog query');
      expect(brief).not.toContain('failure Datadog logged');
      expect(deniedSince(ctx, before)).toContain('datadog-pup');
    });

    it('starts a Fix of a Loki Alert with a Recheck and the same rule on its tools', async () => {
      const { ctx, alert } = await failingLoki();
      await verify(ctx, alert.id);
      const before = ctx.daemon.sdk.calls.length;
      for (const run of stepTurns(PlaybookTrigger.Fix)) ctx.daemon.sdk.script(...run);
      ctx.daemon.sdk.script(json({ description: 'Defaults the order total.' }));
      const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
      await until(
        () => ctx.http.get(`/fixes/${confirm.body.data.fix.id}`).then((res) => res.body.data.status),
        (status) => status !== 'running',
        'the Fix to end',
      );
      const prompts = promptsSince(ctx, before);
      expect(prompts[0]).toContain('Loki logs recheck, last hour: still failing');
      expect(prompts[0]).toMatch(/no `pup` and no Datadog MCP Server/);
      expect(deniedSince(ctx, before)).toContain('datadog-pup');
    });
  });
});

/** Whether the process still runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
