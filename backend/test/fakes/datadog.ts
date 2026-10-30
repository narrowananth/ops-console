import { ErrorCode, type Sample } from '@ops-console/shared';
import { ApiError } from '../../src/common/errors';
import type { DatadogReader, ReadRequest, RouteReading, ServiceReading } from '../../src/monitor/datadog';

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

export function route(method: string, path: string, errors: number, extra: Partial<RouteReading> = {}): RouteReading {
  return {
    method,
    path,
    requests: 1000,
    errors,
    peakPer10m: errors,
    samples: errors > 0 ? samples(Math.min(errors, 25)) : [],
    query: `env:prod service:orders-api @http.method:${method} @http.url_details.path:${path}`,
    ...extra,
  };
}

export const service = (name: string, routes: RouteReading[], env = 'prod'): ServiceReading => ({ name, env, routes });

/** Datadog in memory: returns what the test set, or fails on cue. */
export class FakeDatadog implements DatadogReader {
  readings: ServiceReading[] = [];
  down: 'rate_limited' | 'failed' | null = null;
  readonly calls: ReadRequest[] = [];
  /** Holds the read until it settles. */
  hold: Promise<unknown> | null = null;

  async read(request: ReadRequest): Promise<ServiceReading[]> {
    this.calls.push(request);
    if (this.hold) await this.hold;
    if (this.down === 'rate_limited') throw new ApiError(429, ErrorCode.RateLimited, 'Datadog rate limit reached');
    if (this.down === 'failed') throw new ApiError(502, ErrorCode.UpstreamFailed, '`pup logs aggregate` failed');
    return structuredClone(this.readings).filter((reading) => !request.service || reading.name === request.service);
  }
}
