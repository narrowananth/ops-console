import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type ConnectionTestResult, ConnectionType, HealthStatus } from '@ops-console/shared';
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
    const ping = pingFor(type);
    if (!ping) return { status: HealthStatus.Fail, latency_ms: null, detail: `no MCP server for ${type}` };
    const [command = '', ...args] = launch.target.split(' ');
    const client = new Client({ name: 'ops-console', version: this.version });
    const started = Date.now();
    const timer = setTimeout(() => void client.close(), TIMEOUT_MS);
    try {
      await client.connect(
        new StdioClientTransport({
          command,
          args,
          env: { ...getDefaultEnvironment(), ...launch.env },
          stderr: 'ignore',
        }),
      );
      const result = await client.callTool({ name: ping.tool, arguments: ping.args });
      if (result.isError)
        return { status: HealthStatus.Fail, latency_ms: null, detail: scrub(firstText(result), launch) };
      return { status: HealthStatus.Ok, latency_ms: Date.now() - started, detail: null };
    } catch (error) {
      return {
        status: HealthStatus.Fail,
        latency_ms: null,
        detail: scrub(String((error as Error).message ?? error), launch),
      };
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => {});
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
