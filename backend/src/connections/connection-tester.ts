import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type ConnectionTestResult, ConnectionType, HealthStatus } from '@ops-console/shared';
import { materialize } from '../mcp/launcher';
import { type Launch, pingFor } from './launch';

export const CONNECTION_TESTER = Symbol('CONNECTION_TESTER');

/** Starts a Connection's server with the secret held in memory and runs one read. Tests replace it with a scripted fake. */
export interface ConnectionTester {
  run(type: ConnectionType, launch: Launch): Promise<ConnectionTestResult>;
}

const TIMEOUT_MS = 30_000;

export class McpConnectionTester implements ConnectionTester {
  constructor(private readonly version: string) {}

  async run(type: ConnectionType, launch: Launch): Promise<ConnectionTestResult> {
    const ping = launch.ping ?? pingFor(type);
    if (!ping) return { status: HealthStatus.Fail, latency_ms: null, detail: `no MCP server for ${type}` };
    const [command = '', ...args] = launch.target.split(' ');
    const ready = await materialize(launch.env, args);
    const client = new Client({ name: 'ops-console', version: this.version });
    const started = Date.now();
    const timer = setTimeout(() => void client.close(), TIMEOUT_MS);
    const transport = new StdioClientTransport({
      command,
      args: ready.args,
      env: { ...getDefaultEnvironment(), ...ready.env },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-20_000);
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: ping.tool, arguments: ping.args });
      if (result.isError)
        return { status: HealthStatus.Fail, latency_ms: null, detail: scrub(firstText(result), launch) };
      return { status: HealthStatus.Ok, latency_ms: Date.now() - started, detail: null };
    } catch (error) {
      // A server that exits at start only tells the client the connection closed; its stderr says why.
      const reason = stderr.split('\n').findLast((line) => /\berror\b/i.test(line) && !/^\s/.test(line));
      return {
        status: HealthStatus.Fail,
        latency_ms: null,
        detail: scrub(reason ?? String((error as Error).message ?? error), launch),
      };
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => {});
      await ready.cleanup();
    }
  }
}

function firstText(result: object): string {
  const raw = (result as { content?: unknown }).content;
  const content = Array.isArray(raw) ? (raw as { type?: string; text?: string }[]) : [];
  return (content.find((part) => part.type === 'text')?.text ?? 'the read failed').split('\n')[0] ?? 'the read failed';
}

/** No response carries a secret (Behavior 10). */
function scrub(text: string, launch: Launch): string {
  let out = text.slice(0, 300);
  for (const value of Object.values(launch.env)) if (value.length > 0) out = out.split(value).join('***');
  return out;
}
