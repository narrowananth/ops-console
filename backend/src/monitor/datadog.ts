import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode, NO_ENV, type Sample, type ScanWindow } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { mapLimit } from '../common/map-limit';
import { normalizePath } from './fingerprint';
import {
  groupEntries,
  ignoredRanges,
  type LogGroup,
  type LogReader,
  type ReadRequest,
  type ServiceCount,
  type ServiceReading,
} from './log-reader';

const run = promisify(execFile);

/** The requests that failed: every HTTP status code from 400 up, or only `codes`. */
export const failingQuery = (codes: number[]) =>
  codes.length === 0 ? '@http.status_code:>=400' : `@http.status_code:(${[...codes].sort().join(' OR ')})`;

/** The query that picks one env's logs; `NO_ENV` picks the logs with no `env` tag. */
export const envQuery = (env: string) => (env === NO_ENV ? '-env:*' : `env:${env}`);

const bucketSchema = z.object({
  by: z.record(z.string(), z.unknown()),
  computes: z.record(z.string(), z.unknown()),
});
const aggregateSchema = z.object({ data: z.object({ buckets: z.array(bucketSchema) }) });
const searchSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z
        .object({
          timestamp: z.string().optional(),
          status: z.string().optional(),
          message: z.string().optional(),
          tags: z.array(z.string()).optional(),
          attributes: z.record(z.string(), z.unknown()).optional(),
        })
        .loose(),
    }),
  ),
});

/** Datadog returns at most this many logs per search; a Scan reads one page per Service. */
export const LOGS_PER_SERVICE = 1000;
const SERVICE_LIMIT = 500;
const ENV_LIMIT = 50;
const CODE_LIMIT = 100;
/** `pup` searches a Scan runs at once. */
const PUP_WORKERS = 4;
const REPO_TAG = 'git.repository_url:';

function field(attributes: Record<string, unknown>, ...keys: string[]): unknown {
  let at: unknown = attributes;
  for (const key of keys) at = at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined;
  return at;
}

/** What a log says went wrong: its message, else the error it carries. */
function messageOf(log: { message?: string; attributes?: Record<string, unknown> }): string {
  const attributes = log.attributes ?? {};
  const candidates = [
    log.message,
    field(attributes, 'error', 'message'),
    field(attributes, 'error', 'kind'),
    field(attributes, 'logger', 'name'),
  ];
  const found = candidates.find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return found ?? '(no message)';
}

/** The HTTP status code a log carries, as Datadog's `http.status_code` attribute; null when it has none. */
export function statusCodeOf(sample: Sample): number | null {
  const code = Number(field(sample.attributes, 'http', 'status_code'));
  return Number.isInteger(code) && code > 0 ? code : null;
}

/** The Route an HTTP log names; empty for a log with no request. */
function routeOf(sample: Sample): { method: string; path: string } {
  const method = field(sample.attributes, 'http', 'method');
  const path = field(sample.attributes, 'http', 'url_details', 'path');
  if (typeof method !== 'string' || typeof path !== 'string') return { method: '', path: '' };
  return { method: method.toUpperCase(), path: normalizePath(path) };
}

/**
 * The logs of one Service, newest first, as groups: one per Route and masked message. `scope` is the query that read
 * them; each group's query narrows it to its Route.
 */
export function groupLogs(logs: Sample[], scope: string): LogGroup[] {
  const entries = logs.map((sample) => ({ sample, statusCode: statusCodeOf(sample), ...routeOf(sample) }));
  return groupEntries(entries, ({ statusCode, method, path }) => {
    const parts = [scope];
    if (statusCode !== null) parts.push(`@http.status_code:${statusCode}`);
    if (method) parts.push(`@http.method:${method} @http.url_details.path:${path.replaceAll(':id', '*')}`);
    return parts.join(' ');
  });
}

/** `github.com/acme/orders` from the tag, or the attribute of that name, on any of the logs; null when none has it. */
export function repoUrlOf(logs: Sample[]): string | null {
  for (const sample of logs) {
    const tag = sample.tags.find((candidate) => candidate.startsWith(REPO_TAG));
    if (tag) return tag.slice(REPO_TAG.length) || null;
    const attribute = field(sample.attributes, 'git', 'repository_url') ?? sample.attributes['git.repository_url'];
    if (typeof attribute === 'string' && attribute !== '') return attribute;
  }
  return null;
}

/** `pup`, with the signed-in org. Errors name the tool and the cause class only: output may hold log content. */
export class PupDatadog implements LogReader {
  constructor(private readonly bin = 'pup') {}

  async read(request: ReadRequest): Promise<ServiceReading[]> {
    const out: ServiceReading[] = [];
    const ignored = ignoredRanges(request.ignore).map(([from, to]) => `-@http.status_code:[${from} TO ${to}]`);
    // The Services of every env are listed first, then read by a few `pup` workers at a time, in the order listed.
    const wanted: { env: string; name: string; scope: string }[] = [];
    for (const env of request.envs) {
      request.signal?.throwIfAborted();
      const scope = [envQuery(env), failingQuery(request.codes), ...ignored].join(' ');
      const names =
        request.services ?? (await this.counts(scope, request.window, request.signal)).map((count) => count.name);
      for (const name of names) wanted.push({ env, name, scope });
    }
    const read = await mapLimit(wanted, PUP_WORKERS, async ({ env, name, scope }): Promise<ServiceReading> => {
      request.signal?.throwIfAborted();
      const query = `${scope} service:${name}`;
      const logs = await this.search(query, request.window, request.signal);
      return { name, env, groups: groupLogs(logs, query), repoUrl: repoUrlOf(logs) };
    });
    out.push(...read);
    return out;
  }

  async envs(): Promise<string[]> {
    const buckets = await this.aggregate('*', '7d', 'env', ENV_LIMIT);
    return buckets.flatMap((bucket) => (typeof bucket.by.env === 'string' ? [bucket.by.env] : []));
  }

  async services(envs: string[], window: ScanWindow, codes: number[]): Promise<ServiceCount[]> {
    const perEnv = await Promise.all(
      envs.map(async (env) => {
        const counts = await this.counts(`${envQuery(env)} ${failingQuery(codes)}`, window);
        return counts.map((count) => ({ ...count, env }));
      }),
    );
    return perEnv.flat();
  }

  async statusCodes(window: ScanWindow): Promise<{ code: number; count: number }[]> {
    const buckets = await this.aggregate(failingQuery([]), window, '@http.status_code', CODE_LIMIT);
    return buckets.flatMap((bucket) => {
      const code = Number(bucket.by['@http.status_code']);
      return Number.isInteger(code) && code >= 400 ? [{ code, count: Number(bucket.computes.c0 ?? 0) }] : [];
    });
  }

  async countLogs(query: string, window: ScanWindow): Promise<number> {
    const buckets = await this.aggregate(query, window, 'service', SERVICE_LIMIT);
    return buckets.reduce((sum, bucket) => sum + Number(bucket.computes.c0 ?? 0), 0);
  }

  /** Every Service the query matches, busiest first: one dimension, so the group cap is no problem. */
  private async counts(
    query: string,
    window: ScanWindow,
    signal?: AbortSignal,
  ): Promise<{ name: string; errors: number }[]> {
    const buckets = await this.aggregate(query, window, 'service', SERVICE_LIMIT, signal);
    return buckets.flatMap((bucket) => {
      const count = Number(bucket.computes.c0 ?? 0);
      return typeof bucket.by.service === 'string' ? [{ name: bucket.by.service, errors: count }] : [];
    });
  }

  private async aggregate(query: string, from: string, groupBy: string, limit: number, signal?: AbortSignal) {
    const args = [
      'logs',
      'aggregate',
      // Joined, so a query that opens with `-` (`-env:*`) is not read as a flag.
      `--query=${query}`,
      '--from',
      from,
      '--compute',
      'count',
      '--group-by',
      groupBy,
      '--limit',
      String(limit),
      // Flex is not on every account; the default tries it first and prints a failure before it falls back.
      '--storage',
      'indexes',
    ];
    return aggregateSchema.parse(JSON.parse(await this.exec(args, signal))).data.buckets;
  }

  /** The newest logs in the window, newest first. */
  private async search(query: string, window: ScanWindow, signal?: AbortSignal): Promise<Sample[]> {
    const args = ['logs', 'search', `--query=${query}`, '--from', window, '--limit', String(LOGS_PER_SERVICE)];
    const out = searchSchema.parse(JSON.parse(await this.exec([...args, '--storage', 'indexes'], signal)));
    return out.data.map((log) => ({
      id: log.id,
      timestamp: log.attributes.timestamp ?? '',
      status: log.attributes.status ?? 'error',
      message: messageOf(log.attributes),
      attributes: log.attributes.attributes ?? {},
      tags: log.attributes.tags ?? [],
    }));
  }

  private async exec(args: string[], signal?: AbortSignal): Promise<string> {
    try {
      const pending = run(this.bin, [...args, '--output', 'json'], {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 120_000,
        signal,
      });
      pending.child.stdin?.end();
      return (await pending).stdout;
    } catch (error) {
      // A stopped Scan is the caller's to end, not an upstream failure.
      if (signal?.aborted) throw signal.reason;
      const { stderr } = error as { stderr?: unknown };
      if (typeof stderr === 'string' && /\bHTTP 429\b|too many requests/i.test(stderr)) {
        throw new ApiError(429, ErrorCode.RateLimited, 'Datadog rate limit reached');
      }
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`pup ${args.slice(0, 2).join(' ')}\` failed`);
    }
  }
}
