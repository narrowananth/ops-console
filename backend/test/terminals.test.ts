import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type DiskAccess, type StartAtLogin, WS_PROTOCOL } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ConnectionsModule } from '../src/connections/connections.module';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import type { DiskAccessGate } from '../src/terminals/disk-access';
import type { KeychainItem, LocalKeychain } from '../src/terminals/local-sources';
import type { StartAtLoginGate } from '../src/terminals/start-at-login';
import { TerminalsModule } from '../src/terminals/terminals.module';
import { TerminalsService } from '../src/terminals/terminals.service';
import { type AgentDaemon, api, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectionTester } from './fakes/connection-tester';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeProbe } from './fakes/probe';

/** Other apps' Keychain items; tests never touch the login Keychain. */
class FakeLocalKeychain implements LocalKeychain {
  private readonly entries: { item: KeychainItem; secret: string }[] = [];

  add(item: KeychainItem, secret: string): void {
    this.entries.push({ item, secret });
  }

  async items(filter: string): Promise<KeychainItem[]> {
    const wanted = filter.toLowerCase();
    return this.entries
      .map((entry) => entry.item)
      .filter((item) => `${item.service} ${item.account} ${item.label}`.toLowerCase().includes(wanted));
  }

  async read(item: Pick<KeychainItem, 'kind' | 'service' | 'account'>): Promise<string | null> {
    const found = this.entries.find(
      (entry) => entry.item.service === item.service && (!item.account || entry.item.account === item.account),
    );
    return found?.secret ?? null;
  }
}

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

type Message = { type: string; [key: string]: unknown };
type Ctx = { daemon: AgentDaemon; tester: FakeConnectionTester; id: string; socket: WebSocket; messages: Message[] };

const PG = { type: 'postgres', config: { host: 'db.example.com', port: 5432, database: 'orders', user: 'reader' } };

async function start(options: Parameters<typeof TerminalsModule.forRoot>[0] = {}): Promise<Ctx> {
  const tester = new FakeConnectionTester();
  const daemon = await startAgentDaemon({
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console/bin/ops-console' }),
      ConnectionsModule.forRoot({ tester, launchDir: '/opt/ops-console/app/launch' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      TerminalsModule.forRoot(options),
    ],
  });
  running.push(daemon);
  const created = await api(daemon).post('/terminals', { kind: 'setup' });
  const id = created.body.data.id as string;
  const { socket, messages } = await connect(daemon, id);
  return { daemon, tester, id, socket, messages };
}

async function connect(daemon: AgentDaemon, id: string, token = daemon.token) {
  const socket = new WebSocket(`${daemon.url.replace('http', 'ws')}/terminals/${id}`, [WS_PROTOCOL, token]);
  daemon.sockets.add(socket);
  const messages: Message[] = [];
  socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, messages };
}

const send = (ctx: Ctx, message: Message) => ctx.socket.send(JSON.stringify(message));
const output = (ctx: Ctx) => ctx.messages.flatMap((m) => (m.type === 'output' ? [String(m.data)] : [])).join('');
const waitFor = (ctx: Ctx, text: string) =>
  until(
    () => output(ctx),
    (all) => all.includes(text),
    `"${text}" in the output`,
  );

describe('the setup terminal', () => {
  it('starts the setup agent under the active account and streams its output', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
  });

  it('pre-approves its own tools, so auto mode never turns down a read of a credential file', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent allows mcp__ops-console__save_connection,');
    expect(output(ctx)).toContain('mcp__ops-console__read_local_file,mcp__ops-console__list_local_folder');
  });

  it('leaves the tools that send a secret or a registration to a host of the agent’s choosing for the operator to approve', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent allows ');
    const allowed = /setup agent allows (\S+)/.exec(output(ctx))?.[1] ?? '';
    expect(allowed).not.toContain('test_connection');
    expect(allowed).not.toContain('add_mcp_server');
  });

  it('runs on the model and effort from the defaults in Settings › Agents', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent on claude-sonnet-5-5 at high effort');
    const patched = await api(ctx.daemon).patch('/settings', {
      session_defaults: { model: 'claude-opus-5-5', effort: 'ultrathink', access_mode: 'auto' },
    });
    expect(patched.status).toBe(200);
    await api(ctx.daemon).delete(`/terminals/${ctx.id}`);
    const created = await api(ctx.daemon).post('/terminals', { kind: 'setup' });
    const next = { ...ctx, ...(await connect(ctx.daemon, created.body.data.id)) };
    await waitFor(next, 'setup agent on claude-opus-5-5 at max effort');
  });

  it('swaps a password and a URI password for placeholders before Claude sees the line', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, {
      type: 'line',
      text: 'add postgres, password hunter2 and also postgres://reader:s3cr3t-pw@db.example.com/orders',
    });
    const all = await waitFor(
      ctx,
      'heard: add postgres, password {{secret:1}} and also postgres://reader:{{secret:2}}@db.example.com/orders',
    );
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('s3cr3t-pw');
  });

  it('sends a request of several lines as one paste, then Enter, with its secrets masked', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, { type: 'line', text: 'add the firebase project vajro-test-db\nread only\nthe password is hunter2' });
    const all = await waitFor(
      ctx,
      'heard pasted: add the firebase project vajro-test-db | read only | the password is {{secret:1}}',
    );
    expect(all).not.toContain('hunter2');
    expect(all).not.toMatch(/heard: (read only|add the firebase)/);
  });

  it('passes a request of any length', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    const body = Array.from({ length: 20 }, (_, n) => `line ${n} ${'x'.repeat(500)}`);
    send(ctx, { type: 'line', text: `add these notes\n${body.join('\n')}` });
    await waitFor(ctx, `heard pasted: add these notes | ${body.join(' | ')}`);
    expect(ctx.messages.filter((m) => m.type === 'refused')).toHaveLength(0);
  });

  it('passes only plain requests: raw keys, Claude Code commands and control characters never reach the pty', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, { type: 'input', data: '!whoami\r' });
    for (const text of [
      '/login',
      '!whoami',
      '  /logout',
      '# remember this',
      'show @~/.ssh/id_rsa',
      'add pg\r!whoami',
      'add pg\n\x1b[201~!whoami',
    ]) {
      send(ctx, { type: 'line', text });
    }
    send(ctx, { type: 'line', text: 'add pg for reader@db.example.com' });
    await waitFor(ctx, 'heard: add pg for reader@db.example.com');
    const refused = ctx.messages.filter((m) => m.type === 'refused');
    expect(refused).toHaveLength(7);
    expect(output(ctx)).not.toMatch(/heard: .*(login|logout|whoami|remember|ssh)/);
  });

  it('resolves placeholders inside the daemon: the tools get the secret, Claude never does', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, { type: 'line', text: 'the password is hunter2' });
    await waitFor(ctx, 'heard: the password is {{secret:1}}');

    send(ctx, { type: 'line', text: `tool test_connection ${JSON.stringify({ ...PG, secret: '{{secret:1}}' })}` });
    await waitFor(ctx, 'result: 200');
    expect(ctx.tester.runs[0]?.launch.env.DSN).toContain('hunter2');

    send(ctx, {
      type: 'line',
      text: `tool save_connection ${JSON.stringify({ ...PG, name: 'pg-orders', env: 'prod', secret: '{{secret:1}}' })}`,
    });
    await until(
      () => ctx.messages,
      (all) => all.some((m) => m.type === 'saved'),
      'the saved message',
    );
    expect(ctx.messages.find((m) => m.type === 'saved')).toMatchObject({ target: 'connection' });
    const saved = (await api(ctx.daemon).get('/connections')).body.data[0];
    expect(saved).toMatchObject({ name: 'pg-orders', access: 'read', is_prod: true, secret_stored: true });

    // The transcript Claude sees is the pty stream: no secret in it, in either direction.
    await waitFor(ctx, 'result: 200 {"data":{"id"');
    expect(output(ctx)).not.toContain('hunter2');
    expect(JSON.stringify(ctx.messages)).not.toContain('hunter2');
  });

  it('refuses a placeholder that was never given', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, { type: 'line', text: `tool test_connection ${JSON.stringify({ ...PG, secret: '{{secret:9}}' })}` });
    await waitFor(ctx, 'result: 400');
  });

  it('writes an Action Log row of kind query for each test', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, { type: 'line', text: `tool test_connection ${JSON.stringify({ ...PG, secret: 'plain' })}` });
    await waitFor(ctx, 'result: 200');
    const log = (await api(ctx.daemon).get('/action-log')).body.data;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'query', outcome: 'ok', target: 'postgres db.example.com:5432/orders' });
  });

  it('asks for a secret in a masked field and hands the agent only the placeholder', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, { type: 'line', text: `tool request_secret ${JSON.stringify({ label: 'Postgres password' })}` });
    const asked = await until(
      () => ctx.messages,
      (all) => all.some((m) => m.type === 'secret_requested'),
      'the request',
    );
    const request = asked.find((m) => m.type === 'secret_requested') as Message;
    expect(request.label).toBe('Postgres password');

    expect(
      (
        await api(ctx.daemon).post(`/terminals/${ctx.id}/secrets`, {
          request_id: request.request_id,
          value: 'typed-in-field',
        })
      ).status,
    ).toBe(204);
    await waitFor(ctx, '{"data":{"placeholder":"{{secret:1}}"}}');
    expect(output(ctx)).not.toContain('typed-in-field');

    send(ctx, { type: 'line', text: `tool test_connection ${JSON.stringify({ ...PG, secret: '{{secret:1}}' })}` });
    await until(
      () => ctx.tester.runs.at(-1)?.launch.env.DSN ?? '',
      (dsn) => dsn.includes('typed-in-field'),
      'the test',
    );
  });

  it('starts a Connector sign-in and an MCP Server sign-in through the same code as the endpoints', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, { type: 'line', text: 'tool connect_connector {"id":"github"}' });
    await until(
      () => ctx.messages,
      (all) => all.some((m) => m.type === 'saved' && m.target === 'connector'),
      'connector saved',
    );
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'sentry',
      transport: 'http',
      target: 'https://mcp.example.com/mcp',
      scope: 'user',
    });
    send(ctx, { type: 'line', text: 'tool authenticate_mcp_server {"name":"sentry"}' });
    await until(
      () => ctx.messages,
      (all) => all.some((m) => m.type === 'saved' && m.target === 'mcp_server'),
      'server saved',
    );
  });

  it('reads any local file and folder with their secrets swapped, and a test still gets the real secret', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'local-source-'));
    await writeFile(
      path.join(dir, 'connections.json'),
      JSON.stringify([{ name: 'pg-orders', type: 'PostgreSQL', host: 'db.example.com', password: 'tp-secret' }]),
    );
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');

    send(ctx, { type: 'line', text: `tool list_local_folder ${JSON.stringify({ path: dir })}` });
    await waitFor(ctx, '"name":"connections.json","kind":"file"');
    send(ctx, {
      type: 'line',
      text: `tool read_local_file ${JSON.stringify({ path: path.join(dir, 'connections.json') })}`,
    });
    await waitFor(ctx, String.raw`\"password\":\"{{secret:1}}\"`);
    send(ctx, { type: 'line', text: `tool test_connection ${JSON.stringify({ ...PG, secret: '{{secret:1}}' })}` });
    await waitFor(ctx, 'result: 200 {"data":{"status"');
    expect(ctx.tester.runs[0]?.launch.env.DSN).toContain('tp-secret');
    expect(JSON.stringify(ctx.messages)).not.toContain('tp-secret');

    send(ctx, {
      type: 'line',
      text: `tool read_local_file ${JSON.stringify({ path: path.join(dir, 'missing.json') })}`,
    });
    await waitFor(ctx, 'result: 404');
  });

  it('picks one part of a big one-line JSON file, with its header and env secrets swapped', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'local-source-'));
    const servers = {
      sentry: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer hdr-secret' } },
      github: { command: 'npx', args: ['gh-mcp'], env: { GITHUB_TOKEN: 'env-secret' } },
    };
    const file = path.join(dir, '.claude.json');
    await writeFile(file, JSON.stringify({ history: 'x'.repeat(600 * 1024), mcpServers: servers }));
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');

    send(ctx, { type: 'line', text: `tool read_local_file ${JSON.stringify({ path: file, pick: ['mcpServers'] })}` });
    await waitFor(ctx, 'https://mcp.example.com/mcp');
    expect(output(ctx)).toContain('{{secret:1}}');
    expect(output(ctx)).toContain('{{secret:2}}');
    expect(output(ctx)).not.toContain('hdr-secret');
    expect(output(ctx)).not.toContain('env-secret');
    send(ctx, { type: 'line', text: `tool read_local_file ${JSON.stringify({ path: file, pick: ['nope'] })}` });
    await waitFor(ctx, 'result: 404');
  });

  it('lists the MCP Servers the console has, without their headers', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    await api(ctx.daemon).post('/mcp-servers', {
      name: 'sentry',
      transport: 'http',
      target: 'https://mcp.example.com/mcp',
      scope: 'user',
      headers: { Authorization: 'Bearer hdr-secret' },
    });
    send(ctx, { type: 'line', text: 'tool list_mcp_servers {}' });
    await waitFor(ctx, '"name":"sentry","scope":"user","transport":"http","url":"https://mcp.example.com/mcp"');
    expect(output(ctx)).not.toContain('hdr-secret');
  });

  it('fetches an http page with its secrets swapped, and refuses other schemes', async () => {
    const server = createServer((_request, response) =>
      response.end('db:\n  url: postgres://reader:web-secret@db.example.com/orders\n'),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const ctx = await start();
      await waitFor(ctx, 'setup agent ready');
      send(ctx, {
        type: 'line',
        text: `tool fetch_url ${JSON.stringify({ url: `http://127.0.0.1:${port}/team.yml` })}`,
      });
      await waitFor(ctx, 'postgres://reader:{{secret:1}}@db.example.com/orders');
      expect(JSON.stringify(ctx.messages)).not.toContain('web-secret');
      send(ctx, { type: 'line', text: 'tool fetch_url {"url":"file:///etc/hosts"}' });
      await waitFor(ctx, 'result: 400');
    } finally {
      server.close();
    }
  });

  it("finds another app's Keychain item by name and hands the agent only a placeholder for its secret", async () => {
    const keychain = new FakeLocalKeychain();
    keychain.add({ kind: 'generic', service: 'TablePlus', account: 'pg-orders', label: 'TablePlus' }, 'kc-secret');
    const ctx = await start({ localKeychain: keychain });
    await waitFor(ctx, 'setup agent ready');
    send(ctx, { type: 'line', text: 'tool list_keychain_items {"filter":"tableplus"}' });
    await waitFor(ctx, '"service":"TablePlus","account":"pg-orders"');
    send(ctx, { type: 'line', text: 'tool read_keychain_secret {"service":"TablePlus","account":"pg-orders"}' });
    await waitFor(ctx, '{"data":{"placeholder":"{{secret:1}}"}}');
    send(ctx, { type: 'line', text: `tool test_connection ${JSON.stringify({ ...PG, secret: '{{secret:1}}' })}` });
    await until(
      () => ctx.tester.runs.at(-1)?.launch.env.DSN ?? '',
      (dsn) => dsn.includes('kc-secret'),
      'the test',
    );
    expect(JSON.stringify(ctx.messages)).not.toContain('kc-secret');
    send(ctx, { type: 'line', text: 'tool read_keychain_secret {"service":"Nothing"}' });
    await waitFor(ctx, 'result: 404');
  });

  it('lists the Connections the console has, and adds a remote MCP Server by URL', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    await api(ctx.daemon).post('/connections', { ...PG, name: 'pg-orders', env: 'dev', secret: 'pw-123456' });
    send(ctx, { type: 'line', text: 'tool list_connections {}' });
    await waitFor(ctx, '"name":"pg-orders","type":"postgres"');

    send(ctx, { type: 'line', text: 'the token is mcp-token-1' });
    await waitFor(ctx, 'heard: the token is {{secret:1}}');
    send(ctx, {
      type: 'line',
      text: `tool add_mcp_server ${JSON.stringify({ name: 'sentry', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer {{secret:1}}' } })}`,
    });
    await until(
      () => ctx.messages,
      (all) => all.some((m) => m.type === 'saved' && m.target === 'mcp_server' && m.id === 'sentry'),
      'server saved',
    );
    const servers = (await api(ctx.daemon).get('/mcp-servers')).body.data as { name: string }[];
    expect(servers.map((server) => server.name)).toContain('sentry');
    expect(JSON.stringify(ctx.messages)).not.toContain('mcp-token-1');
  });

  it('adds only a remote MCP Server: a stdio one would be a command the daemon runs', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, {
      type: 'line',
      text: `tool add_mcp_server ${JSON.stringify({ name: 'shell', url: 'touch /tmp/owned', transport: 'stdio' })}`,
    });
    await waitFor(ctx, 'result: 400');
    expect(output(ctx)).toContain('only an http or sse MCP server by URL');
    const servers = (await api(ctx.daemon).get('/mcp-servers')).body.data as { name: string }[];
    expect(servers.map((server) => server.name)).not.toContain('shell');
  });

  it('cannot change or delete an existing Connection', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    await api(ctx.daemon).post('/connections', { ...PG, name: 'pg-orders', env: 'dev', secret: 'pw-123456' });
    send(ctx, {
      type: 'line',
      text: `tool save_connection ${JSON.stringify({ ...PG, name: 'pg-orders', env: 'dev', access: 'write', secret: 'x' })}`,
    });
    await waitFor(ctx, 'result: 409');
    send(ctx, { type: 'line', text: 'tool delete_connection {}' });
    await waitFor(ctx, 'result: 400');
    expect((await api(ctx.daemon).get('/connections')).body.data[0]).toMatchObject({ access: 'read' });
  });

  it('keeps running with no socket, replays to the next one and starts no second one', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    ctx.socket.close();
    await new Promise((resolve) => ctx.socket.once('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await api(ctx.daemon).get('/terminals')).body.data).toEqual([{ id: ctx.id, kind: 'setup' }]);
    expect((await api(ctx.daemon).post('/terminals', { kind: 'setup' })).body.data.id).toBe(ctx.id);
    const again = await connect(ctx.daemon, ctx.id);
    await until(
      () => again.messages.flatMap((m) => (m.type === 'output' ? [String(m.data)] : [])).join(''),
      (all) => all.includes('setup agent ready'),
      'the replay',
    );
  });

  it('ends on Close, and forgets its pending secrets', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, { type: 'line', text: 'password hunter2' });
    await waitFor(ctx, '{{secret:1}}');
    expect((await api(ctx.daemon).delete(`/terminals/${ctx.id}`)).status).toBe(204);
    expect(ctx.daemon.app.get(TerminalsService).has(ctx.id)).toBe(false);
    expect((await api(ctx.daemon).get('/terminals')).body.data).toEqual([]);
    const gone = await api(ctx.daemon).post(`/terminals/${ctx.id}/tools/request_secret`, { label: 'x' });
    expect(gone.status).toBe(404);
  });

  it('refuses a socket without the session token', async () => {
    const ctx = await start();
    await expect(connect(ctx.daemon, ctx.id, 'wrong-token')).rejects.toThrow();
  });

  it('needs a signed-in account', async () => {
    const daemon = await startAgentDaemon({
      signedIn: false,
      modules: [
        McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/x' }),
        ConnectionsModule.forRoot({ tester: new FakeConnectionTester(), launchDir: '/opt/ops-console/app/launch' }),
        ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
        TerminalsModule.forRoot(),
      ],
    });
    running.push(daemon);
    const created = await api(daemon).post('/terminals', { kind: 'setup' });
    expect(created.status).toBe(409);
    expect(path.basename(daemon.dataDir)).toBeTruthy();
  });
});

/** Full Disk Access as the operator switches it on in System Settings; tests never open System Settings. */
class FakeDiskAccess implements DiskAccessGate {
  granted = false;
  opened = 0;

  async check(): Promise<DiskAccess> {
    return { granted: this.granted, app_path: '/Applications/Ops Console.app' };
  }

  async openSettings(): Promise<void> {
    this.opened += 1;
  }
}

describe('Full Disk Access for the Setup agent', () => {
  it('reports it off, opens System Settings, and reports it on once switched on', async () => {
    const diskAccess = new FakeDiskAccess();
    const ctx = await start({ diskAccess });
    const before = await api(ctx.daemon).get('/terminals/disk-access');
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual({ granted: false, app_path: '/Applications/Ops Console.app' });

    const opened = await api(ctx.daemon).post('/terminals/disk-access/settings');
    expect(opened.status).toBe(204);
    expect(diskAccess.opened).toBe(1);

    diskAccess.granted = true;
    const after = await api(ctx.daemon).get('/terminals/disk-access');
    expect(after.body.data).toEqual({ granted: true, app_path: '/Applications/Ops Console.app' });
  });
});

/** launchd's agent as the operator switches it under App Background Activity; tests never open System Settings. */
class FakeStartAtLogin implements StartAtLoginGate {
  state: StartAtLogin = { on: false, dev_build: false };
  opened = 0;

  async check(): Promise<StartAtLogin> {
    return this.state;
  }

  async openSettings(): Promise<void> {
    this.opened += 1;
  }
}

describe('Start at login', () => {
  it('reports it off, opens Login Items, and reports it on once switched on', async () => {
    const startAtLogin = new FakeStartAtLogin();
    const ctx = await start({ startAtLogin });
    const before = await api(ctx.daemon).get('/terminals/start-at-login');
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual({ on: false, dev_build: false });

    const opened = await api(ctx.daemon).post('/terminals/start-at-login/settings');
    expect(opened.status).toBe(204);
    expect(startAtLogin.opened).toBe(1);

    startAtLogin.state = { on: true, dev_build: false };
    const after = await api(ctx.daemon).get('/terminals/start-at-login');
    expect(after.body.data).toEqual({ on: true, dev_build: false });
  });
});
