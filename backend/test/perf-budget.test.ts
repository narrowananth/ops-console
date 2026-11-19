import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessMode, ConnectorId, Effort, HealthStatus, Model, SessionKind } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionsModule } from '../src/connections/connections.module';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { alerts, connectors, routes, services, sessions } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { MonitorModule } from '../src/monitor/monitor.module';
import { ReposModule } from '../src/repos/repos.module';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, startAgentDaemon } from './agent-fixtures';
import { FakeCodeHosts } from './fakes/code-hosts';
import { FakeConnectionTester } from './fakes/connection-tester';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeDatadog, samples } from './fakes/datadog';
import { FakeGitHost, hostPr } from './fakes/git-host';
import { FakeProbe } from './fakes/probe';
import { tempDir } from './helpers';

/**
 * A list the page reads at every visit must stay quick and small however long the console has run. One daemon holds
 * the data of a console used for months, and every plain list answers inside a time and a size budget. The budgets are
 * far above what the lists take today, so only a change in kind fails: an unbounded column in the rows, a list that
 * stopped paging, a query that scans a table per row.
 */
const MAX_MS = 300;
const MAX_BYTES = 1_500_000;
/**
 * Lists that still send more. `/alerts` sends every Alert, about 860 bytes each, so 2000 of them are 1.7 MB: the
 * Monitor page's list is next to be paged and slimmed, and this entry goes then.
 */
const MAX_BYTES_FOR: Record<string, number> = { '/alerts': 2_500_000 };

const ALERTS = 2000;
const SERVICES = 40;
const ROUTES_PER_SERVICE = 10;
const SESSIONS = 200;
const PULL_REQUESTS = 100;

/** Plain reads: each takes no id and answers with `{ data }`, a list for most. */
const LISTS = [
  '/alerts',
  '/services',
  '/scans',
  '/repos',
  '/sessions?kind=repo&limit=100',
  '/sessions?kind=anonymous&limit=100',
  '/pull-requests',
  '/agent-runs',
  '/approvals',
  '/action-log',
  '/playbooks',
  '/skills',
  '/skill-packs',
  '/connectors',
  '/connections',
  '/mcp-servers',
  '/agent-accounts',
  '/network-allowlist',
];

let daemon: AgentDaemon;
let http: ReturnType<typeof api>;
let host: FakeGitHost;
// A check of the Connectors, which the list read starts, finds the operator signed in to GitHub.
const signedInTools = Object.assign(new FakeConnectorTools(), { github: 'octo-operator' });

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' });

/** A git folder whose origin is a GitHub repository, so the Repo is hosted and its pull requests are read. */
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

/** The 9 KB of Samples an Alert keeps: the column the list must not send. */
const SAMPLES = JSON.stringify(samples(25, 'NullPointerException in OrderService at com.acme.orders.Total.read'));

beforeAll(async () => {
  host = new FakeGitHost();
  // Set before the Repo is imported, which reads the host once and keeps the answer.
  host.prs = Array.from({ length: PULL_REQUESTS }, (_, n) =>
    hostPr(n + 1, {
      opened_at: new Date(Date.UTC(2026, 9, 1) + n * 3_600_000).toISOString(),
      body: 'Adds the thing, and the tests for it. '.repeat(20),
      branch: `feature-${n + 1}`,
    }),
  );
  daemon = await startAgentDaemon({
    fixtureKinds: false,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console' }),
      ConnectorsModule.forRoot({ tools: signedInTools }),
      ReposModule.forRoot(),
      WorkspaceModule.forRoot({ hosts: host }),
      ConnectionsModule.forRoot({ tester: new FakeConnectionTester(), launchDir: await tempDir() }),
      MonitorModule.forRoot({ datadog: new FakeDatadog(), codeHosts: new FakeCodeHosts() }),
    ],
  });
  http = api(daemon);
  const store = daemon.app.get<Store>(STORE);
  // The Repo's first read of its pull requests asks the host once and keeps the answer.
  store.write((tx) => {
    tx.update(connectors)
      .set({ status: HealthStatus.Ok, login: 'octo-operator' })
      .where(eq(connectors.id, ConnectorId.Github))
      .run();
  });
  const imported = await http.post('/repos', { path: await makeRepo() });
  const repoId: string = imported.body.data.id;
  store.write((tx) => {
    const routeIds: string[] = [];
    for (let s = 0; s < SERVICES; s++) {
      const serviceId = crypto.randomUUID();
      tx.insert(services)
        .values({ id: serviceId, name: `service-${s}`, env: 'prod', repoId: s === 0 ? repoId : null })
        .run();
      for (let r = 0; r < ROUTES_PER_SERVICE; r++) {
        const routeId = crypto.randomUUID();
        routeIds.push(routeId);
        tx.insert(routes)
          .values({ id: routeId, serviceId, method: 'GET', path: `/v1/items/${r}/:id` })
          .run();
      }
    }
    for (let a = 0; a < ALERTS; a++) {
      tx.insert(alerts)
        .values({
          id: crypto.randomUUID(),
          routeId: routeIds[a % routeIds.length] as string,
          fingerprint: `fingerprint-${a}`,
          httpStatus: 500,
          severity: 'low' as never,
          title: `GET /v1/items/${a}/:id fails`,
          logLine: 'NullPointerException in OrderService at com.acme.orders.Total.read(Total.java:42)',
          eventCount: 12,
          firstSeenAt: '2026-10-01T10:00:00.000Z',
          lastSeenAt: '2026-10-02T10:00:00.000Z',
          samples: SAMPLES,
          sourceQuery: 'env:prod service:orders-api @http.method:GET @http.url_details.path:/v1/items/:id status:error',
        })
        .run();
    }
    for (let n = 0; n < SESSIONS; n++) {
      tx.insert(sessions)
        .values({
          id: crypto.randomUUID(),
          kind: n % 2 === 0 ? SessionKind.Repo : SessionKind.Anonymous,
          title: `Session ${n}`,
          model: Model.Sonnet,
          effort: Effort.Medium,
          accessMode: AccessMode.Supervised,
          repoId: n % 2 === 0 ? repoId : null,
          branch: n % 2 === 0 ? `feature-${n}` : null,
          lastMessagePreview: 'Looks good. The change is in the branch and the tests pass.',
          lastActiveAt: new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString(),
        })
        .run();
    }
  });
  // The first read of a list warms the page cache, and the pull requests' first read asks the host.
  await Promise.all(LISTS.map((path) => http.get(path)));
});

afterAll(async () => {
  await daemon.stop();
});

describe('plain list budgets', () => {
  it.each(LISTS)('%s answers in time and in size', async (path) => {
    // The fastest of three reads is judged: a list that grew slow is slow every time, while a busy machine
    // (other test files run beside this one) slows only some.
    let fastest = Number.POSITIVE_INFINITY;
    let res = await http.get(path);
    for (let read = 0; read < 3; read++) {
      const started = performance.now();
      res = await http.get(path);
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(res.status, `${path} answered ${res.status}`).toBe(200);
    expect(res.body.data, `${path} answers data`).toBeTruthy();
    const bytes = Buffer.byteLength(res.text);
    expect(bytes, `${path} sent ${bytes} bytes`).toBeLessThan(MAX_BYTES_FOR[path] ?? MAX_BYTES);
    expect(fastest, `${path} took ${Math.round(fastest)} ms`).toBeLessThan(MAX_MS);
  });

  it('holds the seeded rows, so the budgets mean something', async () => {
    expect(ALERTS).toBeGreaterThan(1000);
    const alertList = await http.get('/alerts');
    expect(alertList.body.data.length).toBeGreaterThanOrEqual(1000);
    const pulls = await http.get('/pull-requests');
    expect(pulls.body.data.length).toBe(PULL_REQUESTS);
  });
});
