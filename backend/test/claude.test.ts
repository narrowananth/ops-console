import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_CLI, type ClaudeCli, claudeEnv } from '../src/claude-cli/claude-cli';
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

  it('registers and removes servers with an argument array, secrets off the command line', async () => {
    const claude = daemon.app.get<ClaudeCli>(CLAUDE_CLI);
    const target = { configDir: await tempDir() };
    await claude.mcpAdd(
      {
        scope: 'user',
        name: 'pg-staging',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/pg-mcp', '--read-only', 'a b; rm -rf ~'],
      },
      target,
    );
    await claude.mcpAdd(
      {
        scope: 'local',
        name: 'sentry',
        transport: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        headers: { Authorization: 'Bearer abc' },
      },
      target,
    );
    await claude.mcpRemove('pg-staging', 'user', target);

    const calls = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    // `claude` sees its argv; a shell string would have split or run the argument.
    expect(calls).toContainEqual([
      'add',
      '--scope',
      'user',
      'pg-staging',
      '--',
      'npx',
      '-y',
      '@example/pg-mcp',
      '--read-only',
      'a b; rm -rf ~',
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

describe('claudeEnv', () => {
  it('drops shell credentials for an added account and keeps them for the operator’s own setup', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'shell-token';
    process.env.ANTHROPIC_API_KEY = 'shell-key';
    try {
      const added = claudeEnv('/data/accounts/a');
      expect(added.CLAUDE_CONFIG_DIR).toBe('/data/accounts/a');
      expect(added.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(added.ANTHROPIC_API_KEY).toBeUndefined();
      expect(claudeEnv(null).ANTHROPIC_AUTH_TOKEN).toBe('shell-token');
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
