import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_CLI, type ClaudeCli } from '../src/claude-cli/claude-cli';
import { MCP_CLIENT, type McpClient } from '../src/mcp-client/mcp-client';
import { startTestDaemon, type TestDaemon, tempDir } from './helpers';

let daemon: TestDaemon;
let record: string;

beforeAll(async () => {
  record = path.join(await tempDir(), 'claude-calls.jsonl');
  process.env.FAKE_CLAUDE_RECORD = record;
  daemon = await startTestDaemon();
});

afterAll(async () => {
  await daemon.stop();
});

describe('claude CLI wrapper', () => {
  it('lists registered MCP servers with their status', async () => {
    const servers = await daemon.app.get<ClaudeCli>(CLAUDE_CLI).mcpList();
    expect(servers.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'fake-stdio', status: 'connected' },
      { name: 'sentry', status: 'needs_auth' },
      { name: 'pg-prod', status: 'failed' },
    ]);
  });

  it('reads an HTTP server config', async () => {
    expect(await daemon.app.get<ClaudeCli>(CLAUDE_CLI).mcpGet('sentry')).toEqual({
      name: 'sentry',
      transport: 'http',
      url: 'https://mcp.sentry.dev/mcp',
      headers: { 'X-Org': 'example' },
    });
  });

  it('reports a server Claude Code does not know as upstream_failed', async () => {
    await expect(daemon.app.get<ClaudeCli>(CLAUDE_CLI).mcpGet('missing')).rejects.toMatchObject({
      code: 'upstream_failed',
    });
  });

  it('registers and removes servers with an argument array', async () => {
    const claude = daemon.app.get<ClaudeCli>(CLAUDE_CLI);
    await claude.mcpAdd({
      scope: 'user',
      name: 'pg-staging',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/pg-mcp', '--read-only'],
      env: { PGPASSWORD: 'p@ss word; rm -rf ~' },
    });
    await claude.mcpAdd({
      scope: 'local',
      name: 'sentry',
      transport: 'http',
      url: 'https://mcp.sentry.dev/mcp',
      headers: { Authorization: 'Bearer abc' },
    });
    await claude.mcpRemove('pg-staging', 'user');

    const calls = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    // `claude` sees its argv; a shell string would have split or run the password.
    expect(calls).toContainEqual([
      'add',
      '--scope',
      'user',
      '-e',
      'PGPASSWORD=p@ss word; rm -rf ~',
      'pg-staging',
      '--',
      'npx',
      '-y',
      '@example/pg-mcp',
      '--read-only',
    ]);
    expect(calls).toContainEqual([
      'add',
      '--scope',
      'local',
      '--transport',
      'http',
      '--header',
      'Authorization: Bearer abc',
      'sentry',
      'https://mcp.sentry.dev/mcp',
    ]);
    expect(calls).toContainEqual(['remove', 'pg-staging', '--scope', 'user']);
  });
});

describe('MCP client', () => {
  it('calls a tool on a registered stdio server with its env, no model turn', async () => {
    const result = await daemon.app
      .get<McpClient>(MCP_CLIENT)
      .callTool('fake-stdio', 'count_open_prs', { repo: 'shop-api' });
    expect(result.content).toEqual([{ type: 'text', text: 'hello from env: shop-api has 3 open PRs' }]);
  });

  it('reports a tool error as upstream_failed naming the server', async () => {
    await expect(daemon.app.get<McpClient>(MCP_CLIENT).callTool('fake-stdio', 'broken')).rejects.toMatchObject({
      code: 'upstream_failed',
      message: expect.stringContaining('fake-stdio'),
    });
  });
});
