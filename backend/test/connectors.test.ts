import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { CONNECTOR_ORDER, ConnectorId, type WsEvent } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { ConnectorsService } from '../src/connectors/connectors.service';
import { connectors } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { KEYCHAIN } from '../src/keychain/keychain';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { McpServersService } from '../src/mcp/mcp-servers.service';
import { type AgentDaemon, api, listen, signIn, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeKeychain } from './fakes/keychain';
import { FakeProbe } from './fakes/probe';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

type Ctx = { daemon: AgentDaemon; tools: FakeConnectorTools; probe: FakeProbe; keychain: FakeKeychain; dirs: string[] };
type Row = Record<string, unknown> & { id: string; status: string };

async function start(): Promise<Ctx> {
  const tools = new FakeConnectorTools();
  const probe = new FakeProbe();
  const daemon = await startAgentDaemon({
    modules: [McpServersModule.forRoot({ probe, launcher: '/opt/ops-console' }), ConnectorsModule.forRoot({ tools })],
  });
  running.push(daemon);
  const added = await api(daemon).post('/agent-accounts');
  const second = path.join(daemon.dataDir, 'accounts', added.body.data.account.id);
  await signIn(second, 'second@example.com', 'pro');
  await api(daemon).post(`/agent-accounts/${added.body.data.account.id}/checks`);
  return { daemon, tools, probe, keychain: daemon.app.get<FakeKeychain>(KEYCHAIN), dirs: [daemon.home, second] };
}

const list = async (ctx: Ctx): Promise<Row[]> => (await api(ctx.daemon).get('/connectors')).body.data;
const one = async (ctx: Ctx, id: string): Promise<Row> => (await list(ctx)).find((row) => row.id === id) as Row;
/** Fake `claude mcp login <name>` processes still running. */
const logins = async (name: string): Promise<number> => {
  try {
    return execFileSync('pgrep', ['-f', `claude.mjs mcp login ${name}`], { encoding: 'utf8' })
      .trim()
      .split('\n').length;
  } catch {
    return 0;
  }
};
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
    await api(ctx.daemon).post('/mcp-servers/atlassian/checks', {});
    expect(await one(ctx, 'jira')).toMatchObject({ status: 'fail' });

    for (const dir of ctx.dirs) ctx.probe.set(dir, 'atlassian', { status: 'connected' });
    await api(ctx.daemon).post('/mcp-servers/atlassian/checks', {});
    expect(await one(ctx, 'jira')).toMatchObject({ status: 'ok', status_detail: null });
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
    expect(off.body.data).toMatchObject({ status: 'off', login: null, account_label: null });
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

  it('opens the sign-in of a server it just registered at once, and Disconnect stops it', async () => {
    const ctx = await start();
    process.env.FAKE_MCP_LOGIN = 'hang';
    try {
      const reads = ctx.probe.ones;
      await api(ctx.daemon).post('/connectors/sentry/connect', {});
      await until(
        () => logins('sentry'),
        (count) => count === 1,
        'claude mcp login',
      );
      // No one-server read ran first: the new registration holds no sign-in.
      expect(ctx.probe.ones).toBe(reads);
      await api(ctx.daemon).delete('/connectors/sentry/credentials');
      await until(
        () => logins('sentry'),
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
