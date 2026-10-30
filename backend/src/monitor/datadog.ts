import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type CheckInterval, ErrorCode, type Sample } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { normalizePath } from './fingerprint';

const run = promisify(execFile);

export const DATADOG_READER = Symbol('DATADOG_READER');

export type IgnoreRule = { kind: 'status_class' | 'route'; value: string };

/** One Route as a Scan saw it. `errors` counts the Scan window; `peakPer10m` is its worst 10-minute bucket. */
export type RouteReading = {
  method: string;
  path: string;
  requests: number;
  errors: number;
  peakPer10m: number;
  /** Newest first, up to 25. */
  samples: Sample[];
  query: string;
};

export type ServiceReading = { name: string; env: string; routes: RouteReading[] };

export type ReadRequest = {
  envs: string[];
  window: CheckInterval;
  /** Only this Service; every Service when null. */
  service: string | null;
  ignore: IgnoreRule[];
};

/** Datadog as a Scan reads it (ADR 0005: fixed reads, no model turn). Tests replace it with a scripted fake. */
export interface DatadogReader {
  /** Throws `rate_limited` when Datadog throttles, `upstream_failed` when it cannot be reached. */
  read(request: ReadRequest): Promise<ServiceReading[]>;
}

const bucketSchema = z.object({
  by: z.record(z.string(), z.unknown()),
  computes: z.record(z.string(), z.unknown()),
});
const aggregateSchema = z.object({ data: z.object({ buckets: z.array(bucketSchema) }) });
const seriesSchema = z.array(z.object({ time: z.string(), value: z.number() }));
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

const METHOD = '@http.method';
const PATH = '@http.url_details.path';
/** Datadog refuses more than 10000 groups across all dimensions: 100 methods and paths at most. */
const ROUTE_LIMIT = 100;
const SERVICE_LIMIT = 500;

/** `4xx` becomes a Datadog range on the status code. */
function statusRange(value: string): string | null {
  const match = /^([1-5])xx$/i.exec(value);
  return match ? `-@http.status_code:[${match[1]}00 TO ${match[1]}99]` : null;
}

/** `pup`, with the signed-in org. Errors name the tool and the cause class only: output may hold log content. */
export class PupDatadog implements DatadogReader {
  constructor(private readonly bin = 'pup') {}

  async read(request: ReadRequest): Promise<ServiceReading[]> {
    const out: ServiceReading[] = [];
    for (const env of request.envs) {
      const base = `env:${env} ${METHOD}:*`;
      const names = request.service ? [request.service] : await this.serviceNames(base, request.window);
      for (const name of names) {
        const scope = `${base} service:${name}`;
        const ignored = request.ignore.flatMap((rule) =>
          rule.kind === 'status_class' ? [statusRange(rule.value)] : [],
        );
        const errorScope = [scope, 'status:(error OR warn)', ...ignored.filter(Boolean)].join(' ');
        const routes = new Map<string, RouteReading>();
        for (const bucket of await this.aggregate(scope, request.window, false)) {
          const by = routeOf(bucket.by);
          if (!by) continue;
          const route = routes.get(`${by.method} ${by.path}`) ?? emptyRoute(by.method, by.path, errorScope);
          route.requests += Number(bucket.computes.c0 ?? 0);
          routes.set(`${by.method} ${by.path}`, route);
        }
        // Ids in paths fold several buckets into one Route, so the 10-minute buckets add up by time.
        const peaks = new Map<string, Map<string, number>>();
        for (const bucket of await this.aggregate(errorScope, request.window, true)) {
          const by = routeOf(bucket.by);
          const series = seriesSchema.safeParse(bucket.computes.c0);
          if (!by || !series.success) continue;
          const k = `${by.method} ${by.path}`;
          const route = routes.get(k) ?? emptyRoute(by.method, by.path, errorScope);
          const times = peaks.get(k) ?? new Map<string, number>();
          for (const point of series.data) {
            route.errors += point.value;
            times.set(point.time, (times.get(point.time) ?? 0) + point.value);
          }
          route.peakPer10m = Math.max(0, ...times.values());
          peaks.set(k, times);
          routes.set(k, route);
        }
        for (const route of routes.values()) {
          if (route.errors > 0) route.samples = await this.samples(name, env, route, request.window);
        }
        out.push({ name, env, routes: [...routes.values()] });
      }
    }
    return out;
  }

  /** Every Service with HTTP logs in the env: one dimension, so the group cap is no problem. */
  private async serviceNames(query: string, window: CheckInterval): Promise<string[]> {
    const buckets = await this.run(query, window, 'service', SERVICE_LIMIT, false);
    return buckets.flatMap((bucket) => (typeof bucket.by.service === 'string' ? [bucket.by.service] : []));
  }

  private aggregate(query: string, window: CheckInterval, series: boolean) {
    return this.run(query, window, `${METHOD},${PATH}`, ROUTE_LIMIT, series);
  }

  private async run(query: string, window: CheckInterval, groupBy: string, limit: number, series: boolean) {
    const args = [
      'logs',
      'aggregate',
      '--query',
      query,
      '--from',
      window,
      '--compute',
      'count',
      '--group-by',
      groupBy,
      '--limit',
      String(limit),
      // Flex is not on every account; the default tries it first and prints a failure before it falls back.
      '--storage',
      'indexes',
      ...(series ? ['--interval', '10m'] : []),
    ];
    return aggregateSchema.parse(JSON.parse(await this.exec(args))).data.buckets;
  }

  private async samples(service: string, env: string, route: RouteReading, window: CheckInterval): Promise<Sample[]> {
    const query = `env:${env} service:${service} ${METHOD}:${route.method} ${PATH}:${route.path.replaceAll(':id', '*')} status:(error OR warn)`;
    route.query = query;
    const out = searchSchema.parse(
      JSON.parse(
        await this.exec([
          'logs',
          'search',
          '--query',
          query,
          '--from',
          window,
          '--limit',
          '25',
          '--storage',
          'indexes',
        ]),
      ),
    );
    return out.data.map((log) => ({
      id: log.id,
      timestamp: log.attributes.timestamp ?? '',
      status: log.attributes.status ?? 'error',
      message: log.attributes.message ?? '',
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

function routeOf(by: Record<string, unknown>): { method: string; path: string } | null {
  const method = by[METHOD];
  const path = by[PATH];
  if (typeof method !== 'string' || typeof path !== 'string') return null;
  return { method: method.toUpperCase(), path: normalizePath(path) };
}

function emptyRoute(method: string, path: string, query: string): RouteReading {
  return { method, path, requests: 0, errors: 0, peakPer10m: 0, samples: [], query };
}
