import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode, NO_ENV, SAMPLE_LIMIT, type Sample, type ScanWindow } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { maskSignature, normalizePath } from './fingerprint';

const run = promisify(execFile);

export const DATADOG_READER = Symbol('DATADOG_READER');

export type IgnoreRule = { kind: 'status_class' | 'route'; value: string };

/**
 * One kind of failure as a Scan saw it: the logs of one Service that share an HTTP status code, a masked message and a
 * Route. `method` and `path` are empty for logs that name no request path. `errors` counts the logs read in the window;
 * `peakPer10m` is their worst 10-minute bucket.
 */
export type LogGroup = {
  method: string;
  path: string;
  /** The HTTP status code the requests answered with. */
  statusCode: number | null;
  errors: number;
  peakPer10m: number;
  /** Newest first, up to 25. */
  samples: Sample[];
  query: string;
};

export type ServiceReading = {
  name: string;
  env: string;
  groups: LogGroup[];
  /** The `git.repository_url` tag on the Service's logs, when Datadog's source code integration sets it. */
  repoUrl: string | null;
};

export type ReadRequest = {
  envs: string[];
  window: ScanWindow;
  /** Only these Services; every Service with failing requests when null. */
  services: string[] | null;
  /** Only these HTTP status codes; every code from 400 up when empty. */
  codes: number[];
  ignore: IgnoreRule[];
};

/** Datadog as a Scan reads it (ADR 0005: fixed reads, no model turn). Tests replace it with a scripted fake. */
export interface DatadogReader {
  /** Throws `rate_limited` when Datadog throttles, `upstream_failed` when it cannot be reached. */
  read(request: ReadRequest): Promise<ServiceReading[]>;
  /** Every `env` tag with logs in the last 7 days. */
  envs(): Promise<string[]>;
  /** The Services with failing requests in each env over the window, and how many. */
  services(envs: string[], window: ScanWindow, codes: number[]): Promise<ServiceCount[]>;
  /** Each HTTP status code from 400 up with requests in the window, every env together, busiest first. */
  statusCodes(window: ScanWindow): Promise<{ code: number; count: number }[]>;
}

export type ServiceCount = { name: string; env: string; errors: number };

/** Datadog's statuses at error level and above: it keeps `emergency`, `alert` and `critical` apart from `error`. */
export const ERROR_LEVEL = ['emergency', 'alert', 'critical', 'error'];

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
const TEN_MINUTES = 600_000;
const REPO_TAG = 'git.repository_url:';

/** `4xx` becomes a Datadog range on the status code. */
function statusRange(value: string): string | null {
  const match = /^([1-5])xx$/i.exec(value);
  return match ? `-@http.status_code:[${match[1]}00 TO ${match[1]}99]` : null;
}

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
  const groups = new Map<string, LogGroup & { buckets: Map<number, number> }>();
  for (const sample of logs) {
    const { method, path } = routeOf(sample);
    const statusCode = statusCodeOf(sample);
    const key = `${statusCode} ${method} ${path}\n${maskSignature(sample.message)}`;
    let group = groups.get(key);
    if (!group) {
      const parts = [scope];
      if (statusCode !== null) parts.push(`@http.status_code:${statusCode}`);
      if (method) parts.push(`@http.method:${method} @http.url_details.path:${path.replaceAll(':id', '*')}`);
      const query = parts.join(' ');
      group = { method, path, statusCode, errors: 0, peakPer10m: 0, samples: [], query, buckets: new Map() };
      groups.set(key, group);
    }
    group.errors += 1;
    if (group.samples.length < SAMPLE_LIMIT) group.samples.push(sample);
    const bucket = Math.floor(Date.parse(sample.timestamp) / TEN_MINUTES);
    if (!Number.isNaN(bucket)) {
      const count = (group.buckets.get(bucket) ?? 0) + 1;
      group.buckets.set(bucket, count);
      group.peakPer10m = Math.max(group.peakPer10m, count);
    }
  }
  return [...groups.values()].map(({ buckets: _buckets, ...group }) => group);
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
export class PupDatadog implements DatadogReader {
  constructor(private readonly bin = 'pup') {}

  async read(request: ReadRequest): Promise<ServiceReading[]> {
    const out: ServiceReading[] = [];
    const ignored = request.ignore.flatMap((rule) => {
      const range = rule.kind === 'status_class' ? statusRange(rule.value) : null;
      return range ? [range] : [];
    });
    for (const env of request.envs) {
      const scope = [envQuery(env), failingQuery(request.codes), ...ignored].join(' ');
      const names = request.services ?? (await this.counts(scope, request.window)).map((count) => count.name);
      for (const name of names) {
        const query = `${scope} service:${name}`;
        const logs = await this.search(query, request.window);
        out.push({ name, env, groups: groupLogs(logs, query), repoUrl: repoUrlOf(logs) });
      }
    }
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

  /** Every Service the query matches, busiest first: one dimension, so the group cap is no problem. */
  private async counts(query: string, window: ScanWindow): Promise<{ name: string; errors: number }[]> {
    const buckets = await this.aggregate(query, window, 'service', SERVICE_LIMIT);
    return buckets.flatMap((bucket) => {
      const count = Number(bucket.computes.c0 ?? 0);
      return typeof bucket.by.service === 'string' ? [{ name: bucket.by.service, errors: count }] : [];
    });
  }

  private async aggregate(query: string, from: string, groupBy: string, limit: number) {
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
    return aggregateSchema.parse(JSON.parse(await this.exec(args))).data.buckets;
  }

  /** The newest logs in the window, newest first. */
  private async search(query: string, window: ScanWindow): Promise<Sample[]> {
    const args = ['logs', 'search', `--query=${query}`, '--from', window, '--limit', String(LOGS_PER_SERVICE)];
    const out = searchSchema.parse(JSON.parse(await this.exec([...args, '--storage', 'indexes'])));
    return out.data.map((log) => ({
      id: log.id,
      timestamp: log.attributes.timestamp ?? '',
      status: log.attributes.status ?? 'error',
      message: messageOf(log.attributes),
      attributes: log.attributes.attributes ?? {},
      tags: log.attributes.tags ?? [],
    }));
  }

  private async exec(args: string[]): Promise<string> {
    try {
      const pending = run(this.bin, [...args, '--output', 'json'], { maxBuffer: 50 * 1024 * 1024, timeout: 120_000 });
      pending.child.stdin?.end();
      return (await pending).stdout;
    } catch (error) {
      const { stderr } = error as { stderr?: unknown };
      if (typeof stderr === 'string' && /\bHTTP 429\b|too many requests/i.test(stderr)) {
        throw new ApiError(429, ErrorCode.RateLimited, 'Datadog rate limit reached');
      }
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`pup ${args.slice(0, 2).join(' ')}\` failed`);
    }
  }
}
