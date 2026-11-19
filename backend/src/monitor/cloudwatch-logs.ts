import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ErrorCode, type LogGroupPick, type Sample, type ScanWindow, WINDOW_HOURS } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { mapLimit } from '../common/map-limit';
import {
  entryKey,
  FATAL_ERROR_LEVEL,
  groupEntries,
  type LogEntry,
  type LogGroup,
  type LogReader,
  pathPattern,
  type ReadRequest,
  routeOf,
  type ServiceCount,
  type ServiceReading,
  statusCodeOf,
  statusKept,
} from './log-reader';

const run = promisify(execFile);

/** The names a JSON log line may use for each field, first present wins. */
const STATUS_FIELDS = ['status', 'statusCode', 'status_code', 'http.status_code'];
const METHOD_FIELDS = ['method', 'httpMethod', 'http.method'];
const ROUTE_FIELDS = ['route', 'path', 'resourcePath', 'url.path'];
const LEVEL_FIELDS = ['level', 'severity', 'log_level'];
const MESSAGE_FIELDS = ['message', 'msg'];

/** At most this many failing events, and this many rows of counts, a Scan reads per log group. */
const EVENTS_PER_GROUP = 10_000;
const COUNT_ROWS_PER_GROUP = 10_000;
/** A query still running after this long is stopped. */
const QUERY_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 1_000;
const GROUPS_AT_ONCE = 4;
const CALL_TIMEOUT_MS = 60_000;
const MEGABYTE = 1024 * 1024;

const quoted = (name: string) => (/^[A-Za-z_]\w*$/.test(name) ? name : `\`${name}\``);
const coalesce = (names: string[]) => `coalesce(${names.map(quoted).join(', ')})`;

/** The fields every query reads, under names that do not clash with the log's own. */
const FIELDS = `fields ${coalesce(STATUS_FIELDS)} as f_code, ${coalesce(METHOD_FIELDS)} as f_method, ${coalesce(ROUTE_FIELDS)} as f_route, ${coalesce(LEVEL_FIELDS)} as f_level, ${coalesce(MESSAGE_FIELDS)} as f_message`;
const FAILING = `(f_code >= 400 or tolower(f_level) in [${FATAL_ERROR_LEVEL.map((level) => `"${level}"`).join(', ')}])`;

/** `stats … by` leaves out an event with no value for one of its fields, so each is an empty string when missing. */
const GROUPED = `fields coalesce(f_code, "") as g_code, coalesce(f_method, "") as g_method, coalesce(f_route, "") as g_route, coalesce(f_message, "") as g_message`;
const COUNTS_QUERY = `${FIELDS} | filter ${FAILING} | ${GROUPED} | stats count(*) as n by bin(10m) as bucket, g_code, g_method, g_route, g_message | limit ${COUNT_ROWS_PER_GROUP}`;
const EVENTS_QUERY = `${FIELDS}, @timestamp, @message | filter ${FAILING} | sort @timestamp desc | limit ${EVENTS_PER_GROUP}`;
const BY_CODE_QUERY = `${FIELDS} | filter ${FAILING} | stats count(*) as n by f_code`;

const startSchema = z.object({ queryId: z.string() }).loose();
const resultsSchema = z
  .object({
    status: z.string(),
    results: z.array(z.array(z.object({ field: z.string(), value: z.string().optional() }).loose())).default([]),
    statistics: z.object({ bytesScanned: z.number().optional() }).loose().optional(),
  })
  .loose();
/** The filter an Alert keeps to find its events again. */
const filterSchema = z.object({
  log_group: z.string(),
  status: z.number().int().nullable(),
  method: z.string().nullable(),
  path: z.string().nullable(),
});

type Row = Record<string, string>;
type Answer = { rows: Row[]; bytes: number };

/** A query that did not finish in time and was stopped. */
class QueryTimeout extends Error {}

const FAILED_STATES = new Set(['Failed', 'Cancelled', 'Timeout', 'Unknown']);

/** A value of a JSON log line by name; `a.b` is the flat key or the nested one. */
function lookup(json: Record<string, unknown>, name: string): unknown {
  if (name in json) return json[name];
  let at: unknown = json;
  for (const part of name.split('.'))
    at = at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[part] : undefined;
  return at;
}

const firstOf = (json: Record<string, unknown>, names: string[]): unknown =>
  names.map((name) => lookup(json, name)).find((value) => value !== undefined && value !== null);

const messageOf = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '(no message)';
  return typeof value === 'string' ? value : JSON.stringify(value);
};

/** Logs Insights prints `2026-10-01 12:00:00.000`, in UTC. */
function isoOf(stamp: string): string | null {
  const time = Date.parse(`${stamp.replace(' ', 'T')}Z`);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function sizeOf(bytes: number): string {
  if (bytes >= 1024 * MEGABYTE) return `${(bytes / (1024 * MEGABYTE)).toFixed(2)} GB`;
  if (bytes >= MEGABYTE) return `${(bytes / MEGABYTE).toFixed(1)} MB`;
  return `${Math.round(bytes)} bytes`;
}

type CloudWatchSettings = { profile: string; region: string; log_groups: LogGroupPick[] };

export type CloudWatchOptions = {
  bin?: string;
  /** How long a query may run before it is stopped. */
  timeoutMs?: number;
  /** How long to wait between asking for a query's results. */
  pollMs?: number;
};

/**
 * Log groups read with the `aws` CLI, as the operator: Logs Insights aggregates in AWS, so a Scan gets about 144 rows
 * per group per day, and the newest failing events as Samples. Errors name the tool and the cause class only: output
 * may hold log content.
 */
export class CloudWatchLogs implements LogReader {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(
    private readonly settings: () => CloudWatchSettings,
    options: CloudWatchOptions = {},
  ) {
    this.bin = options.bin ?? 'aws';
    this.timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? POLL_MS;
  }

  async read(request: ReadRequest): Promise<ServiceReading[]> {
    const keep = statusKept(request);
    const picked = this.settings().log_groups.filter(
      (group) => request.envs.includes(group.env) && (!request.services || request.services.includes(group.service)),
    );
    const window = this.windowOf(request.window);
    let bytes = 0;
    let answered = false;
    const readings = await mapLimit(picked, GROUPS_AT_ONCE, async (group): Promise<ServiceReading | null> => {
      // One query failing stops the other: a query left running keeps scanning, and AWS bills the bytes.
      const sibling = new AbortController();
      const signal = request.signal ? AbortSignal.any([request.signal, sibling.signal]) : sibling.signal;
      const run = (text: string) =>
        this.query(group.name, text, window, signal).catch((error: unknown) => {
          sibling.abort(error);
          throw error;
        });
      const settled = await Promise.allSettled([run(COUNTS_QUERY), run(EVENTS_QUERY)]);
      const answers = settled.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : []));
      if (answers.length > 0) {
        answered = true;
        bytes += answers.reduce((sum, answer) => sum + answer.bytes, 0);
      }
      for (const failed of settled) {
        if (failed.status !== 'rejected') continue;
        if (!(failed.reason instanceof QueryTimeout)) throw failed.reason;
        request.note?.(`${group.name} not read: its query did not finish in 5 minutes and was stopped`);
        return null;
      }
      const [countRows, eventRows] = [answers[0] as Answer, answers[1] as Answer];
      if (countRows.rows.length >= COUNT_ROWS_PER_GROUP) {
        request.note?.(`${group.name}: counts cut off at ${COUNT_ROWS_PER_GROUP.toLocaleString('en-US')} rows`);
      }
      if (eventRows.rows.length >= EVENTS_PER_GROUP) {
        request.note?.(
          `${group.name}: read the newest ${EVENTS_PER_GROUP.toLocaleString('en-US')} failing events only`,
        );
      }
      const entries = eventRows.rows.flatMap((row) => this.entryOf(group, row, keep));
      const groups = this.withCounts(
        groupEntries(entries, ({ statusCode, method, path }) =>
          JSON.stringify({ log_group: group.name, status: statusCode, method: method || null, path: path || null }),
        ),
        countRows.rows,
        keep,
      );
      return groups.length > 0 ? { name: group.service, env: group.env, groups, repoUrl: null } : null;
    });
    if (answered) request.note?.(`Logs Insights scanned ${sizeOf(bytes)}`);
    return readings
      .flatMap((reading) => (reading ? [reading] : []))
      .sort((a, b) => a.name.localeCompare(b.name) || a.env.localeCompare(b.env));
  }

  async envs(): Promise<string[]> {
    return [...new Set(this.settings().log_groups.map((group) => group.env))].sort();
  }

  async services(envs: string[], window: ScanWindow, codes: number[]): Promise<ServiceCount[]> {
    const picked = this.settings().log_groups.filter((group) => envs.includes(group.env));
    const counted = await mapLimit(picked, GROUPS_AT_ONCE, async (group) => {
      const byCode = await this.byCode(group.name, window);
      const errors = byCode
        .filter(({ code }) => codes.length === 0 || (code !== null && codes.includes(code)))
        .reduce((sum, { count }) => sum + count, 0);
      return { name: group.service, env: group.env, errors };
    });
    return counted.filter((count) => count.errors > 0);
  }

  async statusCodes(window: ScanWindow): Promise<{ code: number; count: number }[]> {
    const totals = new Map<number, number>();
    await mapLimit(this.settings().log_groups, GROUPS_AT_ONCE, async (group) => {
      for (const { code, count } of await this.byCode(group.name, window)) {
        if (code !== null && code >= 400) totals.set(code, (totals.get(code) ?? 0) + count);
      }
    });
    return [...totals].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code - b.code);
  }

  async countLogs(query: string, window: ScanWindow): Promise<number> {
    const filter = filterSchema.parse(JSON.parse(query));
    const conditions = [FAILING];
    if (filter.status !== null) conditions.push(`f_code = ${filter.status}`);
    if (filter.method !== null)
      conditions.push(`toupper(f_method) = "${filter.method.toUpperCase().replace(/[^A-Z]/g, '')}"`);
    if (filter.path !== null) conditions.push(`f_route like /${pathPattern(filter.path).replaceAll('/', '\\/')}/`);
    const text = `${FIELDS} | filter ${conditions.join(' and ')} | stats count(*) as n`;
    const { rows } = await this.query(filter.log_group, text, this.windowOf(window));
    return Number(rows[0]?.n ?? 0);
  }

  private windowOf(window: ScanWindow): { from: number; to: number } {
    const to = Date.now();
    return { from: to - WINDOW_HOURS[window] * 3_600_000, to };
  }

  private async byCode(group: string, window: ScanWindow): Promise<{ code: number | null; count: number }[]> {
    const { rows } = await this.query(group, BY_CODE_QUERY, this.windowOf(window));
    return rows.map((row) => ({ code: statusCodeOf(row.f_code), count: Number(row.n ?? 0) }));
  }

  /** One failing event as a Scan groups it; none for a line that is not JSON or that the Scan does not read. */
  private entryOf(group: LogGroupPick, row: Row, keep: (statusCode: number | null) => boolean): LogEntry[] {
    const stamp = isoOf(row['@timestamp'] ?? '');
    const line = row['@message'] ?? '';
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return [];
    }
    if (stamp === null || json === null || typeof json !== 'object' || Array.isArray(json)) return [];
    const fields = json as Record<string, unknown>;
    const statusCode = statusCodeOf(firstOf(fields, STATUS_FIELDS));
    if (!keep(statusCode)) return [];
    const level = firstOf(fields, LEVEL_FIELDS);
    const message = messageOf(firstOf(fields, MESSAGE_FIELDS));
    const sample: Sample = {
      // The same event read by two Scans is one Sample.
      id: createHash('sha256')
        .update(JSON.stringify([group.name, stamp, line]))
        .digest('hex')
        .slice(0, 32),
      timestamp: stamp,
      status: typeof level === 'string' && level !== '' ? level.toLowerCase() : 'error',
      message,
      attributes: fields,
      tags: [`service:${group.service}`, `env:${group.env}`, `log_group:${group.name}`],
    };
    return [{ sample, statusCode, ...routeOf(firstOf(fields, METHOD_FIELDS), firstOf(fields, ROUTE_FIELDS)) }];
  }

  /** The groups with the counts and 10-minute peaks Logs Insights found, which cover more than the events read. */
  private withCounts(groups: LogGroup[], rows: Row[], keep: (statusCode: number | null) => boolean): LogGroup[] {
    const totals = new Map<string, { errors: number; buckets: Map<string, number> }>();
    for (const row of rows) {
      const statusCode = statusCodeOf(row.g_code);
      if (!keep(statusCode)) continue;
      const key = entryKey({ statusCode, ...routeOf(row.g_method, row.g_route) }, messageOf(row.g_message));
      const total = totals.get(key) ?? { errors: 0, buckets: new Map() };
      const count = Number(row.n ?? 0);
      total.errors += count;
      const bucket = row.bucket ?? '';
      total.buckets.set(bucket, (total.buckets.get(bucket) ?? 0) + count);
      totals.set(key, total);
    }
    return groups.map((group) => {
      const found = totals.get(entryKey(group, group.samples[0]?.message ?? ''));
      if (!found) return group;
      return { ...group, errors: found.errors, peakPer10m: Math.max(...found.buckets.values()) };
    });
  }

  /** Runs one Logs Insights query over the window and returns its rows; a query that outlives its time is stopped. */
  private async query(
    group: string,
    text: string,
    window: { from: number; to: number },
    signal?: AbortSignal,
  ): Promise<Answer> {
    signal?.throwIfAborted();
    // The start is not tied to `signal`: killing the CLI would lose the id of a query AWS may already be running.
    const start = startSchema.parse(
      JSON.parse(
        await this.exec(
          [
            'start-query',
            // One argument, so a name that starts with `-` is not read as an option.
            `--log-group-name=${group}`,
            '--start-time',
            String(Math.floor(window.from / 1000)),
            '--end-time',
            String(Math.ceil(window.to / 1000)),
            '--query-string',
            text,
          ],
          undefined,
          group,
        ),
      ),
    );
    const deadline = Date.now() + this.timeoutMs;
    try {
      signal?.throwIfAborted();
      for (;;) {
        const answer = resultsSchema.parse(
          JSON.parse(await this.exec(['get-query-results', '--query-id', start.queryId], signal, group)),
        );
        if (answer.status === 'Complete') {
          return {
            rows: answer.results.map((cells) =>
              Object.fromEntries(cells.map((cell) => [cell.field, cell.value ?? ''])),
            ),
            bytes: answer.statistics?.bytesScanned ?? 0,
          };
        }
        if (FAILED_STATES.has(answer.status)) {
          throw new ApiError(502, ErrorCode.UpstreamFailed, `A Logs Insights query on ${group} ended ${answer.status}`);
        }
        if (Date.now() >= deadline) throw new QueryTimeout();
        await sleep(this.pollMs, undefined, { signal });
      }
    } catch (error) {
      // A query left running keeps scanning, and AWS bills the bytes. If this call fails the query ends by itself.
      await this.exec(['stop-query', '--query-id', start.queryId], undefined, group).catch(() => {});
      if (signal?.aborted) throw signal.reason;
      throw error;
    }
  }

  private async exec(args: string[], signal: AbortSignal | undefined, group = ''): Promise<string> {
    const { profile, region } = this.settings();
    const full = ['logs', ...args, '--profile', profile, '--region', region, '--output', 'json'];
    try {
      const pending = run(this.bin, full, { maxBuffer: 50 * 1024 * 1024, timeout: CALL_TIMEOUT_MS, signal });
      pending.child.stdin?.end();
      return (await pending).stdout;
    } catch (error) {
      // A stopped Scan is the caller's to end, not an upstream failure.
      if (signal?.aborted) throw signal.reason;
      const { stderr } = error as { stderr?: unknown };
      const text = typeof stderr === 'string' ? stderr : '';
      if (/ThrottlingException|Rate exceeded|TooManyRequests/i.test(text)) {
        throw new ApiError(429, ErrorCode.RateLimited, 'CloudWatch rate limit reached');
      }
      if (/ResourceNotFoundException/.test(text)) {
        throw new ApiError(502, ErrorCode.UpstreamFailed, `Log group ${group} was not found`);
      }
      if (/expired|Unable to locate credentials|Error loading SSO|ExpiredToken|InvalidClientTokenId/i.test(text)) {
        throw new ApiError(502, ErrorCode.UpstreamFailed, `AWS profile ${profile} is signed out`);
      }
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`aws logs ${args[0]}\` failed`);
    }
  }
}
