import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONNECTOR_ORDER, ConnectorId, ErrorCode, type WsEvent } from '@ops-console/shared';
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
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeGoogle } from './fakes/google';
import { FakeKeychain } from './fakes/keychain';
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
    expect(rows).toHaveLength(12);
    expect(rows.slice(-3).map((row) => [row.id, row.name, row.via, row.status, row.config])).toEqual([
      ['google_docs', 'Google Docs', 'Google Docs MCP', 'off', {}],
      ['google_sheets', 'Google Sheets', 'Google Sheets MCP', 'off', {}],
      ['google_drive', 'Google Drive', 'Google Drive MCP', 'off', {}],
    ]);
    expect(rows.map((row) => row.id).slice(-4)).toEqual(['slashdocs', ...GOOGLE]);
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
    expect(google.scopes[0]).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/documents.readonly',
      'https://www.googleapis.com/auth/documents',
    ]);
    expect(asked.get('prompt')).toContain('select_account');
    expect(asked.get('code_challenge_method')).toBe('S256');

    // The bridge is registered in every Claude account, wrapped by the launcher, with the sign-in only in the Keychain.
    for (const entry of registered(ctx, 'google-docs')) {
      expect(entry).toMatchObject({
        command: '/opt/ops-console',
        args: [
          'mcp-exec',
          'google-docs',
          '--',
          '/opt/ops-console',
          'google-mcp',
          'https://docsmcp.googleapis.com/mcp/v1',
        ],
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
    expect(
      (ctx.google as FakeGoogle).scopes.map((scopes) => scopes.includes('https://www.googleapis.com/auth/drive.file')),
    ).toEqual([true, true]);
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
