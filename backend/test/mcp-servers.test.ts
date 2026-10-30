import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WsEvent } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { KEYCHAIN } from '../src/keychain/keychain';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { type AgentDaemon, api, converse, listen, signIn, startAgentDaemon, until } from './agent-fixtures';
import { FakeKeychain } from './fakes/keychain';
import { FakeProbe } from './fakes/probe';
import { tempDir } from './helpers';

const LAUNCHER = '/opt/ops-console/bin/ops-console';

type Server = Record<string, unknown> & { name: string; status: string; registered: boolean };
type Ctx = { daemon: AgentDaemon; probe: FakeProbe; keychain: FakeKeychain; record: string; dirs: string[] };

const running: AgentDaemon[] = [];
afterEach(async () => {
  delete process.env.FAKE_MCP_LOGIN;
  for (const daemon of running.splice(0)) await daemon.stop();
});

/** A daemon with two signed-in accounts, `default` and `second`. */
async function start(): Promise<Ctx> {
  const probe = new FakeProbe();
  const record = path.join(await tempDir(), 'claude-calls.jsonl');
  process.env.FAKE_CLAUDE_RECORD = record;
  const daemon = await startAgentDaemon({ modules: [McpServersModule.forRoot({ probe, launcher: LAUNCHER })] });
  running.push(daemon);
  const added = await api(daemon).post('/agent-accounts');
  const second = path.join(daemon.dataDir, 'accounts', added.body.data.account.id);
  await signIn(second, 'second@example.com', 'pro');
  await api(daemon).post(`/agent-accounts/${added.body.data.account.id}/checks`);
  return { daemon, probe, keychain: daemon.app.get<FakeKeychain>(KEYCHAIN), record, dirs: [daemon.home, second] };
}

const list = async (ctx: Ctx): Promise<{ data: Server[]; meta: Record<string, unknown> }> =>
  (await api(ctx.daemon).get('/mcp-servers')).body;

const find = async (ctx: Ctx, name: string): Promise<Server | undefined> =>
  (await list(ctx)).data.find((server) => server.name === name);

async function registered(configDir: string): Promise<Record<string, Record<string, unknown>>> {
  try {
    return JSON.parse(await readFile(path.join(configDir, '.claude.json'), 'utf8')).mcpServers ?? {};
  } catch {
    return {};
  }
}

const checked = (events: WsEvent[]) =>
  events.flatMap((event) => (event.event === 'connection.checked' ? [event.data] : []));

describe('listing', () => {
  it('merges the servers of every account by name, with transport, target, scope and tools', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'sentry',
      transport: 'http',
      target: 'https://mcp.example.com/mcp',
      scope: 'user',
    });
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'tools',
      transport: 'stdio',
      target: 'node server.js --flag',
      scope: 'user',
    });

    const { data, meta } = await list(ctx);
    expect(meta).toEqual({ next_cursor: null, connection_server_count: 0 });
    expect(data.map((server) => server.name).sort()).toEqual(['sentry', 'tools']);
    expect(await find(ctx, 'tools')).toMatchObject({
      scope: 'user',
      transport: 'stdio',
      target: 'node server.js --flag',
      status: 'ok',
      tools: ['ping'],
      tool_count: 1,
      enabled: true,
      registered: true,
      env_keys: [],
      has_headers: false,
    });
  });

  it('reads the worst status across accounts and names the account and the error', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'sentry',
      transport: 'http',
      target: 'https://mcp.example.com/mcp',
      scope: 'user',
    });
    ctx.probe.set(ctx.dirs[0] ?? '', 'sentry', { status: 'needs-auth' });
    await api(ctx.daemon).post('/mcp-servers/sentry/checks');
    expect(await find(ctx, 'sentry')).toMatchObject({ status: 'auth' });

    ctx.probe.set(ctx.dirs[1] ?? '', 'sentry', { status: 'failed', error: 'spawn ENOENT' });
    await api(ctx.daemon).post('/mcp-servers/sentry/checks');
    expect(await find(ctx, 'sentry')).toMatchObject({
      status: 'fail',
      status_detail: 'second@example.com: spawn ENOENT',
      tools: [],
      tool_count: 0,
    });
  });

  it('keeps a Probe for 60 seconds, and Reconnect asks again', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'tools',
      transport: 'stdio',
      target: 'node server.js',
      scope: 'user',
    });
    await list(ctx);
    const runs = ctx.probe.runs;
    await list(ctx);
    expect(ctx.probe.runs).toBe(runs);
    await api(ctx.daemon).post('/mcp-servers/tools/checks');
    expect(ctx.probe.runs).toBe(runs + 2);
  });

  it('shows a server added or removed outside the console on the next list', async () => {
    const ctx = await start();
    const dir = ctx.dirs[0] ?? '';
    await writeFile(
      path.join(dir, '.claude.json'),
      JSON.stringify({ mcpServers: { terminal: { type: 'stdio', command: 'node', args: ['x.js'], env: {} } } }),
    );
    expect(await find(ctx, 'terminal')).toMatchObject({ registered: true, target: 'node x.js' });
    await writeFile(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    // The Probe is kept for a minute; a server dropped from the file leaves the list at once.
    expect(await find(ctx, 'terminal')).toBeUndefined();
  });

  it('reads a server added in a terminal after the Probe was kept as connected, not failed', async () => {
    const ctx = await start();
    await list(ctx);
    await writeFile(
      path.join(ctx.dirs[0] ?? '', '.claude.json'),
      JSON.stringify({ mcpServers: { terminal: { type: 'stdio', command: 'node', args: ['x.js'], env: {} } } }),
    );
    expect(await find(ctx, 'terminal')).toMatchObject({ status: 'ok' });
  });

  it('lists without a server while Claude Code is half way through rewriting its config', async () => {
    const ctx = await start();
    await writeFile(path.join(ctx.dirs[0] ?? '', '.claude.json'), '{"mcpServers": {');
    const listed = await api(ctx.daemon).get('/mcp-servers');
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([]);
  });

  it('keeps an argument with spaces whole when only the env vars change', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'pg',
      transport: 'stdio',
      target: 'node "my server.js"',
      scope: 'user',
      env: { K: 'value-1234' },
    });
    await api(ctx.daemon).patch('/mcp-servers/pg', { env: { K: 'value-5678' } });
    expect((await registered(ctx.dirs[0] ?? '')).pg).toMatchObject({
      args: ['mcp-exec', 'pg', '--', 'node', 'my server.js'],
    });
  });

  it('reads a Probe failure as fail, naming the account', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'tools',
      transport: 'stdio',
      target: 'node server.js',
      scope: 'user',
    });
    ctx.probe.breakAccount(ctx.dirs[1] ?? '');
    await api(ctx.daemon).post('/mcp-servers/tools/checks');
    expect(await find(ctx, 'tools')).toMatchObject({
      status: 'fail',
      status_detail: 'second@example.com: Claude did not answer',
    });
  });
});

describe('adding', () => {
  it('registers a stdio server through the launcher in every account and keeps env vars in the Keychain', async () => {
    const ctx = await start();
    const { events, close } = await listen(ctx.daemon);
    const created = await api(ctx.daemon).post('/mcp-servers', {
      name: 'pg',
      transport: 'stdio',
      target: 'npx -y @example/pg-mcp',
      scope: 'user',
      env: { PGPASSWORD: 'hunter2-secret' },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'pg', env_keys: ['PGPASSWORD'], target: 'npx -y @example/pg-mcp' });

    for (const dir of ctx.dirs) {
      expect((await registered(dir)).pg).toMatchObject({
        command: LAUNCHER,
        args: ['mcp-exec', 'pg', '--', 'npx', '-y', '@example/pg-mcp'],
      });
    }
    expect(JSON.parse(ctx.keychain.values.get('mcp:pg') ?? '{}')).toEqual({ PGPASSWORD: 'hunter2-secret' });
    // Behavior 16: the check reaches the browser.
    await until(
      () => checked(events),
      (found) => found.length > 0,
      'connection.checked',
    );
    expect(checked(events)[0]).toMatchObject({ target: 'mcp_server', id: 'pg', status: 'ok' });
    close();

    // Behavior 15: nothing carries the value, not the config, a read, the events or the log.
    const everything = JSON.stringify([
      events,
      (await list(ctx)).data,
      ctx.daemon.log,
      await readFile(ctx.record, 'utf8'),
    ]);
    expect(everything).not.toContain('hunter2-secret');
    for (const dir of ctx.dirs)
      expect(await readFile(path.join(dir, '.claude.json'), 'utf8')).not.toContain('hunter2-secret');
  });

  it('passes http headers to claude and shows only that there are some', async () => {
    const ctx = await start();
    const created = await api(ctx.daemon).post('/mcp-servers', {
      name: 'api',
      transport: 'http',
      target: 'https://mcp.example.com/mcp',
      scope: 'user',
      headers: { 'X-Api-Key': 'key-value-123' },
    });
    expect(created.body.data).toMatchObject({ auth: 'headers', has_headers: true });
    expect(JSON.stringify(created.body)).not.toContain('key-value-123');
    expect((await registered(ctx.dirs[0] ?? '')).api).toMatchObject({ headers: { 'X-Api-Key': 'key-value-123' } });
  });

  it('undoes the accounts already done, and the Keychain entry, when one account fails', async () => {
    const ctx = await start();
    await writeFile(path.join(ctx.dirs[1] ?? '', 'mcp-fail-add'), '');
    const created = await api(ctx.daemon).post('/mcp-servers', {
      name: 'pg',
      transport: 'stdio',
      target: 'npx pg',
      scope: 'user',
      env: { PGPASSWORD: 'hunter2-secret' },
    });
    expect(created.status).toBe(502);
    expect(created.body.error.code).toBe('upstream_failed');
    for (const dir of ctx.dirs) expect((await registered(dir)).pg).toBeUndefined();
    expect(ctx.keychain.values.has('mcp:pg')).toBe(false);
    expect(await find(ctx, 'pg')).toBeUndefined();
  });

  it('refuses a name already used by a server or a removed server', async () => {
    const ctx = await start();
    const body = { name: 'tools', transport: 'stdio', target: 'node a.js', scope: 'user' };
    expect((await api(ctx.daemon).post('/mcp-servers', body)).status).toBe(201);
    expect((await api(ctx.daemon).post('/mcp-servers', body)).body.error.code).toBe('duplicate');
    await api(ctx.daemon).delete('/mcp-servers/tools/credentials');
    expect((await api(ctx.daemon).post('/mcp-servers', body)).body.error.code).toBe('duplicate');
  });

  it('refuses project scope, env on http and headers on stdio', async () => {
    const ctx = await start();
    const post = (body: object) => api(ctx.daemon).post('/mcp-servers', body);
    expect((await post({ name: 'a', transport: 'stdio', target: 'node a.js', scope: 'project' })).body.error.code).toBe(
      'validation_failed',
    );
    expect(
      (await post({ name: 'b', transport: 'http', target: 'https://example.com', scope: 'user', env: { K: 'v' } })).body
        .error.code,
    ).toBe('validation_failed');
    expect(
      (await post({ name: 'c', transport: 'stdio', target: 'node c.js', scope: 'user', headers: { K: 'v' } })).body
        .error.code,
    ).toBe('validation_failed');
    expect((await post({ name: 'd', transport: 'http', target: 'not a url', scope: 'user' })).body.error.code).toBe(
      'validation_failed',
    );
  });
});

describe('editing', () => {
  it('registers the change in every account, keeps blank env values and the name', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'pg',
      transport: 'stdio',
      target: 'npx pg',
      scope: 'user',
      env: { PGPASSWORD: 'hunter2-secret', PGUSER: 'reader' },
    });
    const patched = await api(ctx.daemon).patch('/mcp-servers/pg', {
      target: 'npx pg --read-only',
      env: { PGPASSWORD: '', PGUSER: 'writer', PGHOST: 'db.example.com' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      name: 'pg',
      target: 'npx pg --read-only',
      env_keys: ['PGHOST', 'PGPASSWORD', 'PGUSER'],
    });
    expect(JSON.parse(ctx.keychain.values.get('mcp:pg') ?? '{}')).toEqual({
      PGPASSWORD: 'hunter2-secret',
      PGUSER: 'writer',
      PGHOST: 'db.example.com',
    });
    for (const dir of ctx.dirs) {
      expect((await registered(dir)).pg).toMatchObject({ args: ['mcp-exec', 'pg', '--', 'npx', 'pg', '--read-only'] });
    }
  });

  it('keeps stored header values the form left blank', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'api',
      transport: 'http',
      target: 'https://mcp.example.com/mcp',
      scope: 'user',
      headers: { 'X-Api-Key': 'key-value-123' },
    });
    await api(ctx.daemon).patch('/mcp-servers/api', {
      target: 'https://mcp.example.com/v2',
      headers: { 'X-Api-Key': '' },
    });
    expect((await registered(ctx.dirs[1] ?? '')).api).toMatchObject({
      url: 'https://mcp.example.com/v2',
      headers: { 'X-Api-Key': 'key-value-123' },
    });
  });

  it('answers 404 for an unknown server', async () => {
    const ctx = await start();
    expect((await api(ctx.daemon).patch('/mcp-servers/nope', { target: 'node a.js' })).status).toBe(404);
  });
});

describe('authenticating and reconnecting', () => {
  it('signs in each account that needs it, then reports ok', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'sentry',
      transport: 'http',
      target: 'https://mcp.example.com/mcp',
      scope: 'user',
    });
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'sentry', { status: 'needs-auth' });
    await api(ctx.daemon).post('/mcp-servers/sentry/checks');
    expect(await find(ctx, 'sentry')).toMatchObject({ status: 'auth' });

    const { events, close } = await listen(ctx.daemon);
    expect((await api(ctx.daemon).post('/mcp-servers/sentry/auth')).status).toBe(202);
    await until(
      () => checked(events),
      (found) => found.some((event) => event.status === 'ok'),
      'a passing check',
    );
    close();
    expect(await find(ctx, 'sentry')).toMatchObject({ status: 'ok' });
    for (const dir of ctx.dirs)
      expect(JSON.parse(await readFile(path.join(dir, 'fake-mcp-auth.json'), 'utf8'))).toContain('sentry');
  });

  it('leaves the status auth when the sign-in fails', async () => {
    const ctx = await start();
    process.env.FAKE_MCP_LOGIN = 'fail';
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'sentry',
      transport: 'http',
      target: 'https://mcp.example.com/mcp',
      scope: 'user',
    });
    for (const dir of ctx.dirs) ctx.probe.set(dir, 'sentry', { status: 'needs-auth' });
    const { events, close } = await listen(ctx.daemon);
    await api(ctx.daemon).post('/mcp-servers/sentry/auth');
    await until(
      () => checked(events),
      (found) => found.length > 0,
      'a check',
    );
    close();
    expect(checked(events).at(-1)?.status).toBe('auth');
    expect(await find(ctx, 'sentry')).toMatchObject({ status: 'auth' });
  });

  it('registers a server in the accounts that miss it before the new Probe', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'tools',
      transport: 'stdio',
      target: 'node a.js',
      scope: 'user',
    });
    await writeFile(path.join(ctx.dirs[1] ?? '', '.claude.json'), JSON.stringify({ mcpServers: {} }));
    expect((await registered(ctx.dirs[1] ?? '')).tools).toBeUndefined();
    const reconnected = await api(ctx.daemon).post('/mcp-servers/tools/checks');
    expect(reconnected.status).toBe(200);
    expect((await registered(ctx.dirs[1] ?? '')).tools).toMatchObject({ command: 'node', args: ['a.js'] });
  });
});

describe('disabling', () => {
  it('reads off, keeps the config, and leaves the server out of agent runs until enabled', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'tools',
      transport: 'stdio',
      target: 'node a.js',
      scope: 'user',
    });
    const off = await api(ctx.daemon).patch('/mcp-servers/tools', { enabled: false });
    expect(off.body.data).toMatchObject({ enabled: false, status: 'off', tools: [] });
    expect((await registered(ctx.dirs[0] ?? '')).tools).toBeDefined();

    await converse(ctx.daemon, ctx.daemon.createSession(), 'hello');
    expect(ctx.daemon.sdk.calls.at(-1)?.options.settings).toMatchObject({
      deniedMcpServers: [{ serverName: 'tools' }],
    });

    const on = await api(ctx.daemon).patch('/mcp-servers/tools', { enabled: true });
    expect(on.body.data).toMatchObject({ enabled: true, status: 'ok' });
    await converse(ctx.daemon, ctx.daemon.createSession(), 'hello again');
    expect(ctx.daemon.sdk.calls.at(-1)?.options.settings).toMatchObject({ deniedMcpServers: [] });
  });
});

describe('removing', () => {
  it('signs out and unregisters in every account, clears the Keychain, and keeps the server listed', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'pg',
      transport: 'stdio',
      target: 'npx pg',
      scope: 'user',
      env: { PGPASSWORD: 'hunter2-secret' },
    });
    await api(ctx.daemon).patch('/mcp-servers/pg', { enabled: false });
    const removed = await api(ctx.daemon).delete('/mcp-servers/pg/credentials');
    expect(removed.status).toBe(200);
    expect(removed.body.data).toMatchObject({
      name: 'pg',
      registered: false,
      status: 'auth',
      target: 'npx pg',
      env_keys: [],
    });
    for (const dir of ctx.dirs) expect((await registered(dir)).pg).toBeUndefined();
    expect(ctx.keychain.values.has('mcp:pg')).toBe(false);
    expect(await find(ctx, 'pg')).toMatchObject({ registered: false, status: 'auth' });
  });

  it('registers an http server again from its row when Authenticate runs, then drops the row', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'sentry',
      transport: 'http',
      target: 'https://mcp.example.com/mcp',
      scope: 'user',
    });
    await api(ctx.daemon).delete('/mcp-servers/sentry/credentials');
    const { events, close } = await listen(ctx.daemon);
    expect((await api(ctx.daemon).post('/mcp-servers/sentry/auth')).status).toBe(202);
    await until(
      () => checked(events),
      (found) => found.length > 0,
      'a check',
    );
    close();
    expect(await find(ctx, 'sentry')).toMatchObject({ registered: true, status: 'ok' });
    expect((await registered(ctx.dirs[0] ?? '')).sentry).toBeDefined();
  });

  it('asks for the env vars of a removed stdio server instead of signing it in', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'pg',
      transport: 'stdio',
      target: 'npx pg',
      scope: 'user',
      env: { K: 'value-1234' },
    });
    await api(ctx.daemon).delete('/mcp-servers/pg/credentials');
    expect((await api(ctx.daemon).post('/mcp-servers/pg/auth')).status).toBe(409);
    const again = await api(ctx.daemon).patch('/mcp-servers/pg', { env: { K: 'value-1234' } });
    expect(again.body.data).toMatchObject({ registered: true, env_keys: ['K'] });
  });

  it('lists a removed server again as registered once it is added outside the console', async () => {
    const ctx = await start();
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'tools',
      transport: 'stdio',
      target: 'node a.js',
      scope: 'user',
    });
    await api(ctx.daemon).delete('/mcp-servers/tools/credentials');
    await writeFile(
      path.join(ctx.dirs[0] ?? '', '.claude.json'),
      JSON.stringify({ mcpServers: { tools: { type: 'stdio', command: 'node', args: ['a.js'], env: {} } } }),
    );
    expect(await find(ctx, 'tools')).toMatchObject({ registered: true });
    expect((await list(ctx)).data.filter((server) => server.name === 'tools')).toHaveLength(1);
  });
});
