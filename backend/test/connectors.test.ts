import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONNECTOR_ORDER, ConnectorId, ErrorCode, type WsEvent } from '@ops-console/shared';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/errors';
import { CliConnectorTools } from '../src/connectors/connector-tools';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { ConnectorsService } from '../src/connectors/connectors.service';
import { LoopbackGoogleAuth } from '../src/connectors/google-auth';
import { connectors } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { KEYCHAIN } from '../src/keychain/keychain';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { McpServersService } from '../src/mcp/mcp-servers.service';
import { type AgentDaemon, api, listen, signIn, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeGoogle } from './fakes/google';
import { FakeKeychain } from './fakes/keychain';
import { FakeLogcli } from './fakes/loki-logs';
import { FakeNewRelic } from './fakes/new-relic-logs';
import { FakeProbe } from './fakes/probe';

const running: AgentDaemon[] = [];
const googles: FakeGoogle[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const google of googles.splice(0)) await google.close().catch(() => {});
});

type Ctx = {
  daemon: AgentDaemon;
  tools: FakeConnectorTools;
  probe: FakeProbe;
  keychain: FakeKeychain;
  dirs: string[];
  /** The stand-in for Google, when the test asked for one. */
  google: FakeGoogle | null;
};
type Row = Record<string, unknown> & { id: string; status: string };

/** `google`: Google is the stand-in, with a client the build ships or with none; `signInMs` shortens the wait for a sign-in. */
async function start(options: { google?: 'shipped' | 'none'; signInMs?: number } = {}): Promise<Ctx> {
  const tools = new FakeConnectorTools();
  const probe = new FakeProbe();
  const google = options.google === undefined ? null : await FakeGoogle.start();
  if (google) googles.push(google);
  const auth = google
    ? new LoopbackGoogleAuth(options.google === 'shipped' ? google.client : null, google.endpoints, options.signInMs)
    : undefined;
  const daemon = await startAgentDaemon({
    modules: [
      McpServersModule.forRoot({ probe, launcher: '/opt/ops-console' }),
      ConnectorsModule.forRoot({ tools, google: auth }),
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
    expect(rows).toHaveLength(16);
    expect(rows.slice(-7, -4).map((row) => [row.id, row.name, row.via, row.status, row.config])).toEqual([
      ['google_docs', 'Google Docs', 'Google Docs API', 'off', {}],
      ['google_sheets', 'Google Sheets', 'Google Sheets API', 'off', {}],
      ['google_drive', 'Google Drive', 'Google Drive API', 'off', {}],
    ]);
    expect(rows.map((row) => row.id).slice(-8)).toEqual([
      'slashdocs',
      ...GOOGLE,
      'otel_logs',
      'cloudwatch_logs',
      'loki_logs',
      'new_relic_logs',
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

describe('OpenTelemetry logs Connector', () => {
  const folder = async () => mkdtemp(path.join(os.tmpdir(), 'ops-console-logs-'));
  const connect = (ctx: Ctx, body: Record<string, unknown>) =>
    api(ctx.daemon).post('/connectors/otel_logs/connect', body);

  it('is listed last, off, with an empty Log folder and no CLI or MCP server', async () => {
    const ctx = await start();
    expect(await one(ctx, 'otel_logs')).toMatchObject({
      name: 'OpenTelemetry logs',
      status: 'off',
      sign_in: null,
      config: { folder: '', environments: ['prod'], daily_scan_time: '09:00', default_interval: '24h' },
    });
    expect((await list(ctx)).map((row) => row.id).slice(-4)).toEqual([
      'otel_logs',
      'cloudwatch_logs',
      'loki_logs',
      'new_relic_logs',
    ]);
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
      status_detail: 'AWS profile ops is signed out. Run `aws login --profile ops`, then Connect again.',
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

  it('tells the operator to run aws login for a profile that does not use Identity Center', async () => {
    const ctx = await start();
    await connect(ctx, { profile: 'ops', region: 'us-east-1', log_groups: [GROUPS[0]] });
    const row = await until(
      () => one(ctx, 'cloudwatch_logs'),
      (found) => found.status === 'auth' && found.sign_in === null,
      'the answer',
    );
    expect(row.status_detail).toBe('AWS profile ops is signed out. Run `aws login --profile ops`, then Connect again.');
    expect(ctx.tools.awsLogins).toEqual([]);
    expect(registered(ctx).every((entry) => entry === undefined)).toBe(true);
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
  const connect = (ctx: Ctx, body: Record<string, unknown>) =>
    api(ctx.daemon).post('/connectors/loki_logs/connect', body);
  const status = (ctx: Ctx, want: string) =>
    until(
      () => one(ctx, 'loki_logs'),
      (row) => row.status === want,
      `Loki logs to read ${want}`,
    );
  const SECRET = 'glc_example_secret';
  const URL = 'https://loki.example.com';
  const registered = (ctx: Ctx) =>
    ctx.dirs.flatMap((dir) => {
      const file = path.join(dir, '.claude.json');
      return existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {}) : [];
    });
  const stored = (ctx: Ctx) => ctx.keychain.values.get('connection:loki_logs');
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

  it('is listed last, off, with its default config and no secret', async () => {
    const ctx = await start();
    expect(await one(ctx, 'loki_logs')).toMatchObject({
      name: 'Loki logs',
      via: 'logcli CLI',
      status: 'off',
      sign_in: null,
      config: {
        url: '',
        org_id: '',
        auth: 'none',
        username: '',
        service_label: 'service_name',
        env_label: 'deployment_environment_name',
        selector: '',
        format: 'json',
        environments: ['prod'],
        daily_scan_time: '09:00',
        default_interval: '24h',
        rapid_errors_per_10m: 100,
        failing_errors_per_hour: 5,
        ignore: [],
        reports_folder: 'reports',
      },
    });
    expect(ctx.keychain.values.size).toBe(0);
  });

  it('connects with no auth: answers 202, checks the URL through logcli, and registers no MCP server', async () => {
    const ctx = await start();
    const before = registered(ctx);
    const connected = await connect(ctx, { url: URL });
    expect(connected.status).toBe(202);
    expect(await status(ctx, 'ok')).toMatchObject({ status_detail: null, account_label: URL, config: { url: URL } });
    expect(ctx.tools.lokiCalls).toEqual([{ LOKI_ADDR: URL }]);
    expect(registered(ctx)).toEqual(before);
    expect(ctx.keychain.values.size).toBe(0);
  });

  it('connects with a bearer token and with basic auth, each passing the credentials in the environment of its checks', async () => {
    const ctx = await start();
    await connect(ctx, { url: URL, auth: 'bearer', secret: SECRET });
    await status(ctx, 'ok');
    expect(ctx.tools.lokiCalls.at(-1)).toEqual({ LOKI_ADDR: URL, LOKI_BEARER_TOKEN: SECRET });
    await connect(ctx, {
      url: URL,
      auth: 'basic',
      username: '123456',
      org_id: 'tenant-1',
      secret: 'glc_example_basic',
    });
    await until(
      () => ctx.tools.lokiCalls.at(-1),
      (call) => call?.LOKI_PASSWORD === 'glc_example_basic',
      'the basic check',
    );
    expect(ctx.tools.lokiCalls.at(-1)).toEqual({
      LOKI_ADDR: URL,
      LOKI_ORG_ID: 'tenant-1',
      LOKI_USERNAME: '123456',
      LOKI_PASSWORD: 'glc_example_basic',
    });
    expect(await one(ctx, 'loki_logs')).toMatchObject({
      config: { auth: 'basic', username: '123456', org_id: 'tenant-1' },
    });
  });

  it('keeps the secret only in the Keychain: in no response, event, log or database row', async () => {
    const ctx = await start();
    const { events, close } = await listen(ctx.daemon);
    const connected = await connect(ctx, { url: URL, auth: 'bearer', secret: SECRET });
    await status(ctx, 'ok');
    const checked = await api(ctx.daemon).post('/connectors/loki_logs/checks');
    close();
    expect(stored(ctx)).toBe(SECRET);
    expect(JSON.stringify([connected.body, checked.body])).not.toContain(SECRET);
    expect(await everywhere(ctx, events)).not.toContain(SECRET);
  });

  it('keeps the stored secret when Connect leaves it out, replaces it when one is typed, and removes it on Disconnect', async () => {
    const ctx = await start();
    await connect(ctx, { url: URL, auth: 'bearer', secret: SECRET });
    await status(ctx, 'ok');
    await connect(ctx, { url: URL, auth: 'bearer', org_id: 'tenant-2' });
    await until(
      () => ctx.tools.lokiCalls.at(-1),
      (call) => call?.LOKI_ORG_ID === 'tenant-2',
      'the second check',
    );
    expect(stored(ctx)).toBe(SECRET);
    expect(ctx.tools.lokiCalls.at(-1)).toMatchObject({ LOKI_BEARER_TOKEN: SECRET });
    await connect(ctx, { url: URL, auth: 'bearer', secret: 'glc_example_new' });
    await until(
      () => stored(ctx),
      (value) => value === 'glc_example_new',
      'the new secret',
    );
    const disconnected = await api(ctx.daemon).delete('/connectors/loki_logs/credentials');
    expect(disconnected.body.data).toMatchObject({ status: 'off', config: { url: URL } });
    expect(ctx.keychain.values.size).toBe(0);
  });

  it('clears a field the operator emptied, which a blank in a PATCH would keep', async () => {
    const ctx = await start();
    await connect(ctx, { url: URL, org_id: 'tenant-1', selector: 'cluster="prod-1"' });
    await status(ctx, 'ok');
    await connect(ctx, { url: URL, org_id: '', selector: '' });
    await until(
      () => one(ctx, 'loki_logs'),
      (row) => (row.config as { org_id: string }).org_id === '',
      'the cleared config',
    );
    expect(await one(ctx, 'loki_logs')).toMatchObject({ config: { org_id: '', selector: '' } });
  });

  it('refuses a bad config with validation_failed and stores nothing', async () => {
    const ctx = await start();
    const refused: [Record<string, unknown>, string][] = [
      [{ url: 'not a url' }, 'a URL that is not one'],
      [{ url: 'ftp://loki.example.com' }, 'a URL that is not http or https'],
      [{ url: 'https://user:tok@loki.example.com' }, 'a URL with credentials in it'],
      [{ url: 'https://tok@loki.example.com' }, 'a URL with a user in it'],
      [{}, 'no URL'],
      [{ url: URL, auth: 'basic', secret: SECRET }, 'basic with no username'],
      [{ url: URL, auth: 'bearer' }, 'bearer with no secret'],
      [{ url: URL, auth: 'basic', username: 'u' }, 'basic with no secret'],
      [{ url: URL, service_label: 'service-name' }, 'a service label that is not a label name'],
      [{ url: URL, env_label: 'a"}|' }, 'an env label that is not a label name'],
      [{ url: URL, selector: 'cluster=prod' }, 'a selector value with no quotes'],
      [{ url: URL, selector: 'cluster="a"} | json | {x="b"' }, 'a selector that closes itself'],
      [{ url: URL, format: 'plain' }, 'a format that is neither json nor logfmt'],
    ];
    for (const [body, why] of refused) {
      const response = await connect(ctx, body);
      expect([response.status, response.body.error?.code], why).toEqual([422, ErrorCode.ValidationFailed]);
    }
    expect(await one(ctx, 'loki_logs')).toMatchObject({ status: 'off', config: { url: '', auth: 'none' } });
    expect(ctx.keychain.values.size).toBe(0);
    expect(ctx.tools.lokiCalls).toEqual([]);
  });

  it('tells the operator that credentials belong in the secret field when the URL holds some', async () => {
    const ctx = await start();
    const response = await connect(ctx, { url: 'https://user:tok@loki.example.com' });
    expect(response.body.error.message).toContain('secret field');
    expect(response.body.error.message).not.toContain('tok@');
  });

  it('accepts selectors of several matchers and regular expressions', async () => {
    const ctx = await start();
    const selector = 'cluster="prod-1", namespace=~"shop.*", team!="legacy"';
    expect((await connect(ctx, { url: URL, selector })).status).toBe(202);
    expect(await status(ctx, 'ok')).toMatchObject({ config: { selector } });
  });

  it('stops and names logcli and its install command when it is not on the PATH, and installs nothing', async () => {
    const ctx = await start();
    ctx.tools.missing.add('logcli');
    const refused = await connect(ctx, { url: URL });
    expect([refused.status, refused.body.error.code]).toEqual([422, ErrorCode.ToolMissing]);
    expect(refused.body.error.message).toContain('logcli');
    expect(refused.body.error.message).toContain('brew install logcli');
    expect(ctx.tools.brewCalls).toEqual([]);
    expect(await one(ctx, 'loki_logs')).toMatchObject({ status: 'off', config: { url: '' } });
  });

  it('reads needs auth, with what to check, when Loki answers 401 or 403', async () => {
    const ctx = await start();
    ctx.tools.loki = { status: 'auth' };
    await connect(ctx, { url: URL, auth: 'bearer', secret: SECRET });
    const row = await status(ctx, 'auth');
    expect(row.status_detail).toContain('Check the secret');
    expect(row.status_detail).toContain('logs:read');
  });

  it('reads down, with the reason, when the URL does not answer', async () => {
    const ctx = await start();
    ctx.tools.loki = { status: 'down', reason: 'the connection was refused' };
    await connect(ctx, { url: URL });
    const row = await status(ctx, 'fail');
    expect(row.status_detail).toBe(`Could not reach ${URL}: the connection was refused`);
  });

  it('reads down when logcli leaves the PATH after Connect, and connected again when it returns', async () => {
    const ctx = await start();
    await connect(ctx, { url: URL });
    await status(ctx, 'ok');
    ctx.tools.missing.add('logcli');
    const down = await api(ctx.daemon).post('/connectors/loki_logs/checks');
    expect(down.body.data).toMatchObject({ status: 'fail' });
    expect(down.body.data.status_detail).toContain('brew install logcli');
    ctx.tools.missing.delete('logcli');
    expect((await api(ctx.daemon).post('/connectors/loki_logs/checks')).body.data.status).toBe('ok');
  });

  describe('the logcli health check', () => {
    const tools = async (logcli: FakeLogcli) =>
      new CliConnectorTools({
        pup: 'pup',
        gh: 'gh',
        glab: 'glab',
        bkt: 'bkt',
        slashdocs: 'slashdocs',
        aws: 'aws',
        logcli: logcli.bin,
        newrelic: 'newrelic',
      });
    const ENV = { LOKI_ADDR: URL };

    it('reads connected for a Loki that answers, with streams or none yet', async () => {
      const logcli = await FakeLogcli.create();
      expect(await (await tools(logcli)).lokiCheck(ENV)).toEqual({ status: 'ok' });
      logcli.stream({ service_name: 'shop-api' }, [{ at: Date.now() - 60_000, line: 'x' }]);
      expect(await (await tools(logcli)).lokiCheck(ENV)).toEqual({ status: 'ok' });
    });

    it('reads needs auth for a refused secret, with each auth mode, and connected for the right one', async () => {
      const logcli = await FakeLogcli.create();
      logcli.requires({ basic: { username: '123456', password: SECRET } }, 'tenant-1');
      const check = async (env: Record<string, string>) => (await tools(logcli)).lokiCheck(env);
      expect(await check({ ...ENV, LOKI_ORG_ID: 'tenant-1', LOKI_USERNAME: '123456', LOKI_PASSWORD: 'wrong' })).toEqual(
        {
          status: 'auth',
        },
      );
      expect(await check({ ...ENV, LOKI_ORG_ID: 'tenant-1', LOKI_USERNAME: '123456', LOKI_PASSWORD: SECRET })).toEqual({
        status: 'ok',
      });
      for (const behavior of ['unauthorized', 'forbidden'] as const) {
        logcli.behave(behavior);
        expect(await check(ENV), behavior).toEqual({ status: 'auth' });
      }
    });

    it('reads down with the reason for an unreachable URL, and down for any other failure', async () => {
      const logcli = await FakeLogcli.create();
      logcli.behave('unreachable');
      expect(await (await tools(logcli)).lokiCheck(ENV)).toEqual({
        status: 'down',
        reason: 'the connection was refused',
      });
      logcli.behave('throttle');
      expect(await (await tools(logcli)).lokiCheck(ENV)).toEqual({
        status: 'down',
        reason: 'it answered with an error',
      });
    });

    it('passes nothing of the secret on the command line, and no ambient LOKI_ variable of the daemon', async () => {
      const logcli = await FakeLogcli.create();
      process.env.LOKI_ADDR = 'https://ambient.example.com';
      process.env.LOKI_PASSWORD = 'ambient-password';
      try {
        await (await tools(logcli)).lokiCheck({ ...ENV, LOKI_USERNAME: 'u', LOKI_PASSWORD: SECRET });
      } finally {
        delete process.env.LOKI_ADDR;
        delete process.env.LOKI_PASSWORD;
      }
      const [call] = logcli.calls();
      expect(call?.env).toEqual({ ...ENV, LOKI_USERNAME: 'u', LOKI_PASSWORD: SECRET });
      expect(call?.args.join(' ')).not.toContain(SECRET);
    });
  });
});

describe('New Relic logs Connector', () => {
  const connect = (ctx: Ctx, body: Record<string, unknown>) =>
    api(ctx.daemon).post('/connectors/new_relic_logs/connect', body);
  const status = (ctx: Ctx, want: string) =>
    until(
      () => one(ctx, 'new_relic_logs'),
      (row) => row.status === want,
      `New Relic logs to read ${want}`,
    );
  const KEY = 'NRAK-EXAMPLE';
  const ACCOUNT = '1234567';
  const BODY = { account_id: ACCOUNT, region: 'US', secret: KEY };
  const ENV = { NEW_RELIC_API_KEY: KEY, NEW_RELIC_ACCOUNT_ID: ACCOUNT, NEW_RELIC_REGION: 'US' };
  const registered = (ctx: Ctx) =>
    ctx.dirs.flatMap((dir) => {
      const file = path.join(dir, '.claude.json');
      return existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {}) : [];
    });
  const stored = (ctx: Ctx) => ctx.keychain.values.get('connection:new_relic_logs');
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

  it('is listed last, off, with its default config and no key', async () => {
    const ctx = await start();
    expect(await one(ctx, 'new_relic_logs')).toMatchObject({
      name: 'New Relic logs',
      via: 'newrelic CLI',
      status: 'off',
      sign_in: null,
      config: {
        account_id: '',
        region: 'US',
        service_attribute: 'service.name',
        env_attribute: 'environment',
        filter: '',
        environments: ['prod'],
        daily_scan_time: '09:00',
        default_interval: '24h',
        rapid_errors_per_10m: 100,
        failing_errors_per_hour: 5,
        ignore: [],
        reports_folder: 'reports',
      },
    });
    expect((await list(ctx)).at(-1)?.id).toBe('new_relic_logs');
    expect(ctx.keychain.values.size).toBe(0);
  });

  it('connects with the key, account and region in the CLI’s environment, and registers no MCP server', async () => {
    const ctx = await start();
    const before = registered(ctx);
    const connected = await connect(ctx, { ...BODY, region: 'EU' });
    expect(connected.status).toBe(202);
    expect(await status(ctx, 'ok')).toMatchObject({
      status_detail: null,
      account_label: ACCOUNT,
      config: { account_id: ACCOUNT, region: 'EU' },
    });
    expect(ctx.tools.newRelicCalls).toEqual([{ ...ENV, NEW_RELIC_REGION: 'EU' }]);
    expect(registered(ctx)).toEqual(before);
  });

  it('keeps the key only in the Keychain: in no response, event, log or database row', async () => {
    const ctx = await start();
    const { events, close } = await listen(ctx.daemon);
    const connected = await connect(ctx, BODY);
    await status(ctx, 'ok');
    const checked = await api(ctx.daemon).post('/connectors/new_relic_logs/checks');
    close();
    expect(stored(ctx)).toBe(KEY);
    expect(JSON.stringify([connected.body, checked.body])).not.toContain(KEY);
    expect(await everywhere(ctx, events)).not.toContain(KEY);
  });

  it('keeps the key when Connect omits it, replaces it, and removes it on Disconnect', async () => {
    const ctx = await start();
    await connect(ctx, BODY);
    await status(ctx, 'ok');
    await connect(ctx, { account_id: '7654321', region: 'US' });
    await until(
      () => ctx.tools.newRelicCalls.at(-1),
      (call) => call?.NEW_RELIC_ACCOUNT_ID === '7654321',
      'the second check',
    );
    expect(stored(ctx)).toBe(KEY);
    expect(ctx.tools.newRelicCalls.at(-1)).toMatchObject({ NEW_RELIC_API_KEY: KEY });
    await connect(ctx, { ...BODY, secret: 'NRAK-EXAMPLE-NEW' });
    await until(
      () => stored(ctx),
      (value) => value === 'NRAK-EXAMPLE-NEW',
      'the new key',
    );
    const disconnected = await api(ctx.daemon).delete('/connectors/new_relic_logs/credentials');
    expect(disconnected.body.data).toMatchObject({ status: 'off', config: { account_id: ACCOUNT } });
    expect(ctx.keychain.values.size).toBe(0);
  });

  it('clears a field the operator emptied, which a blank in a PATCH would keep', async () => {
    const ctx = await start();
    await connect(ctx, { ...BODY, filter: "cluster = 'prod-1'" });
    await status(ctx, 'ok');
    await connect(ctx, { account_id: ACCOUNT, filter: '' });
    await until(
      () => one(ctx, 'new_relic_logs'),
      (row) => (row.config as { filter: string }).filter === '',
      'the cleared config',
    );
  });

  it('refuses a bad config with validation_failed and stores nothing', async () => {
    const ctx = await start();
    const refused: [Record<string, unknown>, string][] = [
      [{ ...BODY, account_id: '12ab' }, 'an account ID that is not digits'],
      [{ ...BODY, account_id: '' }, 'no account ID'],
      [{ account_id: ACCOUNT }, 'no key on a first Connect'],
      [{ ...BODY, secret: '' }, 'an empty key on a first Connect'],
      [{ ...BODY, region: 'AP' }, 'a region that is not US, EU or JP'],
      [{ ...BODY, service_attribute: 'service name' }, 'a service attribute with a space'],
      [{ ...BODY, env_attribute: 'env`; DROP' }, 'an env attribute that is not a plain name'],
      [{ ...BODY, service_attribute: '' }, 'an empty service attribute'],
      ...[
        'SINCE 1 day ago',
        'until now',
        'LIMIT 1',
        'FACET a',
        'TimeSeries',
        'order  by x',
        'COMPARE WITH 1 day ago',
        'slide  by 1 minute',
        'OFFSET 5',
        "WITH TIMEZONE 'UTC'",
        'extrapolate',
      ].map((clause): [Record<string, unknown>, string] => [
        { ...BODY, filter: `a = 'b' ${clause}` },
        `a filter with ${clause}`,
      ]),
      [{ ...BODY, filter: "a = 'b'; SELECT 1" }, 'a filter with a semicolon'],
      [{ ...BODY, filter: "a = 'b" }, 'a filter with an open quote'],
      [{ ...BODY, filter: 'a = "b' }, 'a filter with an open double quote'],
      [{ ...BODY, filter: 'a=1) OR (1=1' }, 'a filter that closes the clause the reader opens'],
      [{ ...BODY, filter: '(a = 1' }, 'a filter with an open parenthesis'],
    ];
    for (const [body, why] of refused) {
      const response = await connect(ctx, body);
      expect([response.status, response.body.error?.code], why).toEqual([422, ErrorCode.ValidationFailed]);
    }
    expect(await one(ctx, 'new_relic_logs')).toMatchObject({ status: 'off', config: { account_id: '' } });
    expect(ctx.keychain.values.size).toBe(0);
    expect(ctx.tools.newRelicCalls).toEqual([]);
  });

  it('accepts a filter of one condition, with quotes, parentheses, and a clause word inside a longer one', async () => {
    const ctx = await start();
    for (const filter of [
      "cluster = 'prod-1'",
      "(a = 'b' OR a = 'it\\'s') AND c IS NOT NULL",
      "host LIKE 'untilly%'",
      "message = 'a) b ('",
    ]) {
      expect((await connect(ctx, { ...BODY, filter })).status, filter).toBe(202);
    }
  });

  it('names the install command when newrelic is missing, and installs nothing', async () => {
    const ctx = await start();
    ctx.tools.missing.add('newrelic');
    const refused = await connect(ctx, BODY);
    expect([refused.status, refused.body.error.code]).toEqual([422, ErrorCode.ToolMissing]);
    expect(refused.body.error.message).toContain('newrelic');
    expect(refused.body.error.message).toContain('brew install newrelic-cli');
    expect(ctx.tools.brewCalls).toEqual([]);
    expect(ctx.keychain.values.size).toBe(0);
    expect(await one(ctx, 'new_relic_logs')).toMatchObject({ status: 'off', config: { account_id: '' } });
  });

  it('reads needs auth, with what to check, when New Relic answers 401 or 403', async () => {
    const ctx = await start();
    ctx.tools.newRelic = { status: 'auth' };
    await connect(ctx, BODY);
    const row = await status(ctx, 'auth');
    expect(row.status_detail).toMatch(/check the key/i);
    expect(row.status_detail).toContain('one region');
  });

  it('reads down, with the reason, when New Relic does not answer', async () => {
    const ctx = await start();
    ctx.tools.newRelic = { status: 'down', reason: 'the host name was not found' };
    await connect(ctx, BODY);
    const row = await status(ctx, 'fail');
    expect(row.status_detail).toContain('the host name was not found');
  });

  it('reads down while newrelic is off the PATH, and connected when it returns', async () => {
    const ctx = await start();
    await connect(ctx, BODY);
    await status(ctx, 'ok');
    ctx.tools.missing.add('newrelic');
    const down = await api(ctx.daemon).post('/connectors/new_relic_logs/checks');
    expect(down.body.data).toMatchObject({ status: 'fail' });
    expect(down.body.data.status_detail).toContain('brew install newrelic-cli');
    ctx.tools.missing.delete('newrelic');
    expect((await api(ctx.daemon).post('/connectors/new_relic_logs/checks')).body.data.status).toBe('ok');
  });

  it('does not read connected after Disconnect, and runs no query without a key', async () => {
    const ctx = await start();
    await connect(ctx, BODY);
    await status(ctx, 'ok');
    await api(ctx.daemon).delete('/connectors/new_relic_logs/credentials');
    const calls = ctx.tools.newRelicCalls.length;
    const checked = await api(ctx.daemon).post('/connectors/new_relic_logs/checks');
    expect(checked.body.data.status).not.toBe('ok');
    expect(ctx.tools.newRelicCalls).toHaveLength(calls);
  });

  describe('the newrelic health check', () => {
    const tools = async (newrelic: FakeNewRelic) =>
      new CliConnectorTools({
        pup: 'pup',
        gh: 'gh',
        glab: 'glab',
        bkt: 'bkt',
        slashdocs: 'slashdocs',
        aws: 'aws',
        logcli: 'logcli',
        newrelic: newrelic.bin,
      });

    it('reads connected for an account that answers, with logs or none yet', async () => {
      const newrelic = await FakeNewRelic.create();
      expect(await (await tools(newrelic)).newRelicCheck(ENV)).toEqual({ status: 'ok' });
      newrelic.events({ at: Date.now() - 60_000, attrs: { message: 'x' } });
      expect(await (await tools(newrelic)).newRelicCheck(ENV)).toEqual({ status: 'ok' });
    });

    it('reads needs auth for a refused key, account or region', async () => {
      const newrelic = await FakeNewRelic.create();
      newrelic.requires({ apiKey: KEY, accountId: ACCOUNT, region: 'EU' });
      const check = async (env: Record<string, string>) => (await tools(newrelic)).newRelicCheck(env);
      expect(await check({ ...ENV, NEW_RELIC_API_KEY: 'wrong' })).toEqual({ status: 'auth' });
      expect(await check(ENV)).toEqual({ status: 'auth' });
      expect(await check({ ...ENV, NEW_RELIC_REGION: 'EU' })).toEqual({ status: 'ok' });
      for (const behavior of ['unauthorized', 'forbidden'] as const) {
        newrelic.behave(behavior);
        expect(await check(ENV), behavior).toEqual({ status: 'auth' });
      }
    });

    it('reads down for an address that does not answer, and for any other failure', async () => {
      const newrelic = await FakeNewRelic.create();
      newrelic.behave('unreachable');
      expect(await (await tools(newrelic)).newRelicCheck(ENV)).toMatchObject({
        status: 'down',
        reason: expect.stringContaining('host name'),
      });
      newrelic.behave('throttle');
      expect(await (await tools(newrelic)).newRelicCheck(ENV)).toMatchObject({
        status: 'down',
        reason: expect.stringContaining('error'),
      });
    });

    it('keeps the key off the command line and ambient NEW_RELIC_ variables out', async () => {
      const newrelic = await FakeNewRelic.create();
      process.env.NEW_RELIC_API_KEY = 'NRAK-AMBIENT';
      process.env.NEW_RELIC_REGION = 'JP';
      process.env.NEW_RELIC_LICENSE_KEY = 'ambient-license';
      try {
        await (await tools(newrelic)).newRelicCheck(ENV);
      } finally {
        delete process.env.NEW_RELIC_API_KEY;
        delete process.env.NEW_RELIC_REGION;
        delete process.env.NEW_RELIC_LICENSE_KEY;
      }
      const [call] = newrelic.calls();
      expect(call?.env).toEqual(ENV);
      expect(call?.args.join(' ')).not.toContain(KEY);
    });
  });
});
