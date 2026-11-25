import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectorId, HealthStatus, PlaybookTrigger } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { connectors, sessions } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { MonitorModule } from '../src/monitor/monitor.module';
import { ReposModule } from '../src/repos/repos.module';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, startAgentDaemon, stepTurns, until } from './agent-fixtures';
import type { Step } from './fakes/agent-sdk';
import { AWS_BIN } from './fakes/aws-logs';
import { FakeCodeHosts } from './fakes/code-hosts';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeDatadog, route, service } from './fakes/datadog';
import { FakeGitHost } from './fakes/git-host';
import { FakeProbe } from './fakes/probe';
import { tempDir } from './helpers';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' });

const json = (body: object): Step => ({ text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`` });
const REPORT = {
  kind: 'bug',
  slug: 'Null Order Total!',
  root_cause: 'OrderService reads a missing total',
  proposed_fix: 'Default the total to zero',
  replay: { request: 'curl -X POST localhost:8080/orders', response: '500' },
  diff: [{ sign: '+', text: 'const total = order.total ?? 0;' }],
};

/** A Service with one failing Route and an imported Repo, and the Alert raised for it. */
async function start() {
  const datadog = new FakeDatadog();
  const daemon = await startAgentDaemon({
    fixtureKinds: false,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      ReposModule.forRoot(),
      WorkspaceModule.forRoot({ hosts: new FakeGitHost() }),
      MonitorModule.forRoot({
        datadog,
        codeHosts: new FakeCodeHosts(),
        cloudWatch: { bin: AWS_BIN, pollMs: 10 },
      }),
    ],
  });
  running.push(daemon);
  const store = daemon.app.get<Store>(STORE);
  store.write((tx) => {
    for (const id of [ConnectorId.Datadog, ConnectorId.Jira, ConnectorId.Github]) {
      tx.update(connectors).set({ status: HealthStatus.Ok, login: 'octo-operator' }).where(eq(connectors.id, id)).run();
    }
  });
  const http = api(daemon);
  datadog.readings = [service('orders-api', [route('POST', '/orders', 12)])];
  const scanned = await http.post('/scans', { service_id: null, connector: 'datadog' });
  await until(
    () => http.get(`/scans/${scanned.body.data.id}`).then((res) => res.body.data.status),
    (status) => status !== 'running',
    'the Scan to end',
  );
  const [alert] = (await http.get('/alerts')).body.data;
  const root = await tempDir('ops-console-monitor-');
  const dir = path.join(root, 'orders-api');
  const bare = path.join(root, 'orders-api.git');
  await mkdir(dir, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/orders-api.git');
  const repo = await http.post('/repos', { path: dir });
  git(dir, 'remote', 'set-url', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
  await http.patch(`/services/${alert.service.id}`, { repo_id: repo.body.data.id });
  return { daemon, store, http, alertId: alert.id as string };
}

type Ctx = Awaited<ReturnType<typeof start>>;

const alertSession = (ctx: Ctx) =>
  ctx.http.get(`/alerts/${ctx.alertId}`).then((res) => res.body.data.session_id as string | null);

const verify = async (ctx: Ctx) => {
  for (const turn of stepTurns(PlaybookTrigger.Verify)) ctx.daemon.sdk.script(...turn);
  ctx.daemon.sdk.script(json(REPORT));
  expect((await ctx.http.post(`/alerts/${ctx.alertId}/verifications`)).status).toBe(202);
  await until(
    () => ctx.http.get(`/alerts/${ctx.alertId}`).then((res) => res.body.data.status),
    (status) => status !== 'verifying',
    'the Verification to end',
  );
};

describe('the Alert Session', () => {
  it('serves Verify, Verify again and Fix in one Session, and a deleted Session is made again on the next use', async () => {
    const ctx = await start();
    const sessionCount = () => ctx.store.db.select().from(sessions).all().length;
    expect(await alertSession(ctx)).toBeNull();

    await verify(ctx);
    const first = await alertSession(ctx);
    expect(first).not.toBeNull();
    expect(sessionCount()).toBe(1);

    await verify(ctx);
    expect(await alertSession(ctx)).toBe(first);

    // Deleting the Session leaves the Alert with none; the next Verify makes a new one.
    expect((await ctx.http.delete(`/sessions/${first}`)).status).toBe(204);
    expect(await alertSession(ctx)).toBeNull();
    await verify(ctx);
    const second = await alertSession(ctx);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(sessionCount()).toBe(1);

    for (const turn of stepTurns(PlaybookTrigger.Fix)) ctx.daemon.sdk.script(...turn);
    ctx.daemon.sdk.script(json({ description: 'Defaults the order total.' }));
    const confirmed = await ctx.http.post(`/alerts/${ctx.alertId}/review`, { decision: 'confirmed', kind: 'bug' });
    expect(confirmed.status).toBe(200);
    const fix = await until(
      () => ctx.http.get(`/fixes/${confirmed.body.data.fix.id}`).then((res) => res.body.data),
      (found) => found.status !== 'running',
      'the Fix to end',
    );
    expect(fix.session_id).toBe(second);
    expect(await alertSession(ctx)).toBe(second);
    expect(sessionCount()).toBe(1);
  });
});
