import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectionType, HealthStatus } from '@ops-console/shared';
import { describe, expect, it } from 'vitest';
import { McpConnectionTester } from '../src/connections/connection-tester';
import { NpmPackages } from '../src/mcp/npm-packages';
import { fakeNpm } from './fakes/npm';
import { tempDir } from './helpers';

describe('McpConnectionTester', () => {
  it('says why a server that exits at start failed, with the secret hidden', async () => {
    const script = path.join(await tempDir(), 'server.js');
    await writeFile(
      script,
      [
        "console.error('starting');",
        `console.error('Fatal error: password authentication failed for user "reader" (' + process.env.DSN + ')');`,
        "console.error('  routine: auth_failed');",
        'process.exit(1);',
      ].join('\n'),
    );
    const result = await new McpConnectionTester('test').run(ConnectionType.Postgres, {
      target: `${process.execPath} ${script}`,
      env: { DSN: 'postgres://reader:hunter2@db.example.com/orders' },
    });
    expect(result.status).toBe(HealthStatus.Fail);
    expect(result.detail).toBe('Fatal error: password authentication failed for user "reader" (***)');
  });
});

describe('McpConnectionTester answers', () => {
  async function serverAnswering(text: string) {
    const script = path.join(await tempDir(), 'server.mjs');
    await writeFile(
      script,
      `import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
const server = new McpServer({ name: 'fake', version: '1.0.0' });
server.registerTool('read', {}, () => ({ content: [{ type: 'text', text: ${JSON.stringify(text)} }] }));
await server.connect(new StdioServerTransport());`,
    );
    return { target: `${process.execPath} ${script}`, env: {}, ping: { tool: 'read', args: {} } };
  }

  it('fails a Firebase read that answers only an error, as the missing database does, and passes a null read', async () => {
    const missing = await new McpConnectionTester('test').run(
      ConnectionType.Firebase,
      await serverAnswering('{\n  "error" : "404 Not Found"\n}\n'),
    );
    expect(missing).toMatchObject({ status: HealthStatus.Fail, detail: '404 Not Found' });
    const empty = await new McpConnectionTester('test').run(ConnectionType.Firebase, await serverAnswering('null'));
    expect(empty.status).toBe(HealthStatus.Ok);
  });
});

describe('McpConnectionTester pool', () => {
  /** A server that counts its starts in a file, and answers `ping` with a pid. */
  async function counting() {
    const dir = await tempDir();
    const starts = path.join(dir, 'starts');
    const script = path.join(dir, 'server.mjs');
    await writeFile(
      script,
      `import { appendFileSync } from 'node:fs';
import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
appendFileSync(${JSON.stringify(starts)}, 'x');
const server = new McpServer({ name: 'fake', version: '1.0.0' });
server.registerTool('ping', {}, () => ({ content: [{ type: 'text', text: 'pong' }] }));
await server.connect(new StdioServerTransport());`,
    );
    const launch = { target: `${process.execPath} ${script}`, env: { DSN: 'a' }, ping: { tool: 'ping', args: {} } };
    return { launch, count: async () => (await readFile(starts, 'utf8').catch(() => '')).length };
  }

  it('starts the server once for repeat checks of one Connection, and again after it is forgotten', async () => {
    const { launch, count } = await counting();
    const tester = new McpConnectionTester('test');
    try {
      expect((await tester.run(ConnectionType.Postgres, launch, 'one')).status).toBe(HealthStatus.Ok);
      expect((await tester.run(ConnectionType.Postgres, launch, 'one')).status).toBe(HealthStatus.Ok);
      expect(await count()).toBe(1);
      await tester.forget('one');
      expect((await tester.run(ConnectionType.Postgres, launch, 'one')).status).toBe(HealthStatus.Ok);
      expect(await count()).toBe(2);
    } finally {
      await tester.close();
    }
  });

  it('starts a new server when the Connection’s launch changed, and starts one per check without a pool', async () => {
    const { launch, count } = await counting();
    const tester = new McpConnectionTester('test');
    try {
      await tester.run(ConnectionType.Postgres, launch, 'one');
      await tester.run(ConnectionType.Postgres, { ...launch, env: { DSN: 'b' } }, 'one');
      expect(await count()).toBe(2);
      await tester.run(ConnectionType.Postgres, launch);
      await tester.run(ConnectionType.Postgres, launch);
      expect(await count()).toBe(4);
    } finally {
      await tester.close();
    }
  });

  it('stops a kept server after it sits idle', async () => {
    const { launch, count } = await counting();
    const tester = new McpConnectionTester('test', 100);
    await tester.run(ConnectionType.Postgres, launch, 'one');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await tester.run(ConnectionType.Postgres, launch, 'one');
    expect(await count()).toBe(2);
    await tester.close();
  });
});

describe('McpConnectionTester of npx servers', () => {
  const TARGET = 'npx -y @bytebase/dbhub@latest --transport stdio';
  const ping = { tool: 'ping', args: {} };

  /** A package whose bin is an MCP server that logs each start's arguments, and dies at start `failures` times first. */
  async function installed(failures: number) {
    const dir = await tempDir();
    const starts = path.join(dir, 'starts');
    const server = path.join(dir, 'server.mjs');
    await writeFile(
      server,
      `import { appendFileSync, readFileSync } from 'node:fs';
import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
appendFileSync(${JSON.stringify(starts)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (readFileSync(${JSON.stringify(starts)}, 'utf8').split('\\n').length <= ${failures + 1}) {
  console.error("Error: Cannot find module 'iconv-lite'");
  process.exit(1);
}
const server = new McpServer({ name: 'fake', version: '1.0.0' });
server.registerTool('ping', {}, () => ({ content: [{ type: 'text', text: 'pong' }] }));
await server.connect(new StdioServerTransport());`,
    );
    const fake = fakeNpm({ script: () => `import(${JSON.stringify(`file://${server}`)});` });
    const tester = new McpConnectionTester('test', undefined, new NpmPackages(await tempDir(), { npm: fake.npm }));
    const started = async () =>
      (await readFile(starts, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    return { tester, fake, started };
  }

  it('starts the installed package, so a check starts what a run starts', async () => {
    const { tester, fake, started } = await installed(0);
    const result = await tester.run(ConnectionType.Postgres, { target: TARGET, env: {}, ping });
    expect(result.status).toBe(HealthStatus.Ok);
    expect(await started()).toEqual([['--transport', 'stdio']]);
    expect(fake.state.installs).toBe(1);
    await tester.close();
  });

  it('leaves uvx alone', async () => {
    const { tester, fake } = await installed(0);
    await tester.run(ConnectionType.Clickhouse, { target: 'uvx mcp-clickhouse', env: {}, ping });
    expect(fake.calls).toEqual([]);
  });

  it('installs again and starts once more when the server dies at start for a missing module', async () => {
    const { tester, fake, started } = await installed(1);
    const result = await tester.run(ConnectionType.Postgres, { target: TARGET, env: {}, ping });
    expect(result.status).toBe(HealthStatus.Ok);
    expect(await started()).toHaveLength(2);
    expect(fake.state.installs).toBe(2);
    await tester.close();
  });

  it('retries only once and says why the second start failed', async () => {
    const { tester, fake, started } = await installed(5);
    const result = await tester.run(ConnectionType.Postgres, { target: TARGET, env: {}, ping });
    expect(result).toMatchObject({ status: HealthStatus.Fail, detail: "Error: Cannot find module 'iconv-lite'" });
    expect(await started()).toHaveLength(2);
    expect(fake.state.installs).toBe(2);
  });
});
