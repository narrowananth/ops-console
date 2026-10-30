import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AlertStatus,
  CheckInterval,
  ConnectorId,
  FixStatus,
  HealthStatus,
  PrState,
  RunStatus,
  ScanStatus,
  ScanTrigger,
  SessionState,
  type WsEvent,
} from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import {
  alertEvents,
  alerts,
  connectors,
  fixes,
  reports,
  reviews,
  scanRouteResults,
  scans,
  sessions,
} from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { fingerprint, maskSignature, normalizePath } from '../src/monitor/fingerprint';
import { MonitorModule } from '../src/monitor/monitor.module';
import { latestSlot, nextSlot, ScansService } from '../src/monitor/scans.service';
import { ReposModule } from '../src/repos/repos.module';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, gate, listen, startAgentDaemon, until } from './agent-fixtures';
import type { Step } from './fakes/agent-sdk';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeDatadog, route, samples, service } from './fakes/datadog';
import { FakeGitHost, hostPr } from './fakes/git-host';
import { FakeProbe } from './fakes/probe';
import { tempDir } from './helpers';

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
};

function setConnector(store: Store, id: ConnectorId, patch: Partial<typeof connectors.$inferInsert>) {
  store.write((tx) => tx.update(connectors).set(patch).where(eq(connectors.id, id)).run());
}

async function start(options: { dataDir?: string; datadog?: FakeDatadog; connected?: boolean } = {}): Promise<Ctx> {
  const datadog = options.datadog ?? new FakeDatadog();
  const host = new FakeGitHost();
  const daemon = await startAgentDaemon({
    fixtureKinds: false,
    dataDir: options.dataDir,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      ReposModule.forRoot(),
      WorkspaceModule.forRoot({ hosts: host }),
      MonitorModule.forRoot({ datadog }),
    ],
  });
  running.push(daemon);
  const store = daemon.app.get<Store>(STORE);
  if (options.connected ?? true) {
    setConnector(store, ConnectorId.Datadog, { status: HealthStatus.Ok });
    setConnector(store, ConnectorId.Jira, { status: HealthStatus.Ok });
    setConnector(store, ConnectorId.Github, { status: HealthStatus.Ok, login: 'octo-operator' });
  }
  return { daemon, datadog, host, store, http: api(daemon), dir: '' };
}

async function scan(ctx: Ctx, serviceId: string | null = null): Promise<{ id: string; status: string }> {
  const started = await ctx.http.post('/scans', { service_id: serviceId });
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
  await ctx.http.patch(`/services/${serviceId}`, { repo_id: repo.body.data.id });
  return repo.body.data.id;
}

async function verify(ctx: Ctx, alertId: string, script: Step[] = [json(REPORT)]) {
  ctx.daemon.sdk.script(...script);
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
      ['/orders', 'ok'],
      ['/orders', 'failing'],
    ]);
    const alerts = await alertList(ctx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: 'open', event_count: 12, severity: 'warn', source: 'scan' });
    const detail = (await ctx.http.get(`/alerts/${alerts[0].id}`)).body.data;
    expect(detail.samples).toHaveLength(12);
    expect(detail.waiting_since).toBeNull();
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
        route('GET', '/warnonly', 240, { peakPer10m: 20, samples: samples(5, 'slow query', 'warn') }),
      ]),
    ];
    await scan(ctx);
    const bySeverity = Object.fromEntries(
      (await alertList(ctx)).map((a: { route: { path: string }; severity: string }) => [a.route.path, a.severity]),
    );
    expect(bySeverity).toEqual({ '/rapid': 'sev2', '/steady': 'sev3', '/quiet': 'warn', '/warnonly': 'warn' });
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
    expect((await alertList(ctx))[0]).toMatchObject({ status: 'resolved', regression_count: 0 });
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
    expect((await alertList(ctx))[0]).toMatchObject({ status: 'dismissed', event_count: 15, regression_count: 0 });
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
    expect(ctx.datadog.calls[0]).toMatchObject({ window: '6h', service: 'orders-api' });
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
      json(REPORT),
    );
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
    listener.close();
    const events = (await ctx.http.get(`/alerts/${alert.id}/events`)).body.data.map((e: { kind: string }) => e.kind);
    expect(events).toEqual(['detected', 'verification_started', 'verified']);
  });

  it('fails the Report, keeps its steps and returns the Alert to open when the run fails', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    const started = await verify(ctx, alert.id, [{ text: 'Looking.' }, { crash: 'claude died' }]);
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

  it('refuses a confirm while Jira is not connected and creates nothing', async () => {
    const ctx = await start();
    const { alert } = await verified(ctx);
    setConnector(ctx.store, ConnectorId.Jira, { status: HealthStatus.Off });
    const response = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    expect([response.status, response.body.error.code]).toEqual([409, 'connector_not_connected']);
    expect(ctx.store.db.select().from(reviews).all()).toHaveLength(0);
    expect(ctx.store.db.select().from(fixes).all()).toHaveLength(0);
    expect((await alertList(ctx))[0].status).toBe('verified');
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
    ctx.daemon.sdk.script(json({ key: 'ORD-7', url: 'https://example.atlassian.net/browse/ORD-7' }));
    const sent = await ctx.http.post(`/sessions/${sessionId}/messages`, { text: '  Do It ' });
    expect(sent.status).toBe(202);
    expect((await ctx.http.get(`/alerts/${alert.id}`)).body.data.status).toBe('fixing');
    expect(ctx.store.db.select().from(reviews).all()[0]).toMatchObject({ decision: 'confirmed', kind: 'bug' });
    // The scripted run answers with no ticket, so the Fix fails; wait for it before the daemon stops.
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

describe('Fix', () => {
  const TICKET = json({ key: 'ORD-7', url: 'https://example.atlassian.net/browse/ORD-7' });
  const CODED = json({ summary: 'defaulted the total' });
  const PASSED = json({ passed: true, summary: '12 passed' });
  const OPENED = json({ number: 41, url: 'https://github.com/acme/orders-api/pull/41' });
  const MOVED = json({ ok: true });

  /** Each stage is its own agent run, so each gets its own script. */
  function scriptRuns(ctx: Ctx, ...answers: Step[]) {
    for (const answer of answers) ctx.daemon.sdk.script(answer);
  }

  it('runs ticket, branch, code, tests and pr, then moves the Alert to pr_open', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
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
    expect(git(ctx.dir, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).toBe('ORD-7-null-order-total');
    const advanced = listener.events.filter((e: WsEvent) => e.event === 'fix.advanced');
    expect(advanced.length).toBeGreaterThanOrEqual(5);
    listener.close();
    const kinds = (await ctx.http.get(`/alerts/${alert.id}/events`)).body.data.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['confirmed', 'ticket_created', 'fix_advanced', 'pr_opened']));
    const prompts = ctx.daemon.sdk.calls.map((call) => call.prompt);
    expect(prompts[1]).toContain('Atlassian MCP');
    expect(prompts[1]).toContain('priority Medium');
  });

  it('fails at the stage that failed, keeps the Alert in fixing, and a retry does not create the ticket twice', async () => {
    const ctx = await start();
    const alert = await failing(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    scriptRuns(ctx, TICKET, CODED, json({ passed: false, summary: '2 failed' }));
    const confirm = await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'bug' });
    const fixId = confirm.body.data.fix.id;
    const failed = await until(
      () => ctx.http.get(`/fixes/${fixId}`).then((res) => res.body.data),
      (fix) => fix.status === 'failed',
      'the Fix to fail',
    );
    expect(failed).toMatchObject({ stage: 'tests', jira_key: 'ORD-7' });
    expect(failed.error_message).toContain('2 failed');
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

  it('uses priority High for sev2', async () => {
    const ctx = await start();
    ctx.datadog.readings = [service('orders-api', [route('POST', '/orders', 400, { peakPer10m: 200 })])];
    await scan(ctx);
    const [alert] = await alertList(ctx);
    await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    scriptRuns(ctx, TICKET);
    await ctx.http.post(`/alerts/${alert.id}/review`, { decision: 'confirmed', kind: 'improvement' });
    await until(
      () => ctx.daemon.sdk.calls.length,
      (count) => count >= 2,
    );
    expect(ctx.daemon.sdk.calls[1]?.prompt).toContain('priority High');
    expect(ctx.daemon.sdk.calls[1]?.prompt).toContain('issue type "Improvement"');
  });

  async function prOpen(ctx: Ctx) {
    const alert = await failing(ctx);
    const repoId = await linkRepo(ctx, alert.service.id);
    await verify(ctx, alert.id);
    scriptRuns(ctx, TICKET, CODED, PASSED, OPENED, MOVED);
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
    // The run is blocked on the gate once the SDK was called for it.
    const before = first.daemon.sdk.calls.length;
    await until(
      () => first.daemon.sdk.calls.length,
      (count) => count > before - 1 && count >= 2,
    );
    await first.daemon.stop();
    running.pop();
    const second = await start({ dataDir, datadog: first.datadog });
    const fix = (await second.http.get(`/fixes/${confirm.body.data.fix.id}`)).body.data;
    expect(fix).toMatchObject({ status: 'failed', stage: 'ticket', error_message: 'interrupted' });
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
