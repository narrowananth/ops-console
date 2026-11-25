import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccessMode, SessionKind } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { anonymousToolId } from '../src/agent/anonymous-tools';
import { AgentRuntime } from '../src/agent/runtime';
import { AnonymousToolsModule } from '../src/anonymous-tools/anonymous-tools.module';
import { AnonymousToolsService } from '../src/anonymous-tools/anonymous-tools.service';
import type { KeychainItem, LocalKeychain } from '../src/anonymous-tools/local-sources';
import { ConnectionsModule } from '../src/connections/connections.module';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { ReposModule } from '../src/repos/repos.module';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, gate, listen, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectionTester } from './fakes/connection-tester';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeGitHost } from './fakes/git-host';
import { FakeKeychain } from './fakes/keychain';
import { FakeProbe } from './fakes/probe';

/** Other apps' Keychain items; tests never touch the login Keychain. */
class FakeLocalKeychain implements LocalKeychain {
  constructor(private readonly entries: { item: KeychainItem; secret: string }[]) {}

  async items(filter: string): Promise<KeychainItem[]> {
    return this.entries.map((entry) => entry.item).filter((item) => item.service.toLowerCase().includes(filter));
  }

  async read(item: Pick<KeychainItem, 'service'>): Promise<string | null> {
    return this.entries.find((entry) => entry.item.service === item.service)?.secret ?? null;
  }
}

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

const PG = { type: 'postgres', config: { host: 'db.example.com', port: 5432, database: 'orders', user: 'reader' } };
const SAVE = { ...PG, name: 'pg-orders', env: 'dev' };

type Answer = { content: { type: string; text?: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<Answer>;

async function start() {
  const tester = new FakeConnectionTester();
  const keychain = new FakeKeychain();
  const daemon = await startAgentDaemon({
    fixtureKinds: false,
    keychain,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console/bin/ops-console' }),
      ConnectionsModule.forRoot({ tester, launchDir: '/opt/ops-console/app/launch' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      ReposModule.forRoot(),
      WorkspaceModule.forRoot({ hosts: new FakeGitHost() }),
      AnonymousToolsModule.forRoot({
        localKeychain: new FakeLocalKeychain([
          { item: { kind: 'generic', service: 'TablePlus', account: 'pg', label: 'TablePlus' }, secret: 'kc-secret' },
        ]),
      }),
    ],
  });
  running.push(daemon);
  const http = api(daemon);
  const session = async (access_mode = AccessMode.Supervised) =>
    (await http.post('/sessions', { kind: 'anonymous', access_mode })).body.data.id as string;
  const pending = async () =>
    (await http.get('/approvals?status=pending')).body.data as { id: string; summary: string }[];
  const idle = (id: string) =>
    until(
      async () => (await http.get(`/sessions/${id}`)).body.data.state,
      (state) => state === 'idle',
      'the run to end',
    );
  /** The console's tools of the latest run, as the SDK would call them. */
  const tools = (): Record<string, { handler: Handler }> => {
    const server = daemon.sdk.calls.at(-1)?.options.mcpServers?.['ops-console'] as
      | { instance: { _registeredTools: Record<string, { handler: Handler }> } }
      | undefined;
    return server?.instance._registeredTools ?? {};
  };
  /** Sends a message whose run calls `tool` and holds it open until `callIt` has run the tool. */
  async function call(id: string, tool: string, input: Record<string, unknown>, decision?: 'approved' | 'denied') {
    const hold = gate();
    daemon.sdk.script({ tool: anonymousToolId(tool as never), input, hold: hold.promise });
    await http.post(`/sessions/${id}/messages`, { text: `do ${tool}` });
    let summary: string | null = null;
    if (decision) {
      const [wait] = await until(pending, (list) => list.length === 1, `an Approval for ${tool}`);
      summary = wait?.summary ?? null;
      await http.post(`/approvals/${wait?.id}/decision`, { decision });
    } else {
      await until(
        () => daemon.sdk.calls.length,
        (count) => count > 0,
        'the run',
      );
    }
    return {
      summary,
      run: async () => {
        const handler = tools()[tool]?.handler;
        if (!handler) throw new Error(`${tool} is not offered`);
        const answer = await handler(input, {});
        hold.open();
        await idle(id);
        return answer;
      },
    };
  }
  return { daemon, http, tester, keychain, session, pending, idle, tools, call };
}

/** Everything the console keeps or sends that the agent, the operator or a log could read. */
async function everywhere(ctx: Awaited<ReturnType<typeof start>>, id: string, events: unknown[]) {
  const http = ctx.http;
  return JSON.stringify([
    (await http.get(`/sessions/${id}/messages`)).body,
    (await http.get('/action-log')).body,
    (await http.get('/approvals')).body,
    events,
    ctx.daemon.log,
    ctx.daemon.sdk.calls.map((call) => [call.prompt, call.options.env]),
  ]);
}

describe('an Anonymous Session gets the setup tools', () => {
  it('offers them, and says how to use them, in a run the operator started', async () => {
    const ctx = await start();
    const id = await ctx.session();
    ctx.daemon.sdk.script({ text: 'ok' });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'hi' });
    await ctx.idle(id);
    expect(Object.keys(ctx.tools())).toEqual(
      expect.arrayContaining([
        'test_connection',
        'save_connection',
        'connect_connector',
        'authenticate_mcp_server',
        'request_secret',
        'list_connections',
        'list_mcp_servers',
        'read_local_file',
        'list_local_folder',
        'fetch_url',
        'list_keychain_items',
        'read_keychain_secret',
        'add_mcp_server',
      ]),
    );
    const prompt = JSON.stringify(ctx.daemon.sdk.calls[0]?.options.systemPrompt);
    expect(prompt).toContain('call request_secret');
    expect(prompt).toContain('Never ask the operator to paste');
  });

  it('offers none of them to a run the console starts, and not to a Session in a Repo', async () => {
    const ctx = await start();
    const id = await ctx.session();
    ctx.daemon.sdk.script({ text: 'ok' });
    await ctx.daemon.app.get(AgentRuntime).runFor(id, 'hi').finished;
    expect(ctx.daemon.sdk.calls.at(-1)?.options.mcpServers).toBeUndefined();

    // A Session that moved into a Repo keeps no setup tools.
    const repo = ctx.daemon.createSession({ kind: SessionKind.Repo });
    expect(ctx.daemon.app.get(AnonymousToolsService).offers(repo)).toBe(false);
    expect(ctx.daemon.app.get(AnonymousToolsService).offers(id)).toBe(true);
  });

  it('asks before each tool that tests, saves, registers or reads a secret, in every Access mode but full', async () => {
    const asked: [string, Record<string, unknown>, RegExp][] = [
      ['test_connection', { ...PG, secret: 'plain-pw' }, /Test a postgres Connection to db\.example\.com:5432\/orders/],
      ['save_connection', { ...SAVE, secret: 'plain-pw' }, /Save a DEV postgres Connection "pg-orders"/],
      ['connect_connector', { id: 'github' }, /sign-in of the github Connector/],
      ['authenticate_mcp_server', { name: 'sentry' }, /sign-in of the MCP Server "sentry"/],
      [
        'add_mcp_server',
        { name: 'sentry', url: 'https://mcp.example.com/mcp' },
        /Register the remote MCP Server "sentry"/,
      ],
      ['read_keychain_secret', { service: 'TablePlus' }, /Read the saved password of "TablePlus"/],
    ];
    for (const mode of Object.values(AccessMode).filter((value) => value !== AccessMode.Full)) {
      for (const [tool, input, words] of asked) {
        const ctx = await start();
        const id = await ctx.session(mode);
        const held = await ctx.call(id, tool, input, 'approved');
        expect(held.summary, `${tool} in ${mode}`).toMatch(words);
        await held.run();
        await ctx.daemon.stop();
        running.pop();
      }
    }
  });

  it('runs the tool for a yes and not for a no, and tells the agent not to retry', async () => {
    const ctx = await start();
    const id = await ctx.session();
    const refused = await ctx.call(id, 'save_connection', { ...SAVE, secret: 'plain-pw' }, 'denied');
    await ctx.idle(id);
    expect(ctx.daemon.sdk.ran).toEqual([]);
    expect((await ctx.http.get('/connections')).body.data).toEqual([]);
    expect(refused.summary).toContain('pg-orders');

    const yes = await ctx.call(id, 'save_connection', { ...SAVE, secret: 'plain-pw' }, 'approved');
    await yes.run();
    expect((await ctx.http.get('/connections')).body.data[0]).toMatchObject({ name: 'pg-orders', secret_stored: true });
  });

  it('asks about nothing but a PROD write in full access', async () => {
    const ctx = await start();
    const id = await ctx.session(AccessMode.Full);
    const held = await ctx.call(id, 'save_connection', { ...SAVE, secret: 'plain-pw' });
    expect(await ctx.pending()).toEqual([]);
    await held.run();
    expect((await ctx.http.get('/connections')).body.data).toHaveLength(1);
  });

  it('writes an Action Log row before each call, with no secret in it', async () => {
    const ctx = await start();
    const id = await ctx.session();
    const held = await ctx.call(id, 'test_connection', { ...PG, secret: 'plain-pw' }, 'approved');
    const rows = (await ctx.http.get('/action-log')).body.data as { command: string; outcome: string }[];
    expect(rows.map((row) => row.command)).toEqual(['test_connection postgres db.example.com:5432/orders']);
    await held.run();
    expect(JSON.stringify((await ctx.http.get('/action-log')).body)).not.toContain('plain-pw');
  });

  it('runs a read with no Approval and still logs it', async () => {
    const ctx = await start();
    const id = await ctx.session();
    await ctx.http.post('/connections', { ...SAVE, secret: 'pw-123456' });
    const held = await ctx.call(id, 'list_connections', {});
    expect(await ctx.pending()).toEqual([]);
    const answer = await held.run();
    expect(answer.content[0]?.text).toContain('"name":"pg-orders"');
    expect(answer.content[0]?.text).not.toContain('pw-123456');
    const rows = (await ctx.http.get('/action-log')).body.data as { command: string }[];
    expect(rows.map((row) => row.command)).toContain('list_connections');
  });

  it('refuses a placeholder that was never given before it asks, and adds only a remote MCP Server', async () => {
    const ctx = await start();
    const id = await ctx.session();
    ctx.daemon.sdk.script({ tool: anonymousToolId('save_connection'), input: { ...SAVE, secret: '{{secret:9}}' } });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'save it' });
    await ctx.idle(id);
    expect(await ctx.pending()).toEqual([]);
    expect(ctx.daemon.sdk.ran).toEqual([]);

    ctx.daemon.sdk.script({
      tool: anonymousToolId('add_mcp_server'),
      input: { name: 'shell', url: 'touch /tmp/owned', transport: 'stdio' },
    });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'add it' });
    await ctx.idle(id);
    expect(await ctx.pending()).toEqual([]);
    expect(
      ((await ctx.http.get('/mcp-servers')).body.data as { name: string }[]).map((server) => server.name),
    ).not.toContain('shell');
  });
});

describe('a secret never reaches the agent', () => {
  it('goes from the masked field to the Keychain: the agent gets a placeholder and nothing else holds the value', async () => {
    const ctx = await start();
    const id = await ctx.session();
    const seen = await listen(ctx.daemon);
    const asking = await ctx.call(id, 'request_secret', { label: 'Postgres password for orders' });
    const answered = asking.run();

    const [request] = await until(
      async () =>
        (await ctx.http.get(`/sessions/${id}/secret-requests`)).body.data as { request_id: string; label: string }[],
      (list) => list.length === 1,
      'the masked field',
    );
    expect(request?.label).toBe('Postgres password for orders');
    expect(
      (await ctx.http.post(`/sessions/${id}/secret-requests/${request?.request_id}`, { value: 'typed-in-field' }))
        .status,
    ).toBe(204);
    const placeholder = (await answered).content[0]?.text;
    expect(placeholder).toBe('{"placeholder":"{{secret:1}}"}');
    expect((await ctx.http.get(`/sessions/${id}/secret-requests`)).body.data).toEqual([]);

    // The agent passes the placeholder on; the daemon swaps it back in for the test and the save.
    const test = await ctx.call(id, 'test_connection', { ...PG, secret: '{{secret:1}}' }, 'approved');
    await test.run();
    expect(ctx.tester.runs.at(-1)?.launch.env.DSN).toContain('typed-in-field');
    const save = await ctx.call(id, 'save_connection', { ...SAVE, secret: '{{secret:1}}' }, 'approved');
    await save.run();
    const saved = (await ctx.http.get('/connections')).body.data[0];
    expect(ctx.keychain.values.get(`connection:${saved.id}`)).toBe('typed-in-field');

    expect(await everywhere(ctx, id, seen.events)).not.toContain('typed-in-field');
    seen.close();
  });

  it('answers a Keychain read with a placeholder, never the password', async () => {
    const ctx = await start();
    const id = await ctx.session();
    const seen = await listen(ctx.daemon);
    const held = await ctx.call(id, 'read_keychain_secret', { service: 'TablePlus' }, 'approved');
    const answer = await held.run();
    expect(answer.content[0]?.text).toBe('{"placeholder":"{{secret:1}}"}');
    const test = await ctx.call(id, 'test_connection', { ...PG, secret: '{{secret:1}}' }, 'approved');
    await test.run();
    expect(ctx.tester.runs.at(-1)?.launch.env.DSN).toContain('kc-secret');
    expect(await everywhere(ctx, id, seen.events)).not.toContain('kc-secret');
    seen.close();
  });

  it('masks the secrets of a file and a page it reads, and a test still gets the real one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'local-source-'));
    const file = path.join(dir, 'connections.json');
    await writeFile(file, JSON.stringify([{ name: 'pg-orders', host: 'db.example.com', password: 'tp-secret' }]));
    const ctx = await start();
    const id = await ctx.session();
    const seen = await listen(ctx.daemon);
    const read = await ctx.call(id, 'read_local_file', { path: file });
    const answer = await read.run();
    expect(answer.content[0]?.text).toContain(String.raw`\"password\":\"{{secret:1}}\"`);
    expect(answer.content[0]?.text).not.toContain('tp-secret');
    const test = await ctx.call(id, 'test_connection', { ...PG, secret: '{{secret:1}}' }, 'approved');
    await test.run();
    expect(ctx.tester.runs.at(-1)?.launch.env.DSN).toContain('tp-secret');
    expect(await everywhere(ctx, id, seen.events)).not.toContain('tp-secret');
    seen.close();
  });

  it('takes the masked field away when the run is stopped', async () => {
    const ctx = await start();
    const id = await ctx.session();
    await ctx.call(id, 'request_secret', { label: 'Password' });
    const controller = new AbortController();
    const handler = ctx.tools().request_secret?.handler;
    if (!handler) throw new Error('request_secret is not offered');
    const waiting = handler({ label: 'Password' }, { signal: controller.signal });
    await until(
      async () => (await ctx.http.get(`/sessions/${id}/secret-requests`)).body.data.length,
      (count) => count === 1,
      'the masked field',
    );
    controller.abort();
    expect((await waiting).isError).toBe(true);
  });
});

describe('the setup tools read, list and add what the console holds', () => {
  it('lists the MCP Servers the console has without their headers, and adds a remote one with a placeholder header', async () => {
    const ctx = await start();
    const id = await ctx.session(AccessMode.Full);
    const asking = await ctx.call(id, 'request_secret', { label: 'Sentry token' });
    const secret = asking.run();
    const [request] = await until(
      async () => (await ctx.http.get(`/sessions/${id}/secret-requests`)).body.data as { request_id: string }[],
      (list) => list.length === 1,
      'the masked field',
    );
    await ctx.http.post(`/sessions/${id}/secret-requests/${request?.request_id}`, { value: 'mcp-token-1' });
    await secret;

    const add = await ctx.call(id, 'add_mcp_server', {
      name: 'sentry',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer {{secret:1}}' },
    });
    await add.run();
    const list = await ctx.call(id, 'list_mcp_servers', {});
    const text = (await list.run()).content[0]?.text ?? '';
    expect(text).toContain('"name":"sentry"');
    expect(text).not.toContain('mcp-token-1');
  });

  it('cannot change an existing Connection: a saved name is refused', async () => {
    const ctx = await start();
    const id = await ctx.session(AccessMode.Full);
    await ctx.http.post('/connections', { ...SAVE, secret: 'pw-123456' });
    const held = await ctx.call(id, 'save_connection', { ...SAVE, access: 'write', secret: 'x' });
    const answer = await held.run();
    expect(answer.isError).toBe(true);
    expect((await ctx.http.get('/connections')).body.data[0]).toMatchObject({ access: 'read' });
  });

  it('picks a part of a big JSON file, fetches a page with its secrets masked, and refuses other schemes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'local-source-'));
    const file = path.join(dir, '.claude.json');
    await writeFile(
      file,
      JSON.stringify({
        history: 'x'.repeat(600 * 1024),
        mcpServers: {
          sentry: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer hdr-secret' } },
        },
      }),
    );
    const server = createServer((_request, response) =>
      response.end('db:\n  url: postgres://reader:web-secret@db.example.com/orders\n'),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const ctx = await start();
      const id = await ctx.session();
      const seen = await listen(ctx.daemon);
      const pick = await ctx.call(id, 'read_local_file', { path: file, pick: ['mcpServers'] });
      const picked = (await pick.run()).content[0]?.text ?? '';
      expect(picked).toContain('https://mcp.example.com/mcp');
      expect(picked).toContain('{{secret:1}}');
      expect(picked).not.toContain('hdr-secret');

      const page = await ctx.call(id, 'fetch_url', { url: `http://127.0.0.1:${port}/team.yml` });
      const fetched = (await page.run()).content[0]?.text ?? '';
      expect(fetched).toContain('postgres://reader:{{secret:2}}@db.example.com/orders');

      const other = await ctx.call(id, 'fetch_url', { url: 'file:///etc/hosts' });
      expect((await other.run()).isError).toBe(true);
      expect(await everywhere(ctx, id, seen.events)).not.toMatch(/hdr-secret|web-secret/);
      seen.close();
    } finally {
      server.close();
    }
  });
});
