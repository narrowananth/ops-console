import path from 'node:path';
import { WS_PROTOCOL } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ConnectionsModule } from '../src/connections/connections.module';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { TerminalsModule } from '../src/terminals/terminals.module';
import { TerminalsService } from '../src/terminals/terminals.service';
import { type AgentDaemon, api, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectionTester } from './fakes/connection-tester';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeProbe } from './fakes/probe';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

type Message = { type: string; [key: string]: unknown };
type Ctx = { daemon: AgentDaemon; tester: FakeConnectionTester; id: string; socket: WebSocket; messages: Message[] };

const PG = { type: 'postgres', config: { host: 'db.example.com', port: 5432, database: 'orders', user: 'reader' } };

async function start(): Promise<Ctx> {
  const tester = new FakeConnectionTester();
  const daemon = await startAgentDaemon({
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console/bin/ops-console' }),
      ConnectionsModule.forRoot({ tester }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      TerminalsModule.forRoot(),
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

  it('writes raw keystrokes as they come', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, { type: 'input', data: 'plain words\r' });
    await waitFor(ctx, 'heard: plain words');
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

  it('ends when the socket closes, and forgets its pending secrets', async () => {
    const ctx = await start();
    await waitFor(ctx, 'setup agent ready');
    send(ctx, { type: 'line', text: 'password hunter2' });
    await waitFor(ctx, '{{secret:1}}');
    ctx.socket.close();
    const terminals = ctx.daemon.app.get(TerminalsService);
    await until(
      () => terminals.has(ctx.id),
      (alive) => !alive,
      'the terminal to end',
    );
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
        ConnectionsModule.forRoot({ tester: new FakeConnectionTester() }),
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
