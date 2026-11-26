import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONNECTOR_ORDER, ConnectorId, ErrorCode, HealthStatus, McpTransport, type WsEvent } from '@ops-console/shared';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/errors';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { ConnectorsService } from '../src/connectors/connectors.service';
import { LoopbackGoogleAuth } from '../src/connectors/google-auth';
import { connectors } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { KEYCHAIN } from '../src/keychain/keychain';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { McpServersService } from '../src/mcp/mcp-servers.service';
import { type AgentDaemon, api, listen, signIn, startAgentDaemon, until } from './agent-fixtures';
import { FakeClaudeCredentials } from './fakes/claude-credentials';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeFolderPicker } from './fakes/folder-picker';
import { FakeGoogle } from './fakes/google';
import { FakeKeychain } from './fakes/keychain';
import { FakeGrafana } from './fakes/loki-logs';
import { FakeNerdGraph } from './fakes/nerdgraph';
import { FakeNewRelic } from './fakes/new-relic-logs';
import { FakeProbe } from './fakes/probe';

const running: AgentDaemon[] = [];
const googles: FakeGoogle[] = [];
/** The stand-ins for hosted servers a test started. */
const hostedServers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const google of googles.splice(0)) await google.close().catch(() => {});
  for (const server of hostedServers.splice(0)) await server.close().catch(() => {});
});

type Ctx = {
  daemon: AgentDaemon;
  tools: FakeConnectorTools;
  probe: FakeProbe;
  keychain: FakeKeychain;
  dirs: string[];
  /** The stand-in for Google, when the test asked for one. */
  google: FakeGoogle | null;
  /** What Claude Code stored for its MCP servers, and the folder dialog. */
  claude: FakeClaudeCredentials;
  folder: FakeFolderPicker;
  /** The stand-ins for Grafana Cloud and New Relic, when the test asked for them. */
  grafana: FakeGrafana;
  newrelic: FakeNewRelic;
  /** New Relic's regular API, for the User API key route. */
  nerdgraph: FakeNerdGraph;
};
type Row = Record<string, unknown> & { id: string; status: string };

/** `google`: Google is the stand-in, with a client the build ships or with none; `signInMs` shortens the wait for a sign-in. */
async function start(
  options: { google?: 'shipped' | 'none'; signInMs?: number; keychain?: FakeKeychain } = {},
): Promise<Ctx> {
  const tools = new FakeConnectorTools();
  const probe = new FakeProbe();
  const google = options.google === undefined ? null : await FakeGoogle.start();
  if (google) googles.push(google);
  const auth = google
    ? new LoopbackGoogleAuth(options.google === 'shipped' ? google.client : null, google.endpoints, options.signInMs)
    : undefined;
  const claude = new FakeClaudeCredentials();
  const folder = new FakeFolderPicker();
  const grafana = await FakeGrafana.start();
  const newrelic = await FakeNewRelic.start();
  const nerdgraph = await FakeNerdGraph.start();
  hostedServers.push(grafana, newrelic, nerdgraph);
  const daemon = await startAgentDaemon({
    ...(options.keychain ? { keychain: options.keychain } : {}),
    modules: [
      McpServersModule.forRoot({ probe, launcher: '/opt/ops-console' }),
      ConnectorsModule.forRoot({
        tools,
        google: auth,
        claudeCredentials: claude,
        folderPicker: folder,
        hosts: {
          grafana: grafana.url,
          newRelic: { US: newrelic.url, EU: newrelic.url, JP: newrelic.url },
          newRelicApi: { US: nerdgraph.url, EU: nerdgraph.url, JP: nerdgraph.url },
        },
        grafanaSignInMs: options.signInMs,
      }),
    ],
  });
  running.push(daemon);
  const added = await api(daemon).post('/agent-accounts');
  const second = path.join(daemon.dataDir, 'accounts', added.body.data.account.id);
  await signIn(second, 'second@example.com', 'pro');
  await api(daemon).post(`/agent-accounts/${added.body.data.account.id}/checks`);
  return {
    daemon,
    tools,
    probe,
    keychain: daemon.app.get<FakeKeychain>(KEYCHAIN),
    dirs: [daemon.home, second],
    google,
    claude,
    folder,
    grafana,
    newrelic,
    nerdgraph,
  };
}

const list = async (ctx: Ctx): Promise<Row[]> => (await api(ctx.daemon).get('/connectors')).body.data;
const one = async (ctx: Ctx, id: string): Promise<Row> => (await list(ctx)).find((row) => row.id === id) as Row;
/** Fake `claude mcp login <name>` processes of this test's accounts still running. */
const logins = async (ctx: Ctx, name: string): Promise<number> =>
  ctx.dirs.filter((dir) => {
    try {
      process.kill(Number(readFileSync(path.join(dir, `fake-mcp-login-${name}.pid`), 'utf8')), 0);
      return true;
    } catch {
      return false;
    }
  }).length;
const mcpServer = async (ctx: Ctx, name: string): Promise<Row | undefined> =>
  (await api(ctx.daemon).get('/mcp-servers')).body.data.find((s: Row) => s.name === name);
const checks = (events: WsEvent[]) =>
  events.flatMap((event) =>
    event.event === 'connection.checked' && event.data.target === 'connector' ? [event.data] : [],
  );

describe('listing', () => {
  it('returns every Connector in the fixed order, off, with their default config', async () => {
    const ctx = await start();
    const rows = await list(ctx);
    expect(rows.map((row) => row.id)).toEqual(CONNECTOR_ORDER);
    expect(rows.every((row) => row.status === 'off' && row.sign_in === null)).toBe(true);
    expect(rows[0]).toMatchObject({
      name: 'Datadog',
      via: 'pup CLI + datadog-pup MCP',
      config: { site: 'datadoghq.com', daily_scan_time: '09:00', rapid_errors_per_10m: 100 },
    });
  });

  it('checks a connected Connector again in the background when its last check is old', async () => {
    const ctx = await start();
    ctx.tools.github = 'octo-operator';
    await api(ctx.daemon).post('/connectors/github/checks');
    const store = ctx.daemon.app.get<Store>(STORE);
    const age = (minutes: number) => {
      store.write((tx) => {
        tx.update(connectors)
          .set({ lastCheckedAt: new Date(Date.now() - minutes * 60_000).toISOString() })
          .where(eq(connectors.id, ConnectorId.Github))
          .run();
      });
    };
    age(5);
    ctx.tools.github = null;
    await list(ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await one(ctx, 'github')).status).toBe('ok');

    age(11);
    await list(ctx);
    await until(
      () => one(ctx, 'github'),
      (row) => row.status === 'auth',
      'the background check',
    );
    // A Connector that is off is not checked.
    expect((await one(ctx, 'sentry')).last_checked_at).toBeNull();
  });
});

describe('connecting', () => {
  it('signs GitHub in through gh, then records the status, label and login', async () => {
    const ctx = await start();
    const { events, close } = await listen(ctx.daemon);
    expect((await api(ctx.daemon).post('/connectors/github/connect', {})).status).toBe(202);
    await until(
      () => one(ctx, 'github'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    close();
    expect(await one(ctx, 'github')).toMatchObject({ login: 'octo-operator', account_label: 'octo-operator' });
    expect(checks(events).at(-1)).toMatchObject({ id: 'github', status: 'ok' });
  });

  it("shows gh's one-time code and page while the sign-in waits, and clears them when it ends", async () => {
    const ctx = await start();
    ctx.tools.next = 'hang';
    await api(ctx.daemon).post('/connectors/github/connect', {});
    const waiting = await until(
      () => one(ctx, 'github'),
      (row) => row.sign_in !== null && (row.sign_in as { code: string | null }).code !== null,
      'the code',
    );
    expect(waiting.sign_in).toEqual({ code: 'WXYZ-1234', url: 'https://github.com/login/device' });

    ctx.tools.next = 'ok';
    await api(ctx.daemon).post('/connectors/github/connect', {});
    const done = await until(
      () => one(ctx, 'github'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    expect(done.login).toBe('octo-operator');
  });

  it('installs what GitHub needs and registers its MCP server with the gh token in the Keychain only', async () => {
    const ctx = await start();
    ctx.tools.missing = new Set(['gh', 'github-mcp-server']);
    await api(ctx.daemon).post('/connectors/github/connect', {});
    await until(
      () => one(ctx, 'github'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    expect(ctx.tools.brewed).toEqual(['gh', 'github-mcp-server']);
    // One `brew install` for both.
    expect(ctx.tools.brewCalls).toEqual([['gh', 'github-mcp-server']]);
    // The account reads connected first; the server registers right after.
    const server = await until(
      () => mcpServer(ctx, 'github'),
      (found) => found !== undefined,
      'the registration',
    );
    expect(server).toMatchObject({
      target: 'github-mcp-server stdio',
      used_by: 'github',
      env_keys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    });
    expect(JSON.parse(ctx.keychain.values.get('mcp:github') ?? '{}')).toEqual({
      GITHUB_PERSONAL_ACCESS_TOKEN: 'gho_example_token',
    });
  });

  it('says to install Homebrew when GitHub needs an install and brew is missing', async () => {
    const ctx = await start();
    ctx.tools.missing = new Set(['github-mcp-server', 'brew']);
    await api(ctx.daemon).post('/connectors/github/connect', {});
    const row = await until(
      () => one(ctx, 'github'),
      (row) => row.status === 'auth',
      'the refusal',
    );
    expect(row.status_detail).toContain('install Homebrew from brew.sh');
    expect(ctx.tools.brewed).toEqual([]);
  });

  it('registers the Shopify Dev MCP server with no sign-in', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/shopify/connect', {});
    await until(
      () => one(ctx, 'shopify'),
      (row) => row.status === 'ok',
      'the check',
    );
    const server = (await api(ctx.daemon).get('/mcp-servers')).body.data.find((s: Row) => s.name === 'shopify');
    expect(server).toMatchObject({ target: 'npx -y @shopify/dev-mcp@latest', used_by: 'shopify' });
  });

  it('turns the Shopify server back on when it was turned off in MCP servers', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/shopify/connect', {});
    await until(
      () => one(ctx, 'shopify'),
      (row) => row.status === 'ok',
      'the check',
    );
    await api(ctx.daemon).patch('/mcp-servers/shopify', { enabled: false });
    expect((await api(ctx.daemon).post('/connectors/shopify/checks', {})).body.data).toMatchObject({
      status: 'fail',
      status_detail: 'shopify is turned off in MCP servers',
    });

    await api(ctx.daemon).post('/connectors/shopify/connect', {});
    await until(
      () => one(ctx, 'shopify'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the check',
    );
    expect(await mcpServer(ctx, 'shopify')).toMatchObject({ enabled: true, status: 'ok' });
  });

  it('signs Datadog in and registers the datadog-pup server when this pup has one', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/datadog/connect', {});
    await until(
      () => one(ctx, 'datadog'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    expect((await one(ctx, 'datadog')).account_label).toBe('example-org');
    const server = await until(
      () => mcpServer(ctx, 'datadog-pup'),
      (found) => found !== undefined,
      'the registration',
    );
    expect(server).toMatchObject({ target: 'pup mcp serve', used_by: 'datadog' });
  });

  it('skips the datadog-pup server when pup cannot serve one', async () => {
    const ctx = await start();
    ctx.tools.datadogMcp = false;
    await api(ctx.daemon).post('/connectors/datadog/connect', {});
    await until(
      () => one(ctx, 'datadog'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    const names = (await api(ctx.daemon).get('/mcp-servers')).body.data.map((s: Row) => s.name);
    expect(names).not.toContain('datadog-pup');
  });

  it('registers the MCP server of a Jira Connector in every account and follows its status', async () => {
    const ctx = await start();
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'atlassian', { status: 'needs-auth' });
    await api(ctx.daemon).post('/connectors/jira/connect', {});
    await until(
      () => one(ctx, 'jira'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    const server = (await api(ctx.daemon).get('/mcp-servers')).body.data.find((s: Row) => s.name === 'atlassian');
    expect(server).toMatchObject({ transport: 'http', status: 'ok', used_by: 'jira' });
    // One browser sign-in per Connect: only the active account signs in.
    const [active, other] = ctx.dirs as [string, string];
    expect(existsSync(path.join(active, 'fake-mcp-auth.json'))).toBe(true);
    expect(existsSync(path.join(other, 'fake-mcp-auth.json'))).toBe(false);
  });

  it('moves a Connector with its MCP server between checks', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/jira/connect', {});
    await until(
      () => one(ctx, 'jira'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'atlassian', { status: 'failed', error: 'connection refused' });
    // A check answers at once and probes in the background, every account one after another.
    await api(ctx.daemon).post('/mcp-servers/atlassian/checks', {});
    await until(
      () => one(ctx, 'jira'),
      (row) => row.status === 'fail',
      'the failed check',
    );

    for (const dir of ctx.dirs) ctx.probe.set(dir, 'atlassian', { status: 'connected' });
    await api(ctx.daemon).post('/mcp-servers/atlassian/checks', {});
    const back = await until(
      () => one(ctx, 'jira'),
      (row) => row.status === 'ok',
      'the passing check',
    );
    expect(back).toMatchObject({ status: 'ok', status_detail: null });
  });

  it('connects slashdocs at once when its CLI is already signed in, opening no sign-in', async () => {
    const ctx = await start();
    ctx.tools.slashdocs = { email: 'operator@example.com', name: 'Operator' };
    await api(ctx.daemon).patch('/connectors/slashdocs', { config: { server: 'slashdocs.example.com' } });

    await api(ctx.daemon).post('/connectors/slashdocs/connect', {});
    const row = await until(
      () => one(ctx, 'slashdocs'),
      (found) => found.status === 'ok' && found.sign_in === null,
      'the check',
    );

    expect(row).toMatchObject({
      name: 'slashdocs',
      via: 'slashdocs CLI',
      login: 'operator@example.com',
      account_label: 'slashdocs.example.com',
    });
    expect(ctx.tools.slashdocsLogins).toEqual([]);
  });

  it('signs slashdocs in through its CLI to the server set, or the CLI’s own when blank', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/slashdocs/connect', {});
    await until(
      () => one(ctx, 'slashdocs'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    await api(ctx.daemon).delete('/connectors/slashdocs/credentials');
    ctx.tools.slashdocs = null;
    await api(ctx.daemon).patch('/connectors/slashdocs', { config: { server: 'slashdocs.example.com' } });
    await api(ctx.daemon).post('/connectors/slashdocs/connect', {});
    await until(
      () => one(ctx, 'slashdocs'),
      (row) => row.status === 'ok',
      'the second sign-in',
    );

    expect(ctx.tools.slashdocsLogins).toEqual([null, 'slashdocs.example.com']);
  });

  it('says to install slashdocs when its CLI is missing', async () => {
    const ctx = await start();
    ctx.tools.missing.add('slashdocs');
    await api(ctx.daemon).post('/connectors/slashdocs/connect', {});
    const row = await until(
      () => one(ctx, 'slashdocs'),
      (found) => found.status === 'auth',
      'the failed sign-in',
    );
    expect(row.status_detail).toBe('slashdocs is not installed: install the slashdocs CLI, then Connect again');
  });

  it("registers Slack's server with Slack's partner OAuth app, replacing one registered without it", async () => {
    const ctx = await start();
    const [active] = ctx.dirs as [string, string];
    // Registered before the OAuth app: Slack refuses its dynamic client registration.
    const config = JSON.parse(await readFile(path.join(active, '.claude.json'), 'utf8').catch(() => '{}'));
    config.mcpServers = {
      ...config.mcpServers,
      slack: { type: 'http', url: 'https://mcp.slack.com/mcp', headers: {} },
    };
    await writeFile(path.join(active, '.claude.json'), JSON.stringify(config));

    await api(ctx.daemon).post('/connectors/slack/connect', {});
    await until(
      () => one(ctx, 'slack'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );

    for (const dir of ctx.dirs) {
      const servers = JSON.parse(await readFile(path.join(dir, '.claude.json'), 'utf8')).mcpServers;
      expect(servers.slack).toMatchObject({
        type: 'http',
        url: 'https://mcp.slack.com/mcp',
        oauth: { clientId: '1601185624273.8899143856786', callbackPort: 3118 },
      });
    }
  });

  it('reads Slack connected while only an account that is not active needs its sign-in, and reads that account only once active', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/slack/connect', {});
    await until(
      () => one(ctx, 'slack'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    const [, other] = ctx.dirs as [string, string];
    ctx.probe.set(other, 'slack', { status: 'needs-auth' });
    const [active] = ctx.dirs as [string, string];
    const asked = ctx.probe.asked.length;
    await api(ctx.daemon).post('/mcp-servers/slack/checks', {});
    await until(
      async () => ctx.probe.asked.slice(asked),
      (found) => found.length > 0,
      'the check of the one server',
    );
    // Only the active account is asked, and only for that server.
    expect(new Set(ctx.probe.asked.slice(asked))).toEqual(new Set([active]));
    expect(await one(ctx, 'slack')).toMatchObject({ status: 'ok', status_detail: null });
  });

  it('signs GitLab in through the browser, installing glab first, and skips it when glab is signed in', async () => {
    const ctx = await start();
    ctx.tools.missing = new Set(['glab']);
    await api(ctx.daemon).post('/connectors/gitlab/connect', {});
    await until(
      () => one(ctx, 'gitlab'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    expect(ctx.tools.brewed).toEqual(['glab']);
    expect(ctx.tools.gitlabLogins).toEqual(['gitlab.com']);
    expect(await one(ctx, 'gitlab')).toMatchObject({ login: 'gl-operator', account_label: 'gitlab.com' });

    await api(ctx.daemon).post('/connectors/gitlab/connect', {});
    await until(
      () => one(ctx, 'gitlab'),
      (row) => row.sign_in === null,
      'the second connect',
    );
    expect(ctx.tools.gitlabLogins).toEqual(['gitlab.com']);
  });

  it('connects Bitbucket through bkt and the Atlassian server Jira shares, and Disconnect leaves it while one uses it', async () => {
    const ctx = await start();
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'atlassian', { status: 'needs-auth' });
    await api(ctx.daemon).post('/connectors/bitbucket/connect', {});
    const connected = await until(
      () => one(ctx, 'bitbucket'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    expect(connected).toMatchObject({ login: 'bb-operator', via: 'bkt CLI + Atlassian MCP' });
    await api(ctx.daemon).post('/connectors/jira/connect', {});
    await until(
      () => one(ctx, 'jira'),
      (row) => row.status === 'ok',
      'the Jira check',
    );

    await api(ctx.daemon).delete('/connectors/bitbucket/credentials');
    const server = async () =>
      (await api(ctx.daemon).get('/mcp-servers')).body.data.find((s: Row) => s.name === 'atlassian');
    expect(await server()).toMatchObject({ registered: true });
    await api(ctx.daemon).delete('/connectors/jira/credentials');
    await ctx.daemon.app.get(McpServersService).settled();
    expect(await server()).toMatchObject({ registered: false });
  });

  it('registers the Atlassian server at its v2 address, and moves a v1 registration there when Jira connects again (Behavior 9, 10)', async () => {
    const ctx = await start();
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'atlassian', { status: 'needs-auth' });
    const atlassianUrls = () =>
      ctx.dirs.map((dir) => {
        const file = path.join(dir, '.claude.json');
        return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).mcpServers?.atlassian?.url : undefined;
      });
    const mcp = ctx.daemon.app.get(McpServersService);
    // Registered before Atlassian's v2, as an operator who connected Jira last month has it.
    await mcp.ensureRegistered({
      name: 'atlassian',
      transport: McpTransport.Http,
      target: 'https://mcp.atlassian.com/v1/mcp',
    });
    expect(atlassianUrls().filter(Boolean)).not.toEqual([]);
    for (const url of atlassianUrls().filter(Boolean)) expect(url).toBe('https://mcp.atlassian.com/v1/mcp');

    await api(ctx.daemon).post('/connectors/jira/connect', {});
    await until(
      () => atlassianUrls().filter(Boolean),
      (urls) => urls.length > 0 && urls.every((url) => url === 'https://mcp.atlassian.com/v2/mcp'),
      'the server at the v2 address',
    );
  });

  it('leaves a registration at the current address alone, a closing slash aside (Behavior 10)', async () => {
    const ctx = await start();
    const mcp = ctx.daemon.app.get(McpServersService);
    const spec = { name: 'atlassian', transport: McpTransport.Http, target: 'https://mcp.atlassian.com/v2/mcp' };
    expect(await mcp.ensureRegistered(spec)).toBe(true);
    expect(await mcp.ensureRegistered(spec)).toBe(false);
    expect(await mcp.ensureRegistered({ ...spec, target: `${spec.target}/` })).toBe(false);
  });

  it('leaves auth with the reason when the sign-in fails', async () => {
    const ctx = await start();
    ctx.tools.next = 'fail';
    await api(ctx.daemon).post('/connectors/github/connect', {});
    const failed = await until(
      () => one(ctx, 'github'),
      (row) => row.status === 'auth',
      'the failure',
    );
    expect(failed.status_detail).toBe('`login` failed');
  });

  it("leaves auth with Claude Code's reason when an MCP Server sign-in fails", async () => {
    const ctx = await start();
    process.env.FAKE_MCP_LOGIN = 'fail';
    try {
      for (const dir of ctx.dirs) ctx.probe.set(dir, 'slack', { status: 'needs-auth' });
      await api(ctx.daemon).post('/connectors/slack/connect', {});
      const failed = await until(
        () => one(ctx, 'slack'),
        (row) => row.status === 'auth' && row.sign_in === null && row.status_detail !== null,
        'the failure',
      );
      expect(failed.status_detail).toContain('Incompatible auth server');
    } finally {
      delete process.env.FAKE_MCP_LOGIN;
    }
  });

  it('keeps the sign-in failure when a slower check started before it', async () => {
    const ctx = await start();
    process.env.FAKE_MCP_LOGIN = 'fail';
    try {
      for (const dir of ctx.dirs) ctx.probe.set(dir, 'slack', { status: 'needs-auth' });
      await api(ctx.daemon).post('/connectors/slack/connect', {});
      await until(
        () => one(ctx, 'slack'),
        (row) => row.sign_in === null,
        'the first sign-in',
      );
      ctx.probe.delayMs = 1_500;
      // A request is sent once something waits on it.
      const slowCheck = api(ctx.daemon)
        .post('/connectors/slack/checks')
        .then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await api(ctx.daemon).post('/connectors/slack/connect', {});
      await until(
        () => one(ctx, 'slack'),
        (row) => row.sign_in === null && String(row.status_detail ?? '').includes('Incompatible'),
        'the failure',
      );
      await slowCheck;
      expect((await one(ctx, 'slack')).status_detail).toContain('Incompatible auth server');
    } finally {
      delete process.env.FAKE_MCP_LOGIN;
    }
  });

  it('reads a tool that does not answer as fail', async () => {
    const ctx = await start();
    ctx.tools.down = true;
    const checked = await api(ctx.daemon).post('/connectors/github/checks');
    expect(checked.body.data).toMatchObject({ status: 'fail', login: null });
  });
});

describe('config', () => {
  it('names the bad fields and saves nothing', async () => {
    const ctx = await start();
    const bad = await api(ctx.daemon).patch('/connectors/datadog', {
      config: { rapid_errors_per_10m: 'lots', daily_scan_time: '9am', reports_folder: 'elsewhere' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(bad.body.error.message).toContain('rapid_errors_per_10m');
    expect(bad.body.error.message).toContain('daily_scan_time');
    expect((await one(ctx, 'datadog')).config).toMatchObject({ reports_folder: 'reports' });
  });

  it('keeps blank fields and merges nested ones', async () => {
    const ctx = await start();
    const saved = await api(ctx.daemon).patch('/connectors/jira', {
      config: { site: 'example.atlassian.net', project_key: '', issue_types: { bug: 'Defect' } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.config).toMatchObject({
      site: 'example.atlassian.net',
      project_key: '',
      issue_types: { bug: 'Defect', improvement: 'Improvement' },
      in_review_status: 'In Review',
    });
    const unknown = await api(ctx.daemon).patch('/connectors/jira', { config: { nope: 1 } });
    expect(unknown.status).toBe(400);
    const secret = await api(ctx.daemon).patch('/connectors/loki_logs', { config: { secret: 'glc_example_secret' } });
    expect(secret.status).toBe(400);
    expect(JSON.stringify(await one(ctx, 'loki_logs'))).not.toContain('glc_example_secret');
    const key = await api(ctx.daemon).patch('/connectors/new_relic_logs', { config: { secret: 'NRAK-EXAMPLE' } });
    expect(key.status).toBe(400);
    expect(JSON.stringify(await one(ctx, 'new_relic_logs'))).not.toContain('NRAK-EXAMPLE');
  });
});

describe('disconnecting', () => {
  it('clears the login, removes the MCP server, and leaves the CLIs signed in', async () => {
    const ctx = await start();
    ctx.tools.datadog = { signedIn: true, org: 'example-org' };
    await api(ctx.daemon).post('/connectors/datadog/connect', {});
    await until(
      () => one(ctx, 'datadog'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    await until(
      () => mcpServer(ctx, 'datadog-pup'),
      (found) => found?.registered === true,
      'the registration',
    );
    const off = await api(ctx.daemon).delete('/connectors/datadog/credentials');
    expect(off.body, `HTTP ${off.status}`).toMatchObject({ data: { status: 'off', login: null, account_label: null } });
    const server = (await api(ctx.daemon).get('/mcp-servers')).body.data.find((s: Row) => s.name === 'datadog-pup');
    expect(server).toMatchObject({ registered: false });
    expect(ctx.tools.datadog.signedIn).toBe(true);

    await api(ctx.daemon).post('/connectors/gitlab/connect', {});
    await until(
      () => one(ctx, 'gitlab'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    const gone = await api(ctx.daemon).delete('/connectors/gitlab/credentials');
    expect(gone.body.data).toMatchObject({ status: 'off', login: null });
    expect(ctx.tools.gitlab).toBe('gl-operator');
  });

  it('still disconnects when the MCP server is gone from the list by the time it is removed', async () => {
    const ctx = await start();
    ctx.tools.datadog = { signedIn: true, org: 'example-org' };
    await api(ctx.daemon).post('/connectors/datadog/connect', {});
    await until(
      () => mcpServer(ctx, 'datadog-pup'),
      (found) => found?.registered === true,
      'the registration',
    );
    const mcp = ctx.daemon.app.get(McpServersService);
    mcp.remove = async (name: string) => {
      throw new ApiError(404, ErrorCode.NotFound, `no MCP server named ${name}`);
    };
    const off = await api(ctx.daemon).delete('/connectors/datadog/credentials');
    expect(off.body, `HTTP ${off.status}`).toMatchObject({ data: { status: 'off', login: null } });
  });

  it('opens the sign-in of a server it just registered at once, and Disconnect stops it', async () => {
    const ctx = await start();
    process.env.FAKE_MCP_LOGIN = 'hang';
    try {
      const reads = ctx.probe.ones;
      await api(ctx.daemon).post('/connectors/sentry/connect', {});
      await until(
        () => logins(ctx, 'sentry'),
        (count) => count === 1,
        'claude mcp login',
      );
      // No one-server read ran first: the new registration holds no sign-in.
      expect(ctx.probe.ones).toBe(reads);
      await api(ctx.daemon).delete('/connectors/sentry/credentials');
      await until(
        () => logins(ctx, 'sentry'),
        (count) => count === 0,
        'the login to stop',
      );
    } finally {
      delete process.env.FAKE_MCP_LOGIN;
    }
  });

  it('Cancel stops a sign-in still waiting on the browser and leaves the Connector as it was', async () => {
    const ctx = await start();
    ctx.tools.next = 'hang';
    await api(ctx.daemon).post('/connectors/github/connect', {});
    await until(
      () => one(ctx, 'github'),
      (row) => row.sign_in !== null,
      'the sign-in',
    );
    const cancelled = await api(ctx.daemon).delete('/connectors/github/sign-in');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'off', status_detail: null, sign_in: null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await one(ctx, 'github')).toMatchObject({ status: 'off', sign_in: null });

    // Nothing to stop: the Connector answers as it is.
    expect((await api(ctx.daemon).delete('/connectors/github/sign-in')).body.data).toMatchObject({ status: 'off' });
  });

  it("Cancel stops Claude Code's MCP sign-in and keeps a connected Connector connected", async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/jira/connect', {});
    await until(
      () => one(ctx, 'jira'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the first sign-in',
    );
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'atlassian', { status: 'needs-auth' });
    await rm(path.join(ctx.dirs[0] ?? '', 'fake-mcp-auth.json'), { force: true });
    // The sign-in expired: a check reads it before the operator presses Connect again.
    await api(ctx.daemon).post('/mcp-servers/atlassian/checks', {});
    await until(
      async () => (await api(ctx.daemon).get('/mcp-servers')).body.data.find((s: Row) => s.name === 'atlassian'),
      (server) => server?.status === 'auth',
      'the expired sign-in',
    );
    process.env.FAKE_MCP_LOGIN = 'hang';
    try {
      await api(ctx.daemon).post('/connectors/jira/connect', {});
      await until(
        () => logins(ctx, 'atlassian'),
        (count) => count === 1,
        'claude mcp login',
      );
      const cancelled = await api(ctx.daemon).delete('/connectors/jira/sign-in');
      expect(cancelled.body.data).toMatchObject({ status: 'ok', sign_in: null });
      await until(
        () => logins(ctx, 'atlassian'),
        (count) => count === 0,
        'the login to stop',
      );
    } finally {
      delete process.env.FAKE_MCP_LOGIN;
    }
  });

  it('stops a sign-in still waiting on the browser', async () => {
    const ctx = await start();
    ctx.tools.next = 'hang';
    await api(ctx.daemon).post('/connectors/github/connect', {});
    await api(ctx.daemon).delete('/connectors/github/credentials');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await one(ctx, 'github')).status).toBe('off');
  });
});

describe('needing a Connector', () => {
  it('refuses an action whose Connector is not ok, naming it', async () => {
    const ctx = await start();
    const service = ctx.daemon.app.get(ConnectorsService);
    expect(() => service.require(ConnectorId.Github)).toThrowError(
      expect.objectContaining({ status: 409, code: 'connector_not_connected', message: 'GitHub is not connected' }),
    );
    ctx.tools.github = 'octo-operator';
    await api(ctx.daemon).post('/connectors/github/checks');
    expect(() => service.require(ConnectorId.Github)).not.toThrow();
  });
});

describe('secrets', () => {
  it('shows no token in a response, an event or the log', async () => {
    const ctx = await start();
    const { events, close } = await listen(ctx.daemon);
    const responses = [(await api(ctx.daemon).post('/connectors/github/connect', {})).body];
    await until(
      () => one(ctx, 'github'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    responses.push(await list(ctx), (await api(ctx.daemon).post('/connectors/github/checks')).body);
    close();
    expect(JSON.stringify([responses, events, ctx.daemon.log])).not.toContain('gho_example_token');
  });
});

describe('Google Connectors', () => {
  const GOOGLE = ['google_docs', 'google_sheets', 'google_drive'];
  const status = (ctx: Ctx, id: string, want: string) =>
    until(
      () => one(ctx, id),
      (row) => row.status === want && row.sign_in === null,
      `${id} ${want}`,
    );
  /** The operator in the browser: waits for the Connector's Google page, then goes through Google's chooser. */
  const signInAs = async (ctx: Ctx, id: string, email = 'operator@example.com') => {
    const google = ctx.google as FakeGoogle;
    google.email = email;
    const waiting = await until(
      () => one(ctx, id),
      (row) => (row.sign_in as { url: string | null } | null)?.url != null,
      'the waiting sign-in',
    );
    await google.visit((waiting.sign_in as { url: string }).url);
    await status(ctx, id, 'ok');
  };
  const registered = (ctx: Ctx, name: string) =>
    ctx.dirs.map((dir) => JSON.parse(readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers?.[name]);

  it('lists the three after slashdocs, off, with an empty config', async () => {
    const ctx = await start({ google: 'shipped' });
    const rows = await list(ctx);
    expect(rows).toHaveLength(19);
    expect(rows.slice(-10, -7).map((row) => [row.id, row.name, row.via, row.status, row.config])).toEqual([
      ['google_docs', 'Google Docs', 'Google Docs API', 'off', {}],
      ['google_sheets', 'Google Sheets', 'Google Sheets API', 'off', {}],
      ['google_drive', 'Google Drive', 'Google Drive API', 'off', {}],
    ]);
    expect(rows.map((row) => row.id).slice(-11)).toEqual([
      'slashdocs',
      ...GOOGLE,
      'otel_logs',
      'cloudwatch_logs',
      'loki_logs',
      'new_relic_logs',
      'figma',
      'notion',
      'shortcut',
    ]);
    // Nothing is typed in the pane.
    expect((await api(ctx.daemon).patch('/connectors/google_docs', { config: { client_id: 'x' } })).status).toBe(400);
  });

  it("opens Google's chooser, waits, and connects as the account the operator picks in every Claude account", async () => {
    const ctx = await start({ google: 'shipped' });
    const google = ctx.google as FakeGoogle;
    const { events, close } = await listen(ctx.daemon);
    expect((await api(ctx.daemon).post('/connectors/google_docs/connect', {})).status).toBe(202);
    const waiting = await until(
      () => one(ctx, 'google_docs'),
      (row) => (row.sign_in as { url: string | null } | null)?.url != null,
      'the waiting sign-in',
    );
    const url = (waiting.sign_in as { code: string | null; url: string }).url;
    expect(waiting.sign_in).toEqual({ code: null, url });
    expect(url.startsWith(google.endpoints.auth)).toBe(true);
    expect(ctx.tools.opened).toEqual([url]);

    await google.visit(url);
    await status(ctx, 'google_docs', 'ok');
    close();
    expect(await one(ctx, 'google_docs')).toMatchObject({
      account_label: 'operator@example.com',
      login: 'operator@example.com',
      status_detail: null,
    });
    expect(
      checks(events)
        .filter((event) => event.id === 'google_docs')
        .at(-1),
    ).toMatchObject({ status: 'ok' });
    // Docs' scopes only, and the account chooser.
    const asked = new URL(url).searchParams;
    expect(google.scopes[0]).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/documents']);
    expect(asked.get('prompt')).toContain('select_account');
    expect(asked.get('code_challenge_method')).toBe('S256');

    // The bridge is registered in every Claude account, wrapped by the launcher, with the sign-in only in the Keychain.
    for (const entry of registered(ctx, 'google-docs')) {
      expect(entry).toMatchObject({
        command: '/opt/ops-console',
        args: ['mcp-exec', 'google-docs', '--', '/opt/ops-console', 'google-mcp', 'docs'],
      });
    }
    const env = JSON.parse((await ctx.keychain.get('mcp:google-docs')) as string);
    expect(env).toEqual({
      GOOGLE_CLIENT_ID: google.client.clientId,
      GOOGLE_CLIENT_SECRET: google.client.clientSecret,
      GOOGLE_REFRESH_TOKEN: google.refreshToken,
    });
    for (const dir of ctx.dirs) {
      expect(readFileSync(path.join(dir, '.claude.json'), 'utf8')).not.toContain(env.GOOGLE_REFRESH_TOKEN);
    }
  });

  it('signs each Connector in on its own, as a different Google account, and two may wait at once', async () => {
    const ctx = await start({ google: 'shipped' });
    await api(ctx.daemon).post('/connectors/google_sheets/connect', {});
    await api(ctx.daemon).post('/connectors/google_drive/connect', {});
    await signInAs(ctx, 'google_drive', 'drive@example.com');
    await signInAs(ctx, 'google_sheets', 'sheets@example.com');
    expect(await one(ctx, 'google_sheets')).toMatchObject({ login: 'sheets@example.com' });
    expect(await one(ctx, 'google_drive')).toMatchObject({ login: 'drive@example.com' });
    expect((await one(ctx, 'google_docs')).status).toBe('off');
    expect(registered(ctx, 'google-docs').every((entry) => entry === undefined)).toBe(true);
    expect((ctx.google as FakeGoogle).scopes.map((scopes) => scopes[2])).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets',
    ]);
  });

  it('Cancel stops one wait and keeps the status the Connector had', async () => {
    const ctx = await start({ google: 'shipped' });
    await api(ctx.daemon).post('/connectors/google_docs/connect', {});
    await until(
      () => one(ctx, 'google_docs'),
      (row) => row.sign_in !== null,
      'the waiting sign-in',
    );
    const cancelled = await api(ctx.daemon).delete('/connectors/google_docs/sign-in');
    expect(cancelled.body.data).toMatchObject({ status: 'off', sign_in: null });
    // Connect starts the wait again, and a Google page opened for the first one no longer finishes anything.
    const first = ctx.tools.opened[0] as string;
    await api(ctx.daemon).post('/connectors/google_docs/connect', {});
    await signInAs(ctx, 'google_docs');
    expect(ctx.tools.opened).toHaveLength(2);
    expect(ctx.tools.opened[1]).not.toBe(first);
  });

  it('ends auth with the reason when the operator declines, and when 5 minutes pass', async () => {
    const ctx = await start({ google: 'shipped', signInMs: 400 });
    const google = ctx.google as FakeGoogle;
    google.deny = true;
    await api(ctx.daemon).post('/connectors/google_sheets/connect', {});
    const waiting = await until(
      () => one(ctx, 'google_sheets'),
      (row) => (row.sign_in as { url: string | null } | null)?.url != null,
      'the waiting sign-in',
    );
    await google.visit((waiting.sign_in as { url: string }).url);
    expect(await status(ctx, 'google_sheets', 'auth')).toMatchObject({
      status_detail: 'Google did not sign in: access_denied',
    });

    await api(ctx.daemon).post('/connectors/google_docs/connect', {});
    expect(await status(ctx, 'google_docs', 'auth')).toMatchObject({
      status_detail: 'Google Docs sign-in did not finish within 5 minutes',
    });
  });

  it('ends auth when the build ships no Google client', async () => {
    const ctx = await start({ google: 'none' });
    await api(ctx.daemon).post('/connectors/google_drive/connect', {});
    expect(await status(ctx, 'google_drive', 'auth')).toMatchObject({
      status_detail: 'Google sign-in is not set up in this build',
    });
    expect(ctx.tools.opened).toEqual([]);
  });

  it('checks by minting a token: connected, needing sign-in after Google refuses it, or failing when Google is silent', async () => {
    const ctx = await start({ google: 'shipped' });
    const google = ctx.google as FakeGoogle;
    await api(ctx.daemon).post('/connectors/google_docs/connect', {});
    await signInAs(ctx, 'google_docs');
    expect((await api(ctx.daemon).post('/connectors/google_docs/checks')).body.data).toMatchObject({
      status: 'ok',
      account_label: 'operator@example.com',
    });

    google.revoke(google.refreshToken as string);
    expect((await api(ctx.daemon).post('/connectors/google_docs/checks')).body.data).toMatchObject({
      status: 'auth',
      status_detail: 'Google Docs needs signing in again',
    });

    // A Google that does not answer is a failure, not a sign-in to redo.
    await api(ctx.daemon).post('/connectors/google_sheets/connect', {});
    await signInAs(ctx, 'google_sheets');
    await google.close();
    expect((await api(ctx.daemon).post('/connectors/google_sheets/checks')).body.data).toMatchObject({
      status: 'fail',
    });
  });

  it('disconnects one Connector: Google takes access back, every account drops the server, the others stay', async () => {
    const ctx = await start({ google: 'shipped' });
    const google = ctx.google as FakeGoogle;
    for (const id of ['google_docs', 'google_sheets']) {
      await api(ctx.daemon).post(`/connectors/${id}/connect`, {});
      await signInAs(ctx, id, `${id}@example.com`);
    }
    const token = JSON.parse((await ctx.keychain.get('mcp:google-docs')) as string).GOOGLE_REFRESH_TOKEN as string;

    const first = await api(ctx.daemon).delete('/connectors/google_docs/credentials');
    expect(first.body.data).toMatchObject({ status: 'off', status_detail: null, account_label: null, login: null });
    expect(google.revoked.has(token)).toBe(true);
    // The server leaves every account in the background.
    await ctx.daemon.app.get(McpServersService).settled();
    expect(await ctx.keychain.get('mcp:google-docs')).toBeNull();
    expect(registered(ctx, 'google-docs').every((entry) => entry === undefined)).toBe(true);
    expect(await one(ctx, 'google_sheets')).toMatchObject({ status: 'ok' });
    expect(registered(ctx, 'google-sheets').every((entry) => entry !== undefined)).toBe(true);
  });

  it('checks a connected Google Connector again in the background when its last check is old', async () => {
    const ctx = await start({ google: 'shipped' });
    const google = ctx.google as FakeGoogle;
    await api(ctx.daemon).post('/connectors/google_docs/connect', {});
    await signInAs(ctx, 'google_docs');
    google.revoke(google.refreshToken as string);
    ctx.daemon.app.get<Store>(STORE).write((tx) => {
      tx.update(connectors)
        .set({ lastCheckedAt: new Date(Date.now() - 11 * 60_000).toISOString() })
        .where(eq(connectors.id, ConnectorId.GoogleDocs))
        .run();
    });
    await list(ctx);
    await until(
      () => one(ctx, 'google_docs'),
      (row) => row.status === 'auth',
      'the background check',
    );
  });

  it('keeps Google from signing a second Connector out: no revoke while another uses the same account', async () => {
    const ctx = await start({ google: 'shipped' });
    const google = ctx.google as FakeGoogle;
    for (const id of ['google_docs', 'google_sheets']) {
      await api(ctx.daemon).post(`/connectors/${id}/connect`, {});
      await signInAs(ctx, id, 'same@example.com');
    }
    await api(ctx.daemon).delete('/connectors/google_docs/credentials');
    expect(google.revoked.size).toBe(0);
    // The last Connector on the account takes the access back.
    await api(ctx.daemon).delete('/connectors/google_sheets/credentials');
    expect(google.revoked.size).toBe(1);
  });

  it('disconnects even when Google does not answer', async () => {
    const ctx = await start({ google: 'shipped' });
    await api(ctx.daemon).post('/connectors/google_docs/connect', {});
    await signInAs(ctx, 'google_docs');
    await (ctx.google as FakeGoogle).close();
    expect((await api(ctx.daemon).delete('/connectors/google_docs/credentials')).body.data).toMatchObject({
      status: 'off',
    });
  });

  it("leaves Slack's sign-in as it was", async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/slack/connect', {});
    await until(
      () => one(ctx, 'slack'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    const servers = JSON.parse(await readFile(path.join(ctx.dirs[0] as string, '.claude.json'), 'utf8')).mcpServers;
    expect(servers.slack.oauth).toEqual({ clientId: '1601185624273.8899143856786', callbackPort: 3118 });
  });
});

describe('Figma Connector', () => {
  const serverIn = (dir: string) => JSON.parse(readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers?.figma;

  it('lists Figma after the log sources, off, with an empty config that takes no field', async () => {
    const ctx = await start();
    expect((await list(ctx)).at(-3)).toMatchObject({
      id: 'figma',
      name: 'Figma',
      via: 'Figma MCP',
      status: 'off',
      config: {},
    });
    const bad = await api(ctx.daemon).patch('/connectors/figma', { config: { file: 'abc' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
  });

  it("registers Figma's hosted server in every account with no body, signs in once, and follows the server", async () => {
    const ctx = await start();
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'figma', { status: 'needs-auth' });
    expect((await api(ctx.daemon).post('/connectors/figma/connect', {})).status).toBe(202);
    await until(
      () => one(ctx, 'figma'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    for (const dir of ctx.dirs) {
      expect(serverIn(dir)).toMatchObject({ type: 'http', url: 'https://mcp.figma.com/mcp' });
      // Figma's client is not on the console's side: nothing is pinned for the sign-in.
      expect(serverIn(dir).oauth).toBeUndefined();
    }
    expect(await mcpServer(ctx, 'figma')).toMatchObject({ transport: 'http', used_by: 'figma' });
    const [active, other] = ctx.dirs as [string, string];
    expect(existsSync(path.join(active, 'fake-mcp-auth.json'))).toBe(true);
    expect(existsSync(path.join(other, 'fake-mcp-auth.json'))).toBe(false);

    for (const dir of ctx.dirs) ctx.probe.set(dir, 'figma', { status: 'failed', error: 'connection refused' });
    await api(ctx.daemon).post('/mcp-servers/figma/checks', {});
    await until(
      () => one(ctx, 'figma'),
      (row) => row.status === 'fail',
      'the failed check',
    );
  });

  it("leaves auth with Figma's reason when it refuses the sign-in, and Connect tries again", async () => {
    const ctx = await start();
    process.env.FAKE_MCP_LOGIN = 'fail';
    try {
      for (const dir of ctx.dirs) ctx.probe.set(dir, 'figma', { status: 'needs-auth' });
      await api(ctx.daemon).post('/connectors/figma/connect', {});
      const failed = await until(
        () => one(ctx, 'figma'),
        (row) => row.status === 'auth' && row.sign_in === null && row.status_detail !== null,
        'the refusal',
      );
      expect(failed.status_detail).toContain('Incompatible auth server');
    } finally {
      delete process.env.FAKE_MCP_LOGIN;
    }
    await api(ctx.daemon).post('/connectors/figma/connect', {});
    await until(
      () => one(ctx, 'figma'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the second sign-in',
    );
  });

  it('reads fail when the server is turned off, and Connect turns it back on', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/figma/connect', {});
    await until(
      () => one(ctx, 'figma'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    await api(ctx.daemon).patch('/mcp-servers/figma', { enabled: false });
    expect((await api(ctx.daemon).post('/connectors/figma/checks', {})).body.data).toMatchObject({
      status: 'fail',
      status_detail: 'figma is turned off in MCP servers',
    });
    await api(ctx.daemon).post('/connectors/figma/connect', {});
    await until(
      () => one(ctx, 'figma'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in again',
    );
    expect(await mcpServer(ctx, 'figma')).toMatchObject({ enabled: true });
  });

  it('removes the server on Disconnect and leaves the other Connectors as they were', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/jira/connect', {});
    await api(ctx.daemon).post('/connectors/figma/connect', {});
    for (const id of ['jira', 'figma']) {
      await until(
        () => one(ctx, id),
        (row) => row.status === 'ok' && row.sign_in === null,
        `the ${id} sign-in`,
      );
    }
    const off = await api(ctx.daemon).delete('/connectors/figma/credentials');
    expect(off.body.data).toMatchObject({ status: 'off', login: null, account_label: null });
    expect(await mcpServer(ctx, 'figma')).toMatchObject({ registered: false });
    expect(await mcpServer(ctx, 'atlassian')).toMatchObject({ registered: true });
    expect((await one(ctx, 'jira')).status).toBe('ok');
  });
});

describe('Notion Connector', () => {
  const serverIn = (dir: string) => JSON.parse(readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers?.notion;

  it('lists Notion before Shortcut, off, with an empty config that takes no field', async () => {
    const ctx = await start();
    expect((await list(ctx)).at(-2)).toMatchObject({
      id: 'notion',
      name: 'Notion',
      via: 'Notion MCP',
      status: 'off',
      config: {},
    });
    const bad = await api(ctx.daemon).patch('/connectors/notion', { config: { file: 'abc' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
  });

  it("registers Notion's hosted server in every account with no body, signs in once, and follows the server", async () => {
    const ctx = await start();
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'notion', { status: 'needs-auth' });
    expect((await api(ctx.daemon).post('/connectors/notion/connect', {})).status).toBe(202);
    await until(
      () => one(ctx, 'notion'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    for (const dir of ctx.dirs) {
      expect(serverIn(dir)).toMatchObject({ type: 'http', url: 'https://mcp.notion.com/mcp' });
      // Notion registers its own OAuth client: nothing is pinned for the sign-in.
      expect(serverIn(dir).oauth).toBeUndefined();
    }
    expect(await mcpServer(ctx, 'notion')).toMatchObject({ transport: 'http', used_by: 'notion' });
    const [active, other] = ctx.dirs as [string, string];
    expect(existsSync(path.join(active, 'fake-mcp-auth.json'))).toBe(true);
    expect(existsSync(path.join(other, 'fake-mcp-auth.json'))).toBe(false);

    for (const dir of ctx.dirs) ctx.probe.set(dir, 'notion', { status: 'failed', error: 'connection refused' });
    await api(ctx.daemon).post('/mcp-servers/notion/checks', {});
    await until(
      () => one(ctx, 'notion'),
      (row) => row.status === 'fail',
      'the failed check',
    );
  });

  it("leaves auth with Notion's reason when it refuses the sign-in, and Connect tries again", async () => {
    const ctx = await start();
    process.env.FAKE_MCP_LOGIN = 'fail';
    try {
      for (const dir of ctx.dirs) ctx.probe.set(dir, 'notion', { status: 'needs-auth' });
      await api(ctx.daemon).post('/connectors/notion/connect', {});
      const failed = await until(
        () => one(ctx, 'notion'),
        (row) => row.status === 'auth' && row.sign_in === null && row.status_detail !== null,
        'the refusal',
      );
      expect(failed.status_detail).toContain('Incompatible auth server');
    } finally {
      delete process.env.FAKE_MCP_LOGIN;
    }
    await api(ctx.daemon).post('/connectors/notion/connect', {});
    await until(
      () => one(ctx, 'notion'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the second sign-in',
    );
  });

  it('reads fail when the server is turned off, and Connect turns it back on', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/notion/connect', {});
    await until(
      () => one(ctx, 'notion'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    await api(ctx.daemon).patch('/mcp-servers/notion', { enabled: false });
    expect((await api(ctx.daemon).post('/connectors/notion/checks', {})).body.data).toMatchObject({
      status: 'fail',
      status_detail: 'notion is turned off in MCP servers',
    });
    await api(ctx.daemon).post('/connectors/notion/connect', {});
    await until(
      () => one(ctx, 'notion'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in again',
    );
    expect(await mcpServer(ctx, 'notion')).toMatchObject({ enabled: true });
  });

  it('removes the server on Disconnect and leaves the other Connectors as they were', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/jira/connect', {});
    await api(ctx.daemon).post('/connectors/notion/connect', {});
    for (const id of ['jira', 'notion']) {
      await until(
        () => one(ctx, id),
        (row) => row.status === 'ok' && row.sign_in === null,
        `the ${id} sign-in`,
      );
    }
    const off = await api(ctx.daemon).delete('/connectors/notion/credentials');
    expect(off.body.data).toMatchObject({ status: 'off', login: null, account_label: null });
    expect(await mcpServer(ctx, 'notion')).toMatchObject({ registered: false });
    expect(await mcpServer(ctx, 'atlassian')).toMatchObject({ registered: true });
    expect((await one(ctx, 'jira')).status).toBe('ok');
  });
});

describe('Shortcut Connector', () => {
  const serverIn = (dir: string) =>
    JSON.parse(readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers?.shortcut;

  it('lists Shortcut last, off, with an empty config that takes no field', async () => {
    const ctx = await start();
    expect((await list(ctx)).at(-1)).toMatchObject({
      id: 'shortcut',
      name: 'Shortcut',
      via: 'Shortcut MCP',
      status: 'off',
      config: {},
    });
    const bad = await api(ctx.daemon).patch('/connectors/shortcut', { config: { file: 'abc' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
  });

  it("registers Shortcut's hosted server in every account with no body, signs in once, and follows the server", async () => {
    const ctx = await start();
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'shortcut', { status: 'needs-auth' });
    expect((await api(ctx.daemon).post('/connectors/shortcut/connect', {})).status).toBe(202);
    await until(
      () => one(ctx, 'shortcut'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    for (const dir of ctx.dirs) {
      expect(serverIn(dir)).toMatchObject({ type: 'http', url: 'https://mcp.shortcut.com/mcp' });
      // Shortcut registers its own OAuth client: nothing is pinned for the sign-in.
      expect(serverIn(dir).oauth).toBeUndefined();
    }
    expect(await mcpServer(ctx, 'shortcut')).toMatchObject({ transport: 'http', used_by: 'shortcut' });
    const [active, other] = ctx.dirs as [string, string];
    expect(existsSync(path.join(active, 'fake-mcp-auth.json'))).toBe(true);
    expect(existsSync(path.join(other, 'fake-mcp-auth.json'))).toBe(false);

    for (const dir of ctx.dirs) ctx.probe.set(dir, 'shortcut', { status: 'failed', error: 'connection refused' });
    await api(ctx.daemon).post('/mcp-servers/shortcut/checks', {});
    await until(
      () => one(ctx, 'shortcut'),
      (row) => row.status === 'fail',
      'the failed check',
    );
  });

  it("leaves auth with Shortcut's reason when it refuses the sign-in, and Connect tries again", async () => {
    const ctx = await start();
    process.env.FAKE_MCP_LOGIN = 'fail';
    try {
      for (const dir of ctx.dirs) ctx.probe.set(dir, 'shortcut', { status: 'needs-auth' });
      await api(ctx.daemon).post('/connectors/shortcut/connect', {});
      const failed = await until(
        () => one(ctx, 'shortcut'),
        (row) => row.status === 'auth' && row.sign_in === null && row.status_detail !== null,
        'the refusal',
      );
      expect(failed.status_detail).toContain('Incompatible auth server');
    } finally {
      delete process.env.FAKE_MCP_LOGIN;
    }
    await api(ctx.daemon).post('/connectors/shortcut/connect', {});
    await until(
      () => one(ctx, 'shortcut'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the second sign-in',
    );
  });

  it('reads fail when the server is turned off, and Connect turns it back on', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/shortcut/connect', {});
    await until(
      () => one(ctx, 'shortcut'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    await api(ctx.daemon).patch('/mcp-servers/shortcut', { enabled: false });
    expect((await api(ctx.daemon).post('/connectors/shortcut/checks', {})).body.data).toMatchObject({
      status: 'fail',
      status_detail: 'shortcut is turned off in MCP servers',
    });
    await api(ctx.daemon).post('/connectors/shortcut/connect', {});
    await until(
      () => one(ctx, 'shortcut'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in again',
    );
    expect(await mcpServer(ctx, 'shortcut')).toMatchObject({ enabled: true });
  });

  it('removes the server on Disconnect and leaves the other Connectors as they were', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/connectors/jira/connect', {});
    await api(ctx.daemon).post('/connectors/shortcut/connect', {});
    for (const id of ['jira', 'shortcut']) {
      await until(
        () => one(ctx, id),
        (row) => row.status === 'ok' && row.sign_in === null,
        `the ${id} sign-in`,
      );
    }
    const off = await api(ctx.daemon).delete('/connectors/shortcut/credentials');
    expect(off.body.data).toMatchObject({ status: 'off', login: null, account_label: null });
    expect(await mcpServer(ctx, 'shortcut')).toMatchObject({ registered: false });
    expect(await mcpServer(ctx, 'atlassian')).toMatchObject({ registered: true });
    expect((await one(ctx, 'jira')).status).toBe('ok');
  });
});

describe('Connectors connected at the same moment', () => {
  const serversIn = (dir: string): string[] =>
    Object.keys(JSON.parse(readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers ?? {}).sort();

  it('register every server in every account, none lost to another registration under way', async () => {
    for (let round = 0; round < 3; round++) {
      const ctx = await start();
      const ids = ['jira', 'sentry', 'figma', 'notion'];
      await Promise.all(ids.map((id) => api(ctx.daemon).post(`/connectors/${id}/connect`, {})));
      for (const id of ids) {
        await until(
          () => one(ctx, id),
          (row) => row.sign_in === null && row.status !== 'off',
          `the ${id} sign-in`,
        );
      }
      for (const dir of ctx.dirs) {
        expect(serversIn(dir), `round ${round}, ${path.basename(dir)}`).toEqual(
          expect.arrayContaining(['atlassian', 'figma', 'notion', 'sentry']),
        );
      }
    }
  });
});

describe('OpenTelemetry logs Connector', () => {
  const folder = async () => mkdtemp(path.join(os.tmpdir(), 'ops-console-logs-'));
  const connect = (ctx: Ctx, body: Record<string, unknown>) =>
    api(ctx.daemon).post('/connectors/otel_logs/connect', body);

  it('is listed first of the log sources, off, with an empty Log folder and no CLI or MCP server', async () => {
    const ctx = await start();
    expect(await one(ctx, 'otel_logs')).toMatchObject({
      name: 'OpenTelemetry logs',
      status: 'off',
      sign_in: null,
      config: { folder: '', environments: ['prod'], daily_scan_time: '09:00', default_interval: '24h' },
    });
    expect((await list(ctx)).map((row) => row.id).slice(-7, -3)).toEqual([
      'otel_logs',
      'cloudwatch_logs',
      'loki_logs',
      'new_relic_logs',
    ]);
  });

  it('opens the folder dialog the Repos page uses, and answers the folder chosen or none, storing nothing', async () => {
    const ctx = await start();
    const logs = await folder();
    ctx.folder.next = [logs];
    const chosen = await api(ctx.daemon).post('/connectors/otel_logs/pick-folder');
    expect([chosen.status, chosen.body.data]).toEqual([200, { path: logs }]);
    expect(await one(ctx, 'otel_logs')).toMatchObject({ status: 'off', config: { folder: '' } });
    ctx.folder.next = [];
    expect((await api(ctx.daemon).post('/connectors/otel_logs/pick-folder')).body.data).toEqual({ path: null });
    ctx.folder.next = [logs];
    await connect(ctx, { folder: (await api(ctx.daemon).post('/connectors/otel_logs/pick-folder')).body.data.path });
    expect(await one(ctx, 'otel_logs')).toMatchObject({ status: 'ok', config: { folder: logs } });
  });

  it('connects at once to a folder that exists and can be read, with no sign-in, empty or not', async () => {
    const ctx = await start();
    const logs = await folder();
    expect((await connect(ctx, { folder: logs })).status).toBe(202);
    expect(await one(ctx, 'otel_logs')).toMatchObject({
      status: 'ok',
      status_detail: null,
      sign_in: null,
      config: { folder: logs },
    });
    expect((await api(ctx.daemon).get('/mcp-servers')).body.data.map((s: Row) => s.name)).not.toContain('otel_logs');
  });

  it('refuses a folder that does not exist, and changes nothing', async () => {
    const ctx = await start();
    const missing = path.join(await folder(), 'nope');
    const refused = await connect(ctx, { folder: missing });
    expect([refused.status, refused.body.error.code]).toEqual([422, ErrorCode.FolderNotFound]);
    expect(await one(ctx, 'otel_logs')).toMatchObject({ status: 'off', config: { folder: '' } });
    const none = await connect(ctx, {});
    expect(none.status).toBe(400);
  });

  it('reads down with the reason when the folder goes missing or cannot be read, and connected again when it is back', async () => {
    const ctx = await start();
    const logs = await folder();
    await connect(ctx, { folder: logs });
    await rm(logs, { recursive: true });
    expect((await api(ctx.daemon).post('/connectors/otel_logs/checks')).body.data).toMatchObject({
      status: 'fail',
      status_detail: 'Folder not found',
    });
    await mkdir(logs);
    await chmod(logs, 0o000);
    try {
      expect((await api(ctx.daemon).post('/connectors/otel_logs/checks')).body.data).toMatchObject({
        status: 'fail',
        status_detail: 'Folder not readable',
      });
    } finally {
      await chmod(logs, 0o755);
    }
    expect((await api(ctx.daemon).post('/connectors/otel_logs/checks')).body.data).toMatchObject({
      status: 'ok',
      status_detail: null,
    });
  });

  it('leaves the folder and its files alone when it is disconnected', async () => {
    const ctx = await start();
    const logs = await folder();
    const file = path.join(logs, 'logs.jsonl');
    await writeFile(file, '{}\n');
    await connect(ctx, { folder: logs });
    const off = await api(ctx.daemon).delete('/connectors/otel_logs/credentials');
    expect(off.body.data).toMatchObject({ status: 'off' });
    expect(await readFile(file, 'utf8')).toBe('{}\n');
  });
});

describe('CloudWatch logs Connector', () => {
  const GROUPS = [
    { name: '/ecs/shop-api', service: 'shop-api', env: 'prod' },
    { name: '/ecs/billing-api', service: 'billing-api', env: 'staging' },
  ];
  const connect = (ctx: Ctx, body: Record<string, unknown>) =>
    api(ctx.daemon).post('/connectors/cloudwatch_logs/connect', body);
  const signedIn = (ctx: Ctx, profile = 'ops') => {
    ctx.tools.awsSignedInProfiles.add(profile);
    ctx.tools.awsGroups = ['/ecs/shop-api', '/ecs/billing-api', '/ecs/worker'];
  };
  const registered = (ctx: Ctx) =>
    ctx.dirs.map((dir) => {
      const file = path.join(dir, '.claude.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).mcpServers?.cloudwatch : undefined;
    });

  it('is listed last, off, with an empty profile and region, no groups, and no AWS key', async () => {
    const ctx = await start();
    expect(await one(ctx, 'cloudwatch_logs')).toMatchObject({
      name: 'CloudWatch logs',
      via: 'aws CLI + CloudWatch MCP',
      status: 'off',
      sign_in: null,
      config: {
        profile: '',
        region: '',
        log_groups: [],
        environments: ['prod'],
        daily_scan_time: '09:00',
        default_interval: '24h',
        rapid_errors_per_10m: 100,
        failing_errors_per_hour: 5,
        ignore: [],
        reports_folder: 'reports',
      },
    });
  });

  it('connects at once to a signed-in profile, and registers AWS’s CloudWatch server in every Claude account with the profile in its environment', async () => {
    const ctx = await start();
    signedIn(ctx);
    expect((await connect(ctx, { profile: 'ops', region: 'us-east-1', log_groups: GROUPS })).status).toBe(202);
    expect(await one(ctx, 'cloudwatch_logs')).toMatchObject({
      status: 'ok',
      status_detail: null,
      account_label: 'ops',
      sign_in: null,
      config: { profile: 'ops', region: 'us-east-1', log_groups: GROUPS },
    });
    for (const entry of registered(ctx)) {
      expect(entry.command).toBe('env');
      expect(entry.args).toEqual([
        'AWS_PROFILE=ops',
        'AWS_REGION=us-east-1',
        'FASTMCP_LOG_LEVEL=ERROR',
        'uvx',
        'awslabs.cloudwatch-mcp-server@latest',
      ]);
    }
    // A profile name is no secret: nothing goes to the Keychain.
    expect(ctx.keychain.values.size).toBe(0);
  });

  it('stops and names the missing tool and its install command when aws or uvx is not on the PATH', async () => {
    const ctx = await start();
    signedIn(ctx);
    const body = { profile: 'ops', region: 'us-east-1', log_groups: GROUPS };
    ctx.tools.missing = new Set(['aws']);
    const noAws = await connect(ctx, body);
    expect([noAws.status, noAws.body.error.code]).toEqual([422, ErrorCode.ToolMissing]);
    expect(noAws.body.error.message).toContain('aws');
    expect(noAws.body.error.message).toContain('brew install awscli');
    ctx.tools.missing = new Set(['uvx']);
    const noUvx = await connect(ctx, body);
    expect([noUvx.status, noUvx.body.error.code]).toEqual([422, ErrorCode.ToolMissing]);
    expect(noUvx.body.error.message).toContain('brew install uv');
    expect(await one(ctx, 'cloudwatch_logs')).toMatchObject({ status: 'off', config: { profile: '', log_groups: [] } });
    expect(ctx.tools.brewed).toEqual([]);
  });

  it('refuses two picked groups with one Service name and env, and a group the account does not have, and stores nothing', async () => {
    const ctx = await start();
    signedIn(ctx);
    const twice = await connect(ctx, {
      profile: 'ops',
      region: 'us-east-1',
      log_groups: [GROUPS[0], { name: '/ecs/shop-api-2', service: 'shop-api', env: 'prod' }],
    });
    expect([twice.status, twice.body.error.code]).toEqual([422, ErrorCode.DuplicateService]);
    // The same name in another env is a second Service.
    const other = await api(ctx.daemon).patch('/connectors/cloudwatch_logs', {
      config: { log_groups: [GROUPS[0], { name: '/ecs/shop-api-2', service: 'shop-api', env: 'staging' }] },
    });
    expect(other.status).toBe(200);
    const patched = await api(ctx.daemon).patch('/connectors/cloudwatch_logs', {
      config: { log_groups: [GROUPS[0], { name: '/ecs/shop-api-2', service: 'shop-api', env: 'prod' }] },
    });
    expect([patched.status, patched.body.error.code]).toEqual([422, ErrorCode.DuplicateService]);

    const missing = await connect(ctx, {
      profile: 'ops',
      region: 'us-east-1',
      log_groups: [{ name: '/ecs/gone', service: 'gone', env: 'prod' }],
    });
    expect([missing.status, missing.body.error.code]).toEqual([422, ErrorCode.LogGroupNotFound]);
    expect(missing.body.error.message).toContain('/ecs/gone');
    expect(await one(ctx, 'cloudwatch_logs')).toMatchObject({ status: 'off', config: { profile: '' } });
    expect(registered(ctx).every((entry) => entry === undefined)).toBe(true);
  });

  it('reads connected when the profile answers, and needs auth for any failure, with the command to run', async () => {
    const ctx = await start();
    signedIn(ctx);
    await connect(ctx, { profile: 'ops', region: 'us-east-1', log_groups: GROUPS });
    const check = async () => (await api(ctx.daemon).post('/connectors/cloudwatch_logs/checks')).body.data;
    expect(await check()).toMatchObject({ status: 'ok', account_label: 'ops' });
    ctx.tools.awsSignedInProfiles.clear();
    expect(await check()).toMatchObject({
      status: 'auth',
      status_detail: 'AWS profile ops is signed out. Connect to sign in again.',
    });
    ctx.tools.awsSsoProfiles.add('ops');
    expect(await check()).toMatchObject({
      status: 'auth',
      status_detail: 'The AWS session for ops has expired. Connect to sign in again.',
    });
    ctx.tools.missing = new Set(['aws']);
    expect(await check()).toMatchObject({
      status: 'fail',
      status_detail: expect.stringContaining('aws is not installed'),
    });
  });

  it('signs an Identity Center profile in with aws sso login, offers Cancel while it waits, and connects after', async () => {
    const ctx = await start();
    ctx.tools.awsSsoProfiles.add('ops');
    ctx.tools.awsGroups = ['/ecs/shop-api'];
    ctx.tools.next = 'hang';
    const body = { profile: 'ops', region: 'us-east-1', log_groups: [GROUPS[0]] };
    expect((await connect(ctx, body)).status).toBe(202);
    await until(
      () => one(ctx, 'cloudwatch_logs'),
      (row) => row.sign_in !== null,
      'the waiting sign-in',
    );
    expect(ctx.tools.awsLogins).toEqual(['ops']);
    expect(ctx.tools.awsLoginKinds).toEqual(['sso']);
    // A second Connect during the wait changes nothing.
    expect((await connect(ctx, body)).status).toBe(202);
    expect(ctx.tools.awsLogins).toEqual(['ops']);
    // Cancel leaves the Connector as it was before Connect, with the choices kept.
    const cancelled = await api(ctx.daemon).delete('/connectors/cloudwatch_logs/sign-in');
    expect(cancelled.body.data).toMatchObject({ status: 'off', sign_in: null, config: { profile: 'ops' } });

    ctx.tools.next = 'ok';
    await connect(ctx, body);
    await until(
      () => one(ctx, 'cloudwatch_logs'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    expect(registered(ctx).every((entry) => entry !== undefined)).toBe(true);
  });

  it('signs a profile with no Identity Center session in with aws login, in the region chosen, and connects after', async () => {
    const ctx = await start();
    ctx.tools.awsGroups = ['/ecs/shop-api'];
    expect((await connect(ctx, { profile: 'ops', region: 'us-east-1', log_groups: [GROUPS[0]] })).status).toBe(202);
    await until(
      () => one(ctx, 'cloudwatch_logs'),
      (row) => row.status === 'ok' && row.sign_in === null,
      'the sign-in',
    );
    expect(ctx.tools.awsLogins).toEqual(['ops']);
    expect(ctx.tools.awsLoginKinds).toEqual(['console']);
    expect(ctx.tools.awsLoginRegions).toEqual(['us-east-1']);
    expect(registered(ctx).every((entry) => entry !== undefined)).toBe(true);
  });

  it('stops Connect and names the version and the update command when the AWS CLI is too old for aws login, starting nothing', async () => {
    const ctx = await start();
    ctx.tools.awsCliVersion = '2.31.9';
    const refused = await connect(ctx, { profile: 'ops', region: 'us-east-1' });
    expect([refused.status, refused.body.error.code]).toEqual([409, ErrorCode.InvalidState]);
    expect(refused.body.error.message).toContain('2.31.9');
    expect(refused.body.error.message).toContain('brew upgrade awscli');
    expect(ctx.tools.awsLogins).toEqual([]);
    expect(await one(ctx, 'cloudwatch_logs')).toMatchObject({ status: 'off', sign_in: null });
    // An Identity Center profile signs in with aws sso login, which an old CLI has.
    ctx.tools.awsSsoProfiles.add('ops');
    expect((await connect(ctx, { profile: 'ops', region: 'us-east-1' })).status).toBe(202);
    await until(
      () => ctx.tools.awsLogins.length,
      (count) => count === 1,
      'aws sso login',
    );
  });

  it('creates the default profile through the sign-in when none exists, and takes the region of the profile chosen', async () => {
    const ctx = await start();
    ctx.tools.awsGroups = [];
    expect((await connect(ctx, { region: 'eu-west-1' })).status).toBe(202);
    await until(
      () => one(ctx, 'cloudwatch_logs'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    expect(ctx.tools.awsLogins).toEqual(['default']);
    expect(await one(ctx, 'cloudwatch_logs')).toMatchObject({ config: { profile: 'default', region: 'eu-west-1' } });

    const other = await start();
    other.tools.awsConfigured = [{ name: 'ops', region: 'ap-south-1' }];
    expect((await connect(other, { profile: 'ops' })).status).toBe(202);
    await until(
      () => one(other, 'cloudwatch_logs'),
      (row) => row.status === 'ok',
      'the sign-in',
    );
    expect(await one(other, 'cloudwatch_logs')).toMatchObject({ config: { profile: 'ops', region: 'ap-south-1' } });
    const noRegion = await start();
    const refused = await connect(noRegion, { profile: 'ops' });
    expect(refused.status).toBe(400);
  });

  it('lists the AWS profiles on this Mac with their regions, and says when aws is missing', async () => {
    const ctx = await start();
    ctx.tools.awsConfigured = [
      { name: 'default', region: null },
      { name: 'ops', region: 'us-east-1' },
    ];
    const listed = await api(ctx.daemon).get('/connectors/cloudwatch_logs/profiles');
    expect(listed.body).toEqual({
      data: [
        { name: 'default', region: null },
        { name: 'ops', region: 'us-east-1' },
      ],
      meta: { next_cursor: null },
    });
    ctx.tools.missing = new Set(['aws']);
    const missing = await api(ctx.daemon).get('/connectors/cloudwatch_logs/profiles');
    expect([missing.status, missing.body.error.code]).toEqual([422, ErrorCode.ToolMissing]);
  });

  it('reads down with the reason when a picked group is gone after the sign-in', async () => {
    const ctx = await start();
    ctx.tools.awsSsoProfiles.add('ops');
    ctx.tools.awsGroups = [];
    await connect(ctx, { profile: 'ops', region: 'us-east-1', log_groups: [GROUPS[0]] });
    await until(
      () => one(ctx, 'cloudwatch_logs'),
      (row) => row.status === 'fail',
      'the failure',
    );
    expect(await one(ctx, 'cloudwatch_logs')).toMatchObject({
      status_detail: expect.stringContaining('/ecs/shop-api'),
    });
  });

  it('registers the server again with the new profile, and the new region, when either changes', async () => {
    const ctx = await start();
    signedIn(ctx);
    signedIn(ctx, 'audit');
    await connect(ctx, { profile: 'ops', region: 'us-east-1', log_groups: [GROUPS[0]] });
    const changed = await api(ctx.daemon).patch('/connectors/cloudwatch_logs', { config: { profile: 'audit' } });
    expect(changed.status).toBe(200);
    for (const entry of registered(ctx))
      expect(entry.args.slice(0, 2)).toEqual(['AWS_PROFILE=audit', 'AWS_REGION=us-east-1']);
    await api(ctx.daemon).patch('/connectors/cloudwatch_logs', { config: { region: 'eu-west-1' } });
    for (const entry of registered(ctx))
      expect(entry.args.slice(0, 2)).toEqual(['AWS_PROFILE=audit', 'AWS_REGION=eu-west-1']);
    expect(await one(ctx, 'cloudwatch_logs')).toMatchObject({ status: 'ok', account_label: 'audit' });
  });

  it('keeps a changed profile out of Claude Code while the Connector is not connected, since Connect registers it', async () => {
    const ctx = await start();
    const changed = await api(ctx.daemon).patch('/connectors/cloudwatch_logs', {
      config: { profile: 'audit', region: 'eu-west-1' },
    });
    expect(changed.status).toBe(200);
    expect(await one(ctx, 'cloudwatch_logs')).toMatchObject({ status: 'off', config: { profile: 'audit' } });
    expect(registered(ctx).every((entry) => entry === undefined)).toBe(true);
  });

  it('refuses to connect over an MCP server the operator registered as cloudwatch, and leaves it as it was', async () => {
    const ctx = await start();
    signedIn(ctx);
    const own = { name: 'cloudwatch', transport: 'stdio', target: 'node /opt/mine/cloudwatch.js', scope: 'user' };
    expect((await api(ctx.daemon).post('/mcp-servers', own)).status).toBe(201);
    const refused = await connect(ctx, { profile: 'ops', region: 'us-east-1', log_groups: [GROUPS[0]] });
    expect([refused.status, refused.body.error.code]).toEqual([409, ErrorCode.Duplicate]);
    expect(refused.body.error.message).toContain('cloudwatch');
    expect((await one(ctx, 'cloudwatch_logs')).status).toBe('off');
    for (const entry of registered(ctx)) expect(entry.args).toEqual(['/opt/mine/cloudwatch.js']);
  });

  it('removes the server on Disconnect and leaves the profile, region and groups as they were', async () => {
    const ctx = await start();
    signedIn(ctx);
    await connect(ctx, { profile: 'ops', region: 'us-east-1', log_groups: GROUPS });
    const off = await api(ctx.daemon).delete('/connectors/cloudwatch_logs/credentials');
    expect(off.body.data).toMatchObject({
      status: 'off',
      config: { profile: 'ops', region: 'us-east-1', log_groups: GROUPS },
    });
    await ctx.daemon.app.get(McpServersService).settled();
    expect(registered(ctx).every((entry) => entry === undefined)).toBe(true);
    expect(ctx.tools.awsSignedInProfiles.has('ops')).toBe(true);
  });

  describe('the log group list', () => {
    const groups = (ctx: Ctx, query = '') => api(ctx.daemon).get(`/connectors/cloudwatch_logs/log-groups${query}`);

    it('lists the groups of the profile and region the pane has typed, or the stored ones', async () => {
      const ctx = await start();
      signedIn(ctx);
      const typed = await groups(ctx, '?profile=ops&region=eu-west-1');
      expect(typed.status).toBe(200);
      expect(typed.body).toEqual({
        data: [{ name: '/ecs/shop-api' }, { name: '/ecs/billing-api' }, { name: '/ecs/worker' }],
        meta: { next_cursor: null },
      });
      expect(ctx.tools.awsListed).toEqual([{ profile: 'ops', region: 'eu-west-1' }]);
      await connect(ctx, { profile: 'ops', region: 'us-east-1', log_groups: [GROUPS[0]] });
      await groups(ctx);
      expect(ctx.tools.awsListed.at(-1)).toEqual({ profile: 'ops', region: 'us-east-1' });
    });

    it('fails upstream_failed when the profile is signed out, tool_missing without aws, and 400 without a profile', async () => {
      const ctx = await start();
      const out = await groups(ctx, '?profile=ops&region=us-east-1');
      expect([out.status, out.body.error.code]).toEqual([502, ErrorCode.UpstreamFailed]);
      ctx.tools.missing = new Set(['aws']);
      const none = await groups(ctx, '?profile=ops&region=us-east-1');
      expect([none.status, none.body.error.code]).toEqual([422, ErrorCode.ToolMissing]);
      ctx.tools.missing = new Set();
      expect((await groups(ctx)).status).toBe(400);
    });
  });
});

describe('Loki logs Connector', () => {
  const connect = (ctx: Ctx, body: Record<string, unknown> = {}) =>
    api(ctx.daemon).post('/connectors/loki_logs/connect', body);
  const status = (ctx: Ctx, want: string) =>
    until(
      () => one(ctx, 'loki_logs'),
      (row) => row.status === want && row.sign_in === null,
      `Loki logs to read ${want}`,
    );
  /** The Grafana sign-in page the pane shows, and the operator finishing it in the browser. */
  const page = async (ctx: Ctx): Promise<string> =>
    (
      (
        await until(
          () => one(ctx, 'loki_logs'),
          (row) => (row.sign_in as { url: string | null } | null)?.url != null,
          'the sign-in page',
        )
      ).sign_in as { url: string }
    ).url;
  const finish = async (ctx: Ctx) => ctx.grafana.visit(await page(ctx));
  const registered = (ctx: Ctx) =>
    ctx.dirs.flatMap((dir) => {
      const file = path.join(dir, '.claude.json');
      return existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {}) : [];
    });
  /** Everything the daemon says or keeps outside the Keychain. */
  const everywhere = async (ctx: Ctx, events: WsEvent[]) =>
    JSON.stringify([
      await list(ctx),
      events,
      ctx.daemon.log,
      new Database(path.join(ctx.daemon.dataDir, 'state.db'), { readonly: true })
        .prepare('SELECT * FROM connectors')
        .all(),
    ]);

  it('is listed last but one, off, with only a data source in its config and no sign-in', async () => {
    const ctx = await start();
    expect(await one(ctx, 'loki_logs')).toMatchObject({
      name: 'Loki logs',
      via: 'Grafana Cloud MCP',
      status: 'off',
      sign_in: null,
      config: {
        datasource_uid: '',
        environments: ['prod'],
        daily_scan_time: '09:00',
        default_interval: '24h',
        rapid_errors_per_10m: 100,
        failing_errors_per_hour: 5,
        ignore: [],
        reports_folder: 'reports',
      },
    });
    expect(Object.keys((await one(ctx, 'loki_logs')).config as object).sort()).toEqual([
      'daily_scan_time',
      'datasource_uid',
      'default_interval',
      'environments',
      'failing_errors_per_hour',
      'ignore',
      'rapid_errors_per_10m',
      'reports_folder',
    ]);
    expect(ctx.keychain.values.size).toBe(0);
  });

  it('signs in to Grafana Cloud through the daemon, shows the page, reads the one Loki data source, and registers Grafana’s server for the agent', async () => {
    const ctx = await start();
    expect((await connect(ctx)).status).toBe(202);
    const waiting = await page(ctx);
    expect((await one(ctx, 'loki_logs')).sign_in).toEqual({ code: null, url: waiting });
    expect(ctx.tools.opened).toEqual([waiting]);
    const redirect = new URL(new URL(waiting).searchParams.get('redirect_uri') as string);
    expect(redirect.hostname).toBe('127.0.0.1');
    // A request that does not carry the state is not the sign-in coming back.
    expect((await fetch(`${redirect}?code=forged&state=wrong`)).status).toBe(404);
    expect((await one(ctx, 'loki_logs')).sign_in).not.toBeNull();
    expect(await ctx.grafana.visit(waiting)).toBe(200);
    expect(await status(ctx, 'ok')).toMatchObject({
      status_detail: null,
      account_label: 'Loki (prod)',
      config: { datasource_uid: 'loki-main' },
    });
    // The listener ended with the callback.
    await expect(fetch(redirect)).rejects.toThrow();
    expect([...ctx.keychain.values.keys()]).toEqual(['connection:loki_logs_oauth']);
    expect(registered(ctx)).toContain('grafana');
    const server = await api(ctx.daemon).get('/mcp-servers');
    expect(server.body.data.find((one: Row) => one.name === 'grafana')).toMatchObject({
      transport: 'http',
      target: 'https://mcp.grafana.com/mcp',
    });
  });

  it('answers only the first valid callback: a replay of it is refused', async () => {
    const ctx = await start();
    await connect(ctx);
    const authorize = await fetch(await page(ctx), { redirect: 'manual' });
    const back = authorize.headers.get('location') as string;
    const answers = await Promise.all(
      [fetch(back), fetch(back)].map((one) =>
        one.then(
          (r) => r.status,
          () => 0,
        ),
      ),
    );
    expect(answers.filter((status) => status === 200)).toHaveLength(1);
    expect(await status(ctx, 'ok')).toMatchObject({ account_label: 'Loki (prod)' });
  });

  it('keeps the tokens only in the Keychain: in no response, event, log or database row', async () => {
    const ctx = await start();
    const { events, close } = await listen(ctx.daemon);
    await connect(ctx);
    await finish(ctx);
    await status(ctx, 'ok');
    await api(ctx.daemon).post('/connectors/loki_logs/checks');
    close();
    const tokens = [...ctx.grafana.accepted];
    expect(tokens.length).toBeGreaterThan(0);
    const saved = ctx.keychain.values.get('connection:loki_logs_oauth') as string;
    expect(saved).toContain(tokens[0]);
    const everything = await everywhere(ctx, events);
    for (const token of tokens) expect(everything).not.toContain(token);
    expect(everything).not.toMatch(/refresh-/);
  });

  it('asks which data source to read when the stack has several, finishes when one is picked, and keeps the pick for the next Connect', async () => {
    const ctx = await start();
    ctx.grafana.datasource('loki-eu', 'Loki (eu)').datasource('prom-main', 'Prometheus', 'prometheus');
    await connect(ctx);
    await finish(ctx);
    expect(await status(ctx, 'auth')).toMatchObject({
      status_detail: 'Choose a Loki data source to finish connecting.',
      config: { datasource_uid: '' },
      pick: 'data_source',
    });
    const listed = await api(ctx.daemon).get('/connectors/loki_logs/datasources');
    expect(listed.body).toEqual({
      data: [
        { id: 'loki-main', name: 'Loki (prod)' },
        { id: 'loki-eu', name: 'Loki (eu)' },
      ],
      meta: { next_cursor: null },
    });
    const none = await connect(ctx);
    expect([none.status, none.body.error.code]).toEqual([409, ErrorCode.PickRequired]);
    const wrong = await connect(ctx, { datasource_uid: 'prom-main' });
    expect([wrong.status, wrong.body.error.code]).toEqual([422, ErrorCode.ValidationFailed]);
    const opened = ctx.tools.opened.length;
    expect((await connect(ctx, { datasource_uid: 'loki-eu' })).status).toBe(202);
    expect(await status(ctx, 'ok')).toMatchObject({
      account_label: 'Loki (eu)',
      config: { datasource_uid: 'loki-eu' },
    });
    // The pick used the sign-in already held: no second browser step.
    expect(ctx.tools.opened).toHaveLength(opened);

    await api(ctx.daemon).delete('/connectors/loki_logs/credentials');
    await connect(ctx);
    await finish(ctx);
    expect(await status(ctx, 'ok')).toMatchObject({
      account_label: 'Loki (eu)',
      config: { datasource_uid: 'loki-eu' },
    });
  });

  it('says so and stays needs auth when the stack has no Loki data source', async () => {
    const ctx = await start();
    ctx.grafana.datasources([]);
    await connect(ctx);
    await finish(ctx);
    expect(await status(ctx, 'auth')).toMatchObject({
      status_detail: expect.stringContaining('no Loki data source'),
    });
  });

  it('refuses a pick and the picker list while the Connector is not signed in', async () => {
    const ctx = await start();
    const listed = await api(ctx.daemon).get('/connectors/loki_logs/datasources');
    expect([listed.status, listed.body.error.code]).toEqual([409, ErrorCode.InvalidState]);
    const picked = await connect(ctx, { datasource_uid: 'loki-main' });
    expect([picked.status, picked.body.error.code]).toEqual([409, ErrorCode.InvalidState]);
  });

  it('leaves a second Connect during the wait alone, and Cancel ends the wait and the listener, keeping the status it had', async () => {
    const ctx = await start();
    await connect(ctx);
    const waiting = await page(ctx);
    expect((await connect(ctx)).status).toBe(202);
    expect(ctx.tools.opened).toEqual([waiting]);
    expect((await one(ctx, 'loki_logs')).sign_in).toEqual({ code: null, url: waiting });
    const redirect = new URL(waiting).searchParams.get('redirect_uri') as string;
    const cancelled = await api(ctx.daemon).delete('/connectors/loki_logs/sign-in');
    expect(cancelled.body.data).toMatchObject({ status: 'off', sign_in: null });
    await expect(fetch(redirect)).rejects.toThrow();
    expect(ctx.keychain.values.size).toBe(0);
  });

  it('ends needs auth with the reason when the operator declines, and when the wait runs out', async () => {
    const ctx = await start({ signInMs: 300 });
    ctx.grafana.deny = true;
    await connect(ctx);
    await finish(ctx);
    expect(await status(ctx, 'auth')).toMatchObject({ status_detail: 'Grafana did not sign you in' });
    ctx.grafana.deny = false;
    await connect(ctx);
    expect(await status(ctx, 'auth')).toMatchObject({
      status_detail: 'Grafana sign-in did not finish within 5 minutes',
    });
    expect(ctx.keychain.values.size).toBe(0);
  });

  it('has no pick pending on a row that needs a sign-in: one migrated to auth with no data source, and one whose first Connect failed', async () => {
    const ctx = await start();
    ctx.daemon.app
      .get<Store>(STORE)
      .write((tx) =>
        tx
          .update(connectors)
          .set({ status: HealthStatus.Auth, statusDetail: 'Sign in again to use Grafana Cloud.' })
          .where(eq(connectors.id, ConnectorId.LokiLogs))
          .run(),
      );
    expect(await one(ctx, 'loki_logs')).toMatchObject({ status: 'auth', config: { datasource_uid: '' }, pick: null });
    ctx.grafana.deny = true;
    await connect(ctx);
    await finish(ctx);
    expect(await status(ctx, 'auth')).toMatchObject({ pick: null });
  });

  it('keeps the note a self-hosted Loki was left with until Reconnect connects Grafana Cloud, history and settings kept', async () => {
    const ctx = await start();
    const note = 'Loki on Grafana Cloud only: the self-hosted URL is no longer read.';
    ctx.daemon.app
      .get<Store>(STORE)
      .write((tx) =>
        tx
          .update(connectors)
          .set({ status: HealthStatus.Auth, statusDetail: note })
          .where(eq(connectors.id, ConnectorId.LokiLogs))
          .run(),
      );
    const checked = (await api(ctx.daemon).post('/connectors/loki_logs/checks')).body.data;
    expect([checked.status, checked.status_detail]).toEqual(['auth', note]);
    await connect(ctx);
    await finish(ctx);
    expect(await status(ctx, 'ok')).toMatchObject({ status_detail: null, account_label: 'Loki (prod)' });
  });

  it('removes the console’s token and Grafana’s server on Disconnect, and keeps the data source for the next Connect', async () => {
    const ctx = await start();
    await connect(ctx);
    await finish(ctx);
    await status(ctx, 'ok');
    const off = await api(ctx.daemon).delete('/connectors/loki_logs/credentials');
    expect(off.body.data).toMatchObject({ status: 'off', config: { datasource_uid: 'loki-main' } });
    expect(ctx.keychain.values.size).toBe(0);
    await ctx.daemon.app.get(McpServersService).settled();
    expect(registered(ctx)).not.toContain('grafana');
  });

  describe('the health check', () => {
    const check = async (ctx: Ctx) => (await api(ctx.daemon).post('/connectors/loki_logs/checks')).body.data;
    const connected = async () => {
      const ctx = await start();
      await connect(ctx);
      await finish(ctx);
      await status(ctx, 'ok');
      return ctx;
    };

    it('reads connected through the hosted server, with the data source’s name', async () => {
      const ctx = await connected();
      expect(await check(ctx)).toMatchObject({ status: 'ok', account_label: 'Loki (prod)' });
      expect(ctx.grafana.commands().at(-1)).toBe('list_datasources');
    });

    it('refreshes an expired access token itself and keeps the new tokens in the Keychain', async () => {
      const ctx = await connected();
      const before = ctx.keychain.values.get('connection:loki_logs_oauth');
      ctx.grafana.expireAccessTokens();
      expect(await check(ctx)).toMatchObject({ status: 'ok' });
      expect(ctx.keychain.values.get('connection:loki_logs_oauth')).not.toBe(before);
    });

    it('reads needs auth when the sign-in is refused and cannot be refreshed', async () => {
      const ctx = await connected();
      ctx.grafana.expireAccessTokens();
      ctx.grafana.revokeRefreshTokens();
      expect(await check(ctx)).toMatchObject({ status: 'auth' });
      ctx.keychain.values.clear();
      expect(await check(ctx)).toMatchObject({ status: 'auth', status_detail: 'Sign in again to use Grafana Cloud.' });
    });

    it('reads down with the reason when the server does not answer, and failed with its message for an unknown tool', async () => {
      const ctx = await connected();
      ctx.grafana.behave('unreachable');
      expect(await check(ctx)).toMatchObject({
        status: 'fail',
        status_detail: expect.stringContaining('Could not reach'),
      });
      ctx.grafana.behave('unknownTool');
      const odd = await check(ctx);
      expect(odd.status).toBe('fail');
      expect(odd.status_detail).toMatch(/list_datasources|unknown tool|not found/i);
    });

    it('reads down when the picked data source is gone from the stack', async () => {
      const ctx = await connected();
      ctx.grafana.datasources([{ uid: 'other', name: 'Other', type: 'loki' }]);
      expect(await check(ctx)).toMatchObject({
        status: 'fail',
        status_detail: expect.stringContaining('not in this Grafana stack'),
      });
    });
  });
});

describe('New Relic logs Connector', () => {
  const connect = (ctx: Ctx, body: Record<string, unknown> = {}) =>
    api(ctx.daemon).post('/connectors/new_relic_logs/connect', body);
  const status = (ctx: Ctx, want: string) =>
    until(
      () => one(ctx, 'new_relic_logs'),
      (row) => row.status === want && row.sign_in === null,
      `New Relic logs to read ${want}`,
    );
  const TOKEN = 'nr-token-example';
  /** Claude Code's MCP sign-in for the server needs the operator; the stand-in finishes it as `claude mcp login` does. */
  const needsSignIn = (ctx: Ctx) => {
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'newrelic', { status: 'needs-auth' });
    ctx.newrelic.grant(TOKEN);
    ctx.claude.hold('newrelic', TOKEN);
  };
  const registeredServer = (ctx: Ctx): ({ type: string; url: string } | undefined)[] =>
    ctx.dirs.map((dir) => {
      const file = path.join(dir, '.claude.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).mcpServers?.newrelic : undefined;
    });

  it('is listed last of the log sources, off, with only the Region, the route and the account in its config', async () => {
    const ctx = await start();
    expect(await one(ctx, 'new_relic_logs')).toMatchObject({
      name: 'New Relic logs',
      via: 'New Relic MCP',
      status: 'off',
      sign_in: null,
      config: { account_id: '', region: 'US', route: 'mcp', environments: ['prod'], daily_scan_time: '09:00' },
    });
    expect(Object.keys((await one(ctx, 'new_relic_logs')).config as object).sort()).toEqual([
      'account_id',
      'daily_scan_time',
      'default_interval',
      'environments',
      'failing_errors_per_hour',
      'ignore',
      'rapid_errors_per_10m',
      'region',
      'reports_folder',
      'route',
    ]);
    expect((await list(ctx)).at(-4)?.id).toBe('new_relic_logs');
  });

  it('signs in through Claude Code with the Region’s address, reads the one account, and never signs in itself', async () => {
    const ctx = await start();
    needsSignIn(ctx);
    expect((await connect(ctx, { region: 'EU' })).status).toBe(202);
    expect(await status(ctx, 'ok')).toMatchObject({
      status_detail: null,
      account_label: 'Example Prod (1234567)',
      config: { account_id: '1234567', region: 'EU' },
    });
    for (const entry of registeredServer(ctx)) {
      expect(entry).toMatchObject({ type: 'http', url: 'https://mcp.eu.newrelic.com/mcp/' });
    }
    // Claude Code's browser step, only the active account's.
    const [active, other] = ctx.dirs as [string, string];
    expect(existsSync(path.join(active, 'fake-mcp-auth.json'))).toBe(true);
    expect(existsSync(path.join(other, 'fake-mcp-auth.json'))).toBe(false);
    // The console opened no page of its own and keeps nothing in the Keychain.
    expect(ctx.tools.opened).toEqual([]);
    expect(ctx.keychain.values.size).toBe(0);
    expect(ctx.claude.reads.length).toBeGreaterThan(0);
  });

  it('asks which account to read when the sign-in sees several, and finishes when one is picked', async () => {
    const ctx = await start();
    needsSignIn(ctx);
    ctx.newrelic.accounts([
      { id: 1234567, name: 'Example Prod' },
      { id: 7654321, name: 'Example Staging' },
    ]);
    await connect(ctx);
    expect(await status(ctx, 'auth')).toMatchObject({
      status_detail: 'Choose a New Relic account to finish connecting.',
      config: { account_id: '' },
      pick: 'account',
    });
    const listed = await api(ctx.daemon).get('/connectors/new_relic_logs/accounts');
    expect(listed.body).toEqual({
      data: [
        { id: '1234567', name: 'Example Prod' },
        { id: '7654321', name: 'Example Staging' },
      ],
      meta: { next_cursor: null },
    });
    const none = await connect(ctx);
    expect([none.status, none.body.error.code]).toEqual([409, ErrorCode.PickRequired]);
    const wrong = await connect(ctx, { account_id: '999' });
    expect([wrong.status, wrong.body.error.code]).toEqual([422, ErrorCode.ValidationFailed]);
    expect((await connect(ctx, { account_id: '7654321' })).status).toBe(202);
    expect(await status(ctx, 'ok')).toMatchObject({
      account_label: 'Example Staging (7654321)',
      config: { account_id: '7654321' },
      pick: null,
    });
  });

  it('refuses a Region outside US, EU and JP, and registers the server again at the address of a new Region', async () => {
    const ctx = await start();
    needsSignIn(ctx);
    const refused = await connect(ctx, { region: 'AU' });
    expect([refused.status, refused.body.error.code]).toEqual([422, ErrorCode.ValidationFailed]);
    expect(registeredServer(ctx).every((entry) => entry === undefined)).toBe(true);
    await connect(ctx, { region: 'JP' });
    await status(ctx, 'ok');
    for (const entry of registeredServer(ctx)) expect(entry?.url).toBe('https://mcp.jp.newrelic.com/mcp/');
    await connect(ctx, { region: 'US' });
    await until(
      () => registeredServer(ctx),
      (entries) => entries.every((entry) => entry?.url === 'https://mcp.newrelic.com/mcp/'),
      'the server at the US address',
    );
  });

  it('reads needs auth when macOS refuses the read of Claude Code’s sign-in, or Claude Code holds none', async () => {
    const ctx = await start();
    needsSignIn(ctx);
    ctx.claude.refused = true;
    await connect(ctx);
    expect(await status(ctx, 'auth')).toMatchObject({ status_detail: expect.stringContaining('macOS'), pick: null });
    expect(ctx.newrelic.calls()).toEqual([]);
  });

  it('removes the server on Disconnect and keeps the Region and the account for the next Connect', async () => {
    const ctx = await start();
    needsSignIn(ctx);
    await connect(ctx, { region: 'EU' });
    await status(ctx, 'ok');
    const off = await api(ctx.daemon).delete('/connectors/new_relic_logs/credentials');
    expect(off.body.data).toMatchObject({ status: 'off', config: { region: 'EU', account_id: '1234567' } });
    await ctx.daemon.app.get(McpServersService).settled();
    expect(registeredServer(ctx).every((entry) => entry === undefined)).toBe(true);
  });

  describe('the health check', () => {
    const check = async (ctx: Ctx) => (await api(ctx.daemon).post('/connectors/new_relic_logs/checks')).body.data;
    const connected = async () => {
      const ctx = await start();
      needsSignIn(ctx);
      await connect(ctx);
      await status(ctx, 'ok');
      return ctx;
    };

    it('reads connected through the hosted server, with the account', async () => {
      const ctx = await connected();
      expect(await check(ctx)).toMatchObject({ status: 'ok', account_label: 'Example Prod (1234567)' });
    });

    it('asks Claude Code to reconnect the one server when the token ended, reads again, and reads needs auth when that fails too', async () => {
      const ctx = await connected();
      ctx.claude.hold('newrelic', 'ended-token', Date.now() - 1_000);
      ctx.probe.afterProbe = () => ctx.claude.hold('newrelic', TOKEN);
      expect(await check(ctx)).toMatchObject({ status: 'ok' });
      expect(ctx.probe.ones + ctx.probe.runs).toBeGreaterThan(0);
      ctx.probe.afterProbe = null;
      ctx.claude.hold('newrelic', 'ended-token', Date.now() - 1_000);
      expect(await check(ctx)).toMatchObject({ status: 'auth' });
    });

    it('reads down with the reason when the server does not answer, and failed with its message for an unknown tool', async () => {
      const ctx = await connected();
      ctx.newrelic.behave('unreachable');
      expect(await check(ctx)).toMatchObject({
        status: 'fail',
        status_detail: expect.stringContaining('Could not reach'),
      });
      ctx.newrelic.behave('unknownTool');
      const odd = await check(ctx);
      expect(odd.status).toBe('fail');
      expect(odd.status_detail).toMatch(/list_available_new_relic_accounts|unknown tool|not found/i);
    });

    it('reads down when the sign-in cannot read the account any more', async () => {
      const ctx = await connected();
      ctx.newrelic.accounts([{ id: 7654321, name: 'Other' }]);
      expect(await check(ctx)).toMatchObject({ status: 'fail', status_detail: expect.stringContaining('cannot read') });
    });
  });
});

describe('New Relic logs Connector with a User API key', () => {
  const KEY = 'NRAK-EXAMPLEKEY0123456789';
  const KEYCHAIN_ITEM = 'connection:new_relic_logs';
  const connect = (ctx: Ctx, body: Record<string, unknown> = {}) =>
    api(ctx.daemon).post('/connectors/new_relic_logs/connect', body);
  const withKey = (ctx: Ctx, body: Record<string, unknown> = {}) => connect(ctx, { api_key: KEY, ...body });
  const status = (ctx: Ctx, want: string) =>
    until(
      () => one(ctx, 'new_relic_logs'),
      (row) => row.status === want && row.sign_in === null,
      `New Relic logs to read ${want}`,
    );
  const check = async (ctx: Ctx) => (await api(ctx.daemon).post('/connectors/new_relic_logs/checks')).body.data;
  const registered = (ctx: Ctx) =>
    ctx.dirs.map((dir) => {
      const file = path.join(dir, '.claude.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).mcpServers?.newrelic : undefined;
    });
  /** The pane has no way to see the key again: nothing the daemon sends holds it. */
  const nothingHoldsTheKey = async (ctx: Ctx, ...answers: unknown[]) => {
    for (const answer of [...answers, await list(ctx)]) expect(JSON.stringify(answer)).not.toContain(KEY);
  };
  const TOKEN = 'nr-token-example';
  const signedInByMcp = (ctx: Ctx) => {
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'newrelic', { status: 'needs-auth' });
    ctx.newrelic.grant(TOKEN);
    ctx.claude.hold('newrelic', TOKEN);
  };

  it('validates the key with the account list, keeps it in the Keychain, reads the one account, and touches neither Claude Code nor a browser', async () => {
    const ctx = await start();
    ctx.nerdgraph.grant(KEY);
    const sent = await withKey(ctx, { region: 'EU' });
    expect(sent.status).toBe(202);
    expect(await status(ctx, 'ok')).toMatchObject({
      via: 'New Relic API',
      account_label: 'Example Prod (1234567)',
      config: { account_id: '1234567', region: 'EU', route: 'key' },
    });
    expect(ctx.keychain.values.get(KEYCHAIN_ITEM)).toBe(KEY);
    // A User key goes in New Relic's header, to its API only.
    expect(ctx.nerdgraph.calls().map((call) => [call.key, call.path])).toEqual([[KEY, '/graphql']]);
    expect(registered(ctx).every((entry) => entry === undefined)).toBe(true);
    expect(ctx.claude.reads).toEqual([]);
    expect(ctx.tools.opened).toEqual([]);
    expect(ctx.newrelic.calls()).toEqual([]);
    await nothingHoldsTheKey(ctx, sent.body);
  });

  it('refuses a key New Relic rejects with its reason, and stores and changes nothing', async () => {
    const ctx = await start();
    ctx.nerdgraph.grant('NRAK-ANOTHER');
    const refused = await withKey(ctx);
    expect([refused.status, refused.body.error.code]).toEqual([422, ErrorCode.ValidationFailed]);
    expect(refused.body.error.message).toMatch(/New Relic refused the User API key/);
    expect(JSON.stringify(refused.body)).not.toContain(KEY);
    expect(ctx.keychain.values.has(KEYCHAIN_ITEM)).toBe(false);
    expect(await one(ctx, 'new_relic_logs')).toMatchObject({ status: 'off', config: { route: 'mcp' } });
  });

  it('refuses a Region outside US, EU and JP before any request leaves, and an empty key', async () => {
    const ctx = await start();
    ctx.nerdgraph.grant(KEY);
    const region = await withKey(ctx, { region: 'evil.example.com' });
    expect([region.status, region.body.error.code]).toEqual([422, ErrorCode.ValidationFailed]);
    expect((await withKey(ctx, { api_key: '  ' })).status).toBe(400);
    expect(ctx.nerdgraph.calls()).toEqual([]);
  });

  it('maps a throttled API to rate_limited and a failing one to upstream_failed, never with the key', async () => {
    const ctx = await start();
    ctx.nerdgraph.grant(KEY);
    ctx.nerdgraph.behave('throttle');
    const throttled = await withKey(ctx);
    expect([throttled.status, throttled.body.error.code]).toEqual([429, ErrorCode.RateLimited]);
    ctx.nerdgraph.behave('leakyError');
    const leaky = await withKey(ctx);
    expect([leaky.status, leaky.body.error.code]).toEqual([502, ErrorCode.UpstreamFailed]);
    expect(leaky.body.error.message).toContain('Bad request from [key]');
    ctx.nerdgraph.behave('unreadable');
    expect((await withKey(ctx)).body.error.code).toBe(ErrorCode.UpstreamFailed);
    await nothingHoldsTheKey(ctx, throttled.body, leaky.body);
    expect(ctx.keychain.values.has(KEYCHAIN_ITEM)).toBe(false);
  });

  it('asks which account to read when the key sees several, lists them with the key, and finishes when one is picked', async () => {
    const ctx = await start();
    ctx.nerdgraph.grant(KEY).accounts([
      { id: 1234567, name: 'Example Prod' },
      { id: 7654321, name: 'Example Staging' },
    ]);
    await withKey(ctx);
    expect(await status(ctx, 'auth')).toMatchObject({
      status_detail: 'Choose a New Relic account to finish connecting.',
      pick: 'account',
      config: { account_id: '', route: 'key' },
    });
    const listed = await api(ctx.daemon).get('/connectors/new_relic_logs/accounts');
    expect(listed.body.data).toEqual([
      { id: '1234567', name: 'Example Prod' },
      { id: '7654321', name: 'Example Staging' },
    ]);
    const wrong = await connect(ctx, { account_id: '999' });
    expect([wrong.status, wrong.body.error.code]).toEqual([422, ErrorCode.ValidationFailed]);
    expect((await connect(ctx, { account_id: '7654321' })).status).toBe(202);
    expect(await status(ctx, 'ok')).toMatchObject({
      account_label: 'Example Staging (7654321)',
      config: { account_id: '7654321', route: 'key' },
      pick: null,
    });
    expect(ctx.keychain.values.get(KEYCHAIN_ITEM)).toBe(KEY);
    expect(ctx.claude.reads).toEqual([]);
  });

  it('reads a key that can read no account as needs auth with a reason', async () => {
    const ctx = await start();
    ctx.nerdgraph.grant(KEY).accounts([]);
    await withKey(ctx);
    expect(await status(ctx, 'auth')).toMatchObject({ status_detail: expect.stringContaining('can read no account') });
  });

  describe('the health check', () => {
    const connected = async () => {
      const ctx = await start();
      ctx.nerdgraph.grant(KEY);
      await withKey(ctx);
      await status(ctx, 'ok');
      return ctx;
    };

    it('reads connected through the API, with the account', async () => {
      const ctx = await connected();
      expect(await check(ctx)).toMatchObject({ status: 'ok', account_label: 'Example Prod (1234567)' });
    });

    it('reads needs auth when New Relic refuses the key now, or the Keychain item is gone', async () => {
      const ctx = await connected();
      ctx.nerdgraph.revokeKeys();
      expect(await check(ctx)).toMatchObject({ status: 'auth', status_detail: expect.stringContaining('refused') });
      ctx.nerdgraph.grant(KEY);
      expect(await check(ctx)).toMatchObject({ status: 'ok' });
      ctx.keychain.values.delete(KEYCHAIN_ITEM);
      expect(await check(ctx)).toMatchObject({ status: 'auth' });
    });

    it('reads down with the reason for a throttle or an error, with the key scrubbed from it', async () => {
      const ctx = await connected();
      ctx.nerdgraph.behave('throttle');
      expect(await check(ctx)).toMatchObject({ status: 'fail', status_detail: expect.stringContaining('rate limit') });
      ctx.nerdgraph.behave('leakyError');
      const leaky = await check(ctx);
      expect(leaky.status).toBe('fail');
      expect(leaky.status_detail).toContain('[key]');
      await nothingHoldsTheKey(ctx, leaky);
    });
  });

  it('replaces the MCP sign-in when a key connects, and the key when the MCP sign-in connects', async () => {
    const ctx = await start();
    signedInByMcp(ctx);
    await connect(ctx, {});
    await status(ctx, 'ok');
    expect(registered(ctx).some((entry) => entry !== undefined)).toBe(true);
    expect(ctx.keychain.values.has(KEYCHAIN_ITEM)).toBe(false);

    ctx.nerdgraph.grant(KEY);
    await withKey(ctx);
    await until(
      () => registered(ctx),
      (entries) => entries.every((entry) => entry === undefined),
      'the MCP server removed',
    );
    expect(await status(ctx, 'ok')).toMatchObject({ via: 'New Relic API', config: { route: 'key' } });
    expect(ctx.keychain.values.get(KEYCHAIN_ITEM)).toBe(KEY);

    await connect(ctx, {});
    await until(
      () => ctx.keychain.values.has(KEYCHAIN_ITEM),
      (held) => !held,
      'the key removed',
    );
    expect(await status(ctx, 'ok')).toMatchObject({ via: 'New Relic MCP', config: { route: 'mcp' } });
    expect(registered(ctx).some((entry) => entry !== undefined)).toBe(true);
  });

  it('keeps the key and the account when an MCP sign-in does not finish', async () => {
    const ctx = await start();
    ctx.nerdgraph.grant(KEY);
    await withKey(ctx);
    await status(ctx, 'ok');
    signedInByMcp(ctx);
    ctx.claude.refused = true;
    await connect(ctx, {});
    await status(ctx, 'auth');
    expect(ctx.keychain.values.get(KEYCHAIN_ITEM)).toBe(KEY);
    expect((await one(ctx, 'new_relic_logs')).config).toMatchObject({ route: 'key', account_id: '1234567' });
  });

  it('clears the Keychain key on Disconnect and keeps the Region and the account for the next Connect', async () => {
    const ctx = await start();
    ctx.nerdgraph.grant(KEY);
    await withKey(ctx, { region: 'JP' });
    await status(ctx, 'ok');
    const off = await api(ctx.daemon).delete('/connectors/new_relic_logs/credentials');
    expect(off.body.data).toMatchObject({
      status: 'off',
      config: { region: 'JP', account_id: '1234567', route: 'mcp' },
    });
    expect(ctx.keychain.values.has(KEYCHAIN_ITEM)).toBe(false);
  });

  it('keeps the key across a daemon restart and reads through it', async () => {
    const ctx = await start();
    ctx.nerdgraph.grant(KEY);
    await withKey(ctx);
    await status(ctx, 'ok');
    const { dataDir, keychain } = { dataDir: ctx.daemon.dataDir, keychain: ctx.keychain };
    await ctx.daemon.stop();
    running.splice(running.indexOf(ctx.daemon), 1);
    const again = await startAgentDaemon({
      dataDir,
      keychain,
      modules: [
        McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console' }),
        ConnectorsModule.forRoot({
          tools: new FakeConnectorTools(),
          hosts: { newRelicApi: { US: ctx.nerdgraph.url } },
        }),
      ],
    });
    running.push(again);
    const checked = await api(again).post('/connectors/new_relic_logs/checks');
    expect(checked.body.data).toMatchObject({ status: 'ok', account_label: 'Example Prod (1234567)' });
  });
});

describe('first start after the typed forms', () => {
  it('deletes the old Loki Keychain item once, keeps the New Relic User API key, and does nothing when neither is there', async () => {
    const keychain = new FakeKeychain();
    keychain.values.set('connection:loki_logs', 'glc_example_secret');
    keychain.values.set('connection:new_relic_logs', 'NRAK-EXAMPLE');
    keychain.values.set('connection:datadog', 'kept');
    const ctx = await start({ keychain });
    expect([...ctx.keychain.values.keys()].sort()).toEqual(['connection:datadog', 'connection:new_relic_logs']);
    const dataDir = ctx.daemon.dataDir;
    await ctx.daemon.stop();
    running.splice(running.indexOf(ctx.daemon), 1);
    const again = await startAgentDaemon({
      dataDir,
      keychain,
      modules: [
        McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console' }),
        ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      ],
    });
    running.push(again);
    expect([...keychain.values.keys()].sort()).toEqual(['connection:datadog', 'connection:new_relic_logs']);
  });
});
