import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectionType, HealthStatus } from '@ops-console/shared';
import { describe, expect, it } from 'vitest';
import { McpConnectionTester } from '../src/connections/connection-tester';
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
