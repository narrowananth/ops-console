import { type LogSource, SAMPLE_LIMIT, type Sample, type ScanWindow } from '@ops-console/shared';
import { maskSignature } from './fingerprint';

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
  /** What finds these logs again in their source: Datadog's query string, or the JSON filter of the Log folder. */
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
  /** Aborts the read when the operator stops the Scan. */
  signal?: AbortSignal;
  /** What the read did not cover in full, for the Scan to keep. */
  note?: (text: string) => void;
};

export type ServiceCount = { name: string; env: string; errors: number };

/** A log source as a Scan reads it (ADR 0005: fixed reads, no model turn). Tests replace Datadog with a scripted fake. */
export interface LogReader {
  /** Throws `rate_limited` when the source throttles, `upstream_failed` when it cannot be reached. */
  read(request: ReadRequest): Promise<ServiceReading[]>;
  /** Every env with logs in the last 7 days. */
  envs(): Promise<string[]>;
  /** The Services with failing requests in each env over the window, and how many. */
  services(envs: string[], window: ScanWindow, codes: number[]): Promise<ServiceCount[]>;
  /** Each HTTP status code from 400 up with requests in the window, every env together, busiest first. */
  statusCodes(window: ScanWindow): Promise<{ code: number; count: number }[]>;
  /** How many failing logs the query matches in the window: the Recheck of an Alert. */
  countLogs(query: string, window: ScanWindow): Promise<number>;
}

/** The reader of each log source. */
export type LogReaders = Record<LogSource, LogReader>;
export const LOG_READERS = Symbol('LOG_READERS');

/** Statuses at error level and above. Datadog keeps `emergency`, `alert` and `critical` apart from `error`. */
export const ERROR_LEVEL = ['emergency', 'alert', 'critical', 'error'];

const TEN_MINUTES = 600_000;

/** One failing log with the fields a Scan groups by. */
export type LogEntry = { sample: Sample; statusCode: number | null; method: string; path: string };

/**
 * The logs of one Service, newest first, as groups: one per Route, status code and masked message. `queryOf` gives each
 * group the query that finds it again.
 */
export function groupEntries(
  entries: LogEntry[],
  queryOf: (group: { statusCode: number | null; method: string; path: string }) => string,
): LogGroup[] {
  const groups = new Map<string, LogGroup & { buckets: Map<number, number> }>();
  for (const { sample, statusCode, method, path } of entries) {
    const key = `${statusCode} ${method} ${path}\n${maskSignature(sample.message)}`;
    let group = groups.get(key);
    if (!group) {
      const query = queryOf({ statusCode, method, path });
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
