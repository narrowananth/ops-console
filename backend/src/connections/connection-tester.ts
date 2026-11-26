import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type ConnectionTestResult, type ConnectionType, HealthStatus } from '@ops-console/shared';
import { materialize, packagesBase } from '../mcp/launcher';
import { discardBroken, isModuleMissing, NpmPackages, type Prepared, QUICK_FAIL_MS } from '../mcp/npm-packages';
import { type Launch, pingFor } from './launch';

export const CONNECTION_TESTER = Symbol('CONNECTION_TESTER');

/**
 * Starts a Connection's server with the secret held in memory and runs one read. Tests replace it with a scripted fake.
 * With `pool` the server stays up for the next check of the same Connection.
 */
export interface ConnectionTester {
  run(type: ConnectionType, launch: Launch, pool?: string): Promise<ConnectionTestResult>;
  /** Stops the kept server of a Connection that was edited or deleted. */
  forget?(pool: string): Promise<void>;
  /** Stops every kept server. */
  close?(): Promise<void>;
}

const TIMEOUT_MS = 30_000;
/** A kept server is stopped after this long without a check. */
export const POOL_IDLE_MS = 5 * 60_000;

/** `npx …@latest` asks the npm registry first; a check uses the cache, as the launcher does for a run. */
const QUIET_NPM = { npm_config_prefer_offline: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false' };

/** A started server and what it was started with: a changed launch makes a new one. */
type Kept = { client: Client; hash: string; stop: () => Promise<void>; idle?: ReturnType<typeof setTimeout> };

export class McpConnectionTester implements ConnectionTester {
  private readonly kept = new Map<string, Kept>();

  constructor(
    private readonly version: string,
    private readonly idleMs = POOL_IDLE_MS,
    private readonly packages = new NpmPackages(packagesBase()),
  ) {}

  async run(type: ConnectionType, launch: Launch, pool?: string): Promise<ConnectionTestResult> {
    const ping = launch.ping ?? pingFor(type);
    if (!ping) return { status: HealthStatus.Fail, latency_ms: null, detail: `no MCP server for ${type}` };
    const started = Date.now();
    const pooled = pool === undefined ? undefined : { pool, hash: hashOf(launch) };
    const reused = pooled && this.take(pooled);
    if (reused && pooled) {
      try {
        const result = await within(reused.client.callTool({ name: ping.tool, arguments: ping.args }));
        this.keep(pooled.pool, reused);
        return answer(result, launch, started);
      } catch {
        // The server went away since the last check: start it again below.
        await reused.stop();
      }
    }
    return this.start(ping, launch, started, pooled);
  }

  async forget(pool: string): Promise<void> {
    const kept = this.kept.get(pool);
    if (!kept) return;
    this.kept.delete(pool);
    clearTimeout(kept.idle);
    await kept.stop();
  }

  async close(): Promise<void> {
    await Promise.all([...this.kept.keys()].map((pool) => this.forget(pool)));
  }

  /** The kept server of a Connection when it was started with this launch, taken out of the pool while it is used. */
  private take({ pool, hash }: { pool: string; hash: string }): Kept | undefined {
    const kept = this.kept.get(pool);
    if (!kept) return undefined;
    clearTimeout(kept.idle);
    this.kept.delete(pool);
    if (kept.hash === hash) return kept;
    void kept.stop();
    return undefined;
  }

  private keep(pool: string, kept: Kept): void {
    clearTimeout(kept.idle);
    kept.idle = setTimeout(() => void this.forget(pool), this.idleMs);
    kept.idle.unref();
    this.kept.set(pool, kept);
  }

  /** Starts the server and runs the read; a server that dies at start for a missing module is installed afresh once. */
  private async start(
    ping: { tool: string; args: Record<string, unknown> },
    launch: Launch,
    started: number,
    pooled?: { pool: string; hash: string },
  ): Promise<ConnectionTestResult> {
    const first = await this.attempt(ping, launch, started, pooled);
    if (!first.broken) return first.result;
    await discardBroken(first.broken.prepared, first.broken.stderr);
    return (await this.attempt(ping, launch, started, pooled)).result;
  }

  private async attempt(
    ping: { tool: string; args: Record<string, unknown> },
    launch: Launch,
    started: number,
    pooled?: { pool: string; hash: string },
  ): Promise<{ result: ConnectionTestResult; broken?: { prepared: Prepared; stderr: string } }> {
    const began = Date.now();
    const [command = '', ...args] = launch.target.split(' ');
    const ready = await materialize(launch.env, args);
    const prepared = await this.packages.prepare(command, ready.args);
    const client = new Client({ name: 'ops-console', version: this.version });
    const timer = setTimeout(() => void client.close(), TIMEOUT_MS);
    const transport = new StdioClientTransport({
      command: prepared.command,
      args: prepared.args,
      env: { ...getDefaultEnvironment(), ...QUIET_NPM, ...ready.env },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-20_000);
    });
    const stop = async () => {
      await client.close().catch(() => {});
      await ready.cleanup();
    };
    let keepIt = false;
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: ping.tool, arguments: ping.args });
      const outcome = answer(result, launch, started);
      keepIt = pooled !== undefined && outcome.status === HealthStatus.Ok;
      return { result: outcome };
    } catch (error) {
      // A server that exits at start only tells the client the connection closed; its stderr says why.
      const reason = stderr.split('\n').findLast((line) => /\berror\b/i.test(line) && !/^\s/.test(line));
      const result = {
        status: HealthStatus.Fail,
        latency_ms: null,
        detail: scrub(reason ?? String((error as Error).message ?? error), launch),
      };
      const quick = Date.now() - began < QUICK_FAIL_MS && isModuleMissing(stderr);
      return { result, broken: quick ? { prepared, stderr } : undefined };
    } finally {
      clearTimeout(timer);
      if (keepIt && pooled) {
        this.keep(pooled.pool, { client, hash: pooled.hash, stop });
      } else await stop();
    }
  }
}

/** One check's call to a kept server ends after the same limit as a first start. */
function within<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the check timed out')), TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** What a started server answers a check with. */
function answer(result: object, launch: Launch, started: number): ConnectionTestResult {
  if ((result as { isError?: boolean }).isError) {
    return { status: HealthStatus.Fail, latency_ms: null, detail: scrub(firstText(result), launch) };
  }
  return { status: HealthStatus.Ok, latency_ms: Date.now() - started, detail: null };
}

/** The launch as one value, so a changed target, env var or ping makes a new server. The hash stays in memory. */
function hashOf(launch: Launch): string {
  return createHash('sha256')
    .update(JSON.stringify([launch.target, launch.env, launch.ping ?? null]))
    .digest('hex');
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
