import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CONNECTOR_SERVERS, ConnectorId } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { launcherArgv, unwrapLauncher } from '../src/mcp/launcher';
import { splitCommand } from '../src/mcp/mcp-servers.service';
import { tempDir } from './helpers';

const run = promisify(execFile);
const MARKER = 'rnd_header-proof-6Hk2Qx9Vb3Lw';
const EXEC = path.resolve(import.meta.dirname, 'fakes/render-exec.ts');

type Seen = { method: string; url: string; authorization: string | undefined };

/** Enough of MCP's streamable HTTP for a client to initialize and list tools, recording each request's header. */
async function standIn(): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization });
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'render-stand-in', version: '1' },
            }
          : { tools: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const one of open.splice(0)) await one.close().catch(() => {});
});

describe('the Render server through the real launcher and the real mcp-remote', () => {
  it('sends Authorization: Bearer <key> to the server, from the env var, and prints the key nowhere', async (context) => {
    // The package comes from the real registry; with it unreachable nothing is proved, so nothing is claimed.
    const registry = await run('npm', ['view', 'mcp-remote', 'version'], { timeout: 20_000 }).catch(() => null);
    if (!registry) return context.skip();

    const server = await standIn();
    open.push(server);
    const packages = await tempDir('render-packages-');
    const authDir = await tempDir('render-mcp-auth-');

    // The words the console registers, as `claude mcp add` is given them and `mcp-exec` reads them back.
    const spec = CONNECTOR_SERVERS[ConnectorId.Render] as { target: string };
    const [command, ...args] = splitCommand(spec.target).map((word) =>
      word === 'https://mcp.render.com/mcp' ? server.url : word,
    );
    const [launcher, launcherArgs] = launcherArgv('/opt/ops-console', 'render', command as string, [
      ...args,
      '--allow-http',
    ]);
    const wrapped = unwrapLauncher(launcher, launcher, launcherArgs);
    expect(wrapped).toMatchObject({ name: 'render', command: 'npx' });
    // The env var reference reaches the launcher untouched: nothing before mcp-remote expands it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: mcp-remote's own variable reference, not a template
    expect(wrapped?.args).toContain('Authorization:${RENDER_AUTH}');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        EXEC,
        packages,
        `Bearer ${MARKER}`,
        wrapped?.command as string,
        ...(wrapped?.args ?? []),
      ],
      env: { ...getDefaultEnvironment(), MCP_REMOTE_CONFIG_DIR: authDir },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-20_000);
    });
    const client = new Client({ name: 'render-header-proof', version: '1' });
    try {
      await client.connect(transport);
      expect(await client.listTools()).toEqual({ tools: [] });
    } finally {
      await client.close().catch(() => {});
    }

    // Every call to the MCP address, the first one included, carried the header with the env var's value. The
    // client's probe of the OAuth discovery document is not one and sends none.
    const calls = server.seen.filter((request) => request.url === '/mcp');
    expect(calls.map((request) => request.method)).toContain('POST');
    for (const request of calls) expect(request.authorization, request.method).toBe(`Bearer ${MARKER}`);
    // What mcp-remote prints for Claude Code, and keeps in its own folder, holds no key.
    expect(stderr).not.toContain(MARKER);
    for (const file of await readdir(authDir, { recursive: true, withFileTypes: true })) {
      if (file.isFile())
        expect(await readFile(path.join(file.parentPath, file.name), 'utf8'), file.name).not.toContain(MARKER);
    }
  }, 240_000);
});
