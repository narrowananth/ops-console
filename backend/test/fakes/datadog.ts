import { ErrorCode, type Sample } from '@ops-console/shared';
import { ApiError } from '../../src/common/errors';
import type { DatadogReader, LogGroup, ReadRequest, ServiceCount, ServiceReading } from '../../src/monitor/datadog';

/** Newest first, as Datadog returns them. */
export function samples(count: number, message = 'NullPointerException in OrderService', status = 'error'): Sample[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `log-${message.length}-${index}-${count}`,
    timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - index * 60_000).toISOString(),
    status,
    message,
    attributes: {},
    tags: ['env:prod'],
  }));
}

/** One kind of failure on a Route; `method` and `path` empty for logs with no request. */
export function route(method: string, path: string, errors: number, extra: Partial<LogGroup> = {}): LogGroup {
  return {
    method,
    path,
    statusCode: 500,
    errors,
    peakPer10m: errors,
    samples: errors > 0 ? samples(Math.min(errors, 25)) : [],
    query: `env:prod service:orders-api @http.method:${method} @http.url_details.path:${path}`,
    ...extra,
  };
}

export const service = (
  name: string,
  groups: LogGroup[],
  env = 'prod',
  repoUrl: string | null = null,
): ServiceReading => ({
  name,
  env,
  groups,
  repoUrl,
});

/** Whether a group answers with one of `codes`; every group does when `codes` is empty. */
const picked = (codes: number[], group: LogGroup) =>
  codes.length === 0 || (group.statusCode !== null && codes.includes(group.statusCode));

/** Datadog in memory: returns what the test set, or fails on cue. */
export class FakeDatadog implements DatadogReader {
  readings: ServiceReading[] = [];
  envNames: string[] = ['prod', 'staging'];
  down: 'rate_limited' | 'failed' | null = null;
  readonly calls: ReadRequest[] = [];
  /** Holds the read until it settles. */
  hold: Promise<unknown> | null = null;

  async read(request: ReadRequest): Promise<ServiceReading[]> {
    this.calls.push(request);
    if (this.hold) await this.hold;
    if (this.down === 'rate_limited') throw new ApiError(429, ErrorCode.RateLimited, 'Datadog rate limit reached');
    if (this.down === 'failed') throw new ApiError(502, ErrorCode.UpstreamFailed, '`pup logs aggregate` failed');
    return structuredClone(this.readings)
      .filter(
        (reading) =>
          (!request.services || request.services.includes(reading.name)) && request.envs.includes(reading.env),
      )
      .map((reading) => ({ ...reading, groups: reading.groups.filter((group) => picked(request.codes, group)) }));
  }

  /** Counts the set readings' errors, as Datadog's aggregate does. */
  async services(envs: string[], _window: string, codes: number[]): Promise<ServiceCount[]> {
    if (this.down) throw new ApiError(502, ErrorCode.UpstreamFailed, '`pup logs aggregate` failed');
    return this.readings
      .filter((reading) => envs.includes(reading.env))
      .map((reading) => ({
        name: reading.name,
        env: reading.env,
        errors: reading.groups.filter((group) => picked(codes, group)).reduce((sum, group) => sum + group.errors, 0),
      }))
      .filter((count) => count.errors > 0);
  }

  async statusCodes(_window: string): Promise<{ code: number; count: number }[]> {
    if (this.down) throw new ApiError(502, ErrorCode.UpstreamFailed, '`pup logs aggregate` failed');
    const counts = new Map<number, number>();
    for (const reading of this.readings) {
      for (const group of reading.groups) {
        if (group.statusCode !== null) counts.set(group.statusCode, (counts.get(group.statusCode) ?? 0) + group.errors);
      }
    }
    return [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
  }

  async envs(): Promise<string[]> {
    if (this.down) throw new ApiError(502, ErrorCode.UpstreamFailed, '`pup logs aggregate` failed');
    return this.envNames;
  }
}
