import { createHash } from 'node:crypto';
import { ErrorCode, type Sample, type ScanWindow, WINDOW_HOURS } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { mapLimit } from '../common/map-limit';
import {
  FATAL_ERROR_LEVEL,
  groupEntries,
  ignoredRanges,
  type LogEntry,
  type LogGroup,
  type LogReader,
  pathPattern,
  type ReadRequest,
  routeOf,
  type ServiceCount,
  type ServiceReading,
  statusCodeOf,
} from './log-reader';
import type { LokiLogsConfig } from './log-source-config';
import type { LokiAccess } from './loki-access';
import { LogcliFailed, logcli, lokiFailure } from './loki-cli';

/** The names a log line may use for each field after parsing, first present wins. Nested keys are joined with `_`. */
const STATUS_FIELDS = ['status', 'statusCode', 'status_code', 'http_status_code'];
const METHOD_FIELDS = ['method', 'httpMethod', 'http_method'];
const ROUTE_FIELDS = ['route', 'path', 'resourcePath', 'url_path'];
const LEVEL_FIELDS = ['level', 'severity', 'log_level'];
const MESSAGE_FIELDS = ['message', 'msg'];

/** At most this many failing lines a Scan reads per Service: Loki's default entry limit per query. */
const SAMPLE_LINES = 5_000;
const SERVICES_AT_ONCE = 4;
const STEP_MS = 600_000;
/** An env with no value for the env label. */
const NO_ENV = 'no env';
const ENV_WINDOW_MS = 7 * 86_400_000;

const quote = (text: string) => JSON.stringify(text);
const names = (fields: string[]) => fields.map((name) => `.${name}`).join(' ');

/** Each field under one name that does not clash with the log's own. `or` takes the first non-empty value. */
const ALIASES = `| label_format f_code=\`{{ or ${names(STATUS_FIELDS)} }}\`, f_method=\`{{ or ${names(METHOD_FIELDS)} }}\`, f_route=\`{{ or ${names(ROUTE_FIELDS)} }}\`, f_level=\`{{ or ${names(LEVEL_FIELDS)} }}\``;
/** A string match on the code, since a number filter keeps a line whose code is not a number. */
const FAILING = `| f_code=~"[4-9][0-9][0-9]" or f_level=~"(?i)(${FATAL_ERROR_LEVEL.join('|')})"`;
const FAILING_CODE = '| f_code=~"[4-9][0-9][0-9]"';

const rowsSchema = z
  .array(
    z
      .object({
        metric: z.record(z.string(), z.string()),
        value: z.tuple([z.number(), z.string()]).optional(),
        values: z.array(z.tuple([z.number(), z.string()])).optional(),
      })
      .loose(),
  )
  .nullable();
const linesSchema = z.object({ line: z.string(), timestamp: z.string() }).loose();
/** The filter an Alert keeps to find its lines again. */
const filterSchema = z.object({
  service: z.string(),
  env: z.string(),
  status: z.number().int().nullable(),
  method: z.string().nullable(),
  path: z.string().nullable(),
});

type Row = { metric: Record<string, string>; points: [number, number][] };
type Flat = Record<string, string>;

/** `{a:{b:1}}` as `{a_b:"1"}`, the way Loki's JSON parser names fields; arrays are skipped. */
function flatten(value: Record<string, unknown>, prefix = '', into: Flat = {}): Flat {
  for (const [key, inner] of Object.entries(value)) {
    const name = `${prefix}${key}`.replace(/[^A-Za-z0-9_:]/g, '_');
    if (Array.isArray(inner) || inner === null || inner === undefined) continue;
    if (typeof inner === 'object') flatten(inner as Record<string, unknown>, `${name}_`, into);
    else if (!(name in into)) into[name] = String(inner);
  }
  return into;
}

/** The fields of a `key=value key="a b"` line, under the names Loki's logfmt parser gives them. */
function logfmtFields(line: string): Flat | null {
  const fields: Flat = {};
  for (const match of line.matchAll(/([A-Za-z_][\w.]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g)) {
    const name = (match[1] as string).replace(/[^A-Za-z0-9_:]/g, '_');
    fields[name] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : (match[3] as string);
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

/** The line's fields as Loki names them, and the same fields as the Sample keeps them; null when the line does not parse. */
function parseLine(
  line: string,
  format: LokiLogsConfig['format'],
): { flat: Flat; attributes: Record<string, unknown> } | null {
  if (format === 'logfmt') {
    const fields = logfmtFields(line);
    return fields && { flat: fields, attributes: fields };
  }
  try {
    const json: unknown = JSON.parse(line);
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
    return { flat: flatten(json as Record<string, unknown>), attributes: json as Record<string, unknown> };
  } catch {
    return null;
  }
}

const firstOf = (flat: Flat, fields: string[]): string | undefined =>
  fields.map((name) => flat[name]).find((value) => value !== undefined && value !== '');

/** The labels of a `series` line: `{app="api", env="prod"}`. */
function labelsOf(line: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const match of line.matchAll(/([A-Za-z_]\w*)=("(?:[^"\\]|\\.)*")/g)) {
    try {
      labels[match[1] as string] = JSON.parse(match[2] as string) as string;
    } catch {
      labels[match[1] as string] = (match[2] as string).slice(1, -1);
    }
  }
  return labels;
}

const rangeOf = (window: ScanWindow) => `${Math.round(WINDOW_HOURS[window] * 60)}m`;

export type LokiOptions = { bin?: string };

/**
 * Loki read with the `logcli` CLI, as the operator. A Scan lists the Services from the streams the service label names,
 * counts failing lines per 10 minutes with a metric query, and reads the newest failing lines as Samples. The failing
 * test, the field names and the ignored codes are LogQL, so Loki does the filtering. Errors name the tool and the
 * cause class only: output may hold log content.
 */
export class LokiLogs implements LogReader {
  private readonly bin: string;

  constructor(
    private readonly source: () => Promise<LokiAccess>,
    options: LokiOptions = {},
  ) {
    this.bin = options.bin ?? 'logcli';
  }

  async read(request: ReadRequest): Promise<ServiceReading[]> {
    const { config, childEnv } = await this.source();
    const window = this.windowOf(request.window);
    const streams = (await this.streams(config, childEnv, { from: window.from, to: window.to }, request.signal)).filter(
      (stream) => request.envs.includes(stream.env) && (!request.services || request.services.includes(stream.name)),
    );
    const readings = await mapLimit(streams, SERVICES_AT_ONCE, async (service): Promise<ServiceReading | null> => {
      const base = this.pipeline(config, this.selector(config, service), this.exclusions(request));
      const evaluated = this.evaluationPoints(window);
      const [counts, lines] = await Promise.all([
        this.rows(
          childEnv,
          ['query', '--from', evaluated.from, '--to', evaluated.to, '--step', '10m', this.counted(base, '10m')],
          request.signal,
        ),
        this.exec(
          childEnv,
          [
            'query',
            '--from',
            window.fromIso,
            '--to',
            window.toIso,
            '--limit',
            String(SAMPLE_LINES),
            '-o',
            'jsonl',
            '--no-labels',
            '-z',
            'UTC',
            base,
          ],
          request.signal,
        ),
      ]);
      const entries = this.entries(config, service, lines);
      const total = counts.reduce((sum, row) => sum + row.points.reduce((points, [, count]) => points + count, 0), 0);
      if (total > SAMPLE_LINES) {
        request.note?.(`${service.name}: read the newest ${SAMPLE_LINES.toLocaleString('en-US')} failing lines only`);
      }
      const groups = this.withCounts(
        groupEntries(entries, ({ statusCode, method, path }) =>
          JSON.stringify({
            service: service.name,
            env: service.env,
            status: statusCode,
            method: method || null,
            path: path || null,
          }),
        ),
        counts,
      );
      return groups.length > 0 ? { name: service.name, env: service.env, groups, repoUrl: null } : null;
    });
    return readings
      .flatMap((reading) => (reading ? [reading] : []))
      .sort((a, b) => a.name.localeCompare(b.name) || a.env.localeCompare(b.env));
  }

  async envs(): Promise<string[]> {
    const { config, childEnv } = await this.source();
    const to = Date.now();
    const streams = await this.streams(config, childEnv, { from: to - ENV_WINDOW_MS, to });
    return [...new Set(streams.map((stream) => stream.env))].sort();
  }

  async services(envs: string[], window: ScanWindow, codes: number[]): Promise<ServiceCount[]> {
    const { config, childEnv } = await this.source();
    const query = `sum by (${config.service_label}, ${config.env_label}, f_code) (count_over_time(${this.pipeline(config, this.selector(config), [FAILING])} [${rangeOf(window)}]))`;
    const totals = new Map<string, ServiceCount>();
    for (const row of await this.rows(childEnv, ['instant-query', query])) {
      const name = row.metric[config.service_label];
      const stream = row.metric[config.env_label] || NO_ENV;
      const code = statusCodeOf(row.metric.f_code);
      if (name === undefined || !envs.includes(stream)) continue;
      if (codes.length > 0 && (code === null || !codes.includes(code))) continue;
      const key = JSON.stringify([name, stream]);
      const total = totals.get(key) ?? { name, env: stream, errors: 0 };
      total.errors += row.points.reduce((sum, [, count]) => sum + count, 0);
      totals.set(key, total);
    }
    return [...totals.values()].filter((count) => count.errors > 0);
  }

  async statusCodes(window: ScanWindow): Promise<{ code: number; count: number }[]> {
    const { config, childEnv } = await this.source();
    const query = `sum by (f_code) (count_over_time(${this.pipeline(config, this.selector(config), [FAILING_CODE])} [${rangeOf(window)}]))`;
    const codes: { code: number; count: number }[] = [];
    for (const row of await this.rows(childEnv, ['instant-query', query])) {
      const code = statusCodeOf(row.metric.f_code);
      if (code !== null) codes.push({ code, count: row.points.reduce((sum, [, count]) => sum + count, 0) });
    }
    return codes.sort((a, b) => b.count - a.count || a.code - b.code);
  }

  async countLogs(query: string, window: ScanWindow): Promise<number> {
    const { config, childEnv } = await this.source();
    const filter = filterSchema.parse(JSON.parse(query));
    const conditions = [FAILING];
    if (filter.status !== null) conditions.push(`| f_code=${quote(String(filter.status))}`);
    if (filter.method !== null) {
      conditions.push(`| f_method=~${quote(`(?i)${filter.method.replace(/[^A-Za-z]/g, '')}`)}`);
    }
    if (filter.path !== null) conditions.push(`| f_route=~${quote(pathPattern(filter.path))}`);
    const selector = this.selector(config, { name: filter.service, env: filter.env });
    const text = `sum(count_over_time(${this.pipeline(config, selector, conditions)} [${rangeOf(window)}]))`;
    const [row] = await this.rows(childEnv, ['instant-query', text]);
    return row?.points.reduce((sum, [, count]) => sum + count, 0) ?? 0;
  }

  private windowOf(window: ScanWindow) {
    const to = Date.now();
    const from = to - WINDOW_HOURS[window] * 3_600_000;
    return { from, to, fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() };
  }

  /** Evaluation points that tile the window in whole steps, so no line is counted twice or from before it. */
  private evaluationPoints(window: { from: number; to: number }) {
    const end = window.from + Math.ceil((window.to - window.from) / STEP_MS) * STEP_MS;
    return { from: new Date(window.from + STEP_MS).toISOString(), to: new Date(end).toISOString() };
  }

  /** `{service_label=..., env_label=..., extra}`; every Service of the selector when none is named. */
  private selector(config: LokiLogsConfig, service?: { name: string; env: string }): string {
    const parts = service
      ? [
          `${config.service_label}=${quote(service.name)}`,
          service.env === NO_ENV ? `${config.env_label}=""` : `${config.env_label}=${quote(service.env)}`,
        ]
      : [`${config.service_label}=~".+"`];
    if (config.selector.trim() !== '') parts.push(config.selector.trim());
    return `{${parts.join(', ')}}`;
  }

  /** Parse, drop lines that do not parse, name the fields, then keep what `after` says. */
  private pipeline(config: LokiLogsConfig, selector: string, after: string[]): string {
    const parser = config.format === 'json' ? '| json' : '| logfmt';
    return `${selector} ${parser} | __error__="" ${ALIASES} ${after.join(' ')}`;
  }

  /** The failing lines the request wants: the codes asked for, and not the ignored classes. */
  private exclusions(request: ReadRequest): string[] {
    const asked = request.codes.length > 0 ? [`| f_code=~"${request.codes.join('|')}"`] : [];
    const ignored = ignoredRanges(request.ignore).map(([from]) => `| f_code!~"${from / 100}[0-9][0-9]"`);
    return [FAILING, ...asked, ...ignored];
  }

  private counted(base: string, range: string): string {
    return `sum by (f_code, f_method, f_route) (count_over_time(${base} [${range}]))`;
  }

  /** Every (service, env) the selector has a stream for in the window. */
  private async streams(
    config: LokiLogsConfig,
    childEnv: Record<string, string>,
    window: { from: number; to: number },
    signal?: AbortSignal,
  ): Promise<{ name: string; env: string }[]> {
    const out = await this.exec(
      childEnv,
      [
        'series',
        '--from',
        new Date(window.from).toISOString(),
        '--to',
        new Date(window.to).toISOString(),
        this.selector(config),
      ],
      signal,
    );
    const seen = new Map<string, { name: string; env: string }>();
    for (const line of out.split('\n')) {
      const labels = labelsOf(line);
      const name = labels[config.service_label];
      if (name === undefined || name === '') continue;
      const stream = labels[config.env_label] || NO_ENV;
      seen.set(JSON.stringify([name, stream]), { name, env: stream });
    }
    return [...seen.values()];
  }

  /** The answer of a metric query as rows, each with its points; one point for an instant query. */
  private async rows(childEnv: Record<string, string>, args: string[], signal?: AbortSignal): Promise<Row[]> {
    const text = (await this.exec(childEnv, args, signal)).trim();
    let parsed: z.infer<typeof rowsSchema>;
    try {
      parsed = rowsSchema.parse(text === '' ? null : JSON.parse(text));
    } catch {
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`logcli ${args[0]}\` gave an answer the console cannot read`);
    }
    return (parsed ?? []).map((row) => ({
      metric: row.metric,
      points: (row.values ?? (row.value ? [row.value] : [])).map(([at, count]) => [at, Number(count)]),
    }));
  }

  /** One failing line as a Scan groups it; none for a line the parser the Connector names cannot read. */
  private entries(config: LokiLogsConfig, service: { name: string; env: string }, out: string): LogEntry[] {
    const entries: LogEntry[] = [];
    for (const text of out.split('\n')) {
      let record: z.infer<typeof linesSchema>;
      try {
        record = linesSchema.parse(JSON.parse(text));
      } catch {
        continue;
      }
      const parsed = parseLine(record.line, config.format);
      const at = Date.parse(record.timestamp);
      if (parsed === null || Number.isNaN(at)) continue;
      const { flat, attributes } = parsed;
      const level = firstOf(flat, LEVEL_FIELDS);
      const sample: Sample = {
        // The same line read by two Scans is one Sample.
        id: createHash('sha256')
          .update(JSON.stringify([service.name, service.env, record.timestamp, record.line]))
          .digest('hex')
          .slice(0, 32),
        timestamp: new Date(at).toISOString(),
        status: level ? level.toLowerCase() : 'error',
        message: firstOf(flat, MESSAGE_FIELDS) ?? '(no message)',
        attributes,
        tags: [`service:${service.name}`, `env:${service.env}`],
      };
      entries.push({
        sample,
        statusCode: statusCodeOf(firstOf(flat, STATUS_FIELDS)),
        ...routeOf(firstOf(flat, METHOD_FIELDS), firstOf(flat, ROUTE_FIELDS)),
      });
    }
    return entries;
  }

  /**
   * A Route whose lines share one message gets the count and the 10-minute peak of the metric query, which cover more
   * than the lines read. A Route with several messages keeps the counts of the lines read.
   */
  private withCounts(groups: LogGroup[], counts: Row[]): LogGroup[] {
    const key = ({ statusCode, method, path }: { statusCode: number | null; method: string; path: string }) =>
      `${statusCode} ${method} ${path}`;
    const totals = new Map<string, { errors: number; buckets: Map<number, number> }>();
    for (const row of counts) {
      const route = key({
        statusCode: statusCodeOf(row.metric.f_code),
        ...routeOf(row.metric.f_method, row.metric.f_route),
      });
      const total = totals.get(route) ?? { errors: 0, buckets: new Map() };
      for (const [at, count] of row.points) {
        total.errors += count;
        total.buckets.set(at, (total.buckets.get(at) ?? 0) + count);
      }
      totals.set(route, total);
    }
    const perRoute = new Map<string, number>();
    for (const group of groups) perRoute.set(key(group), (perRoute.get(key(group)) ?? 0) + 1);
    return groups.map((group) => {
      const metric = perRoute.get(key(group)) === 1 ? totals.get(key(group)) : undefined;
      if (!metric) return group;
      return { ...group, errors: metric.errors, peakPer10m: Math.max(...metric.buckets.values()) };
    });
  }

  private async exec(childEnv: Record<string, string>, args: string[], signal?: AbortSignal): Promise<string> {
    // `-q` keeps logcli's own log lines (the query URL, common labels) out of the way.
    const full = ['-q', ...args];
    try {
      return await logcli(this.bin, full, childEnv, signal);
    } catch (error) {
      if (!(error instanceof LogcliFailed)) throw error;
      const failure = lokiFailure(error.stderr);
      if (failure.kind === 'rate_limited') throw new ApiError(429, ErrorCode.RateLimited, 'Loki rate limit reached');
      if (failure.kind === 'limit') {
        throw new ApiError(502, ErrorCode.UpstreamFailed, `Loki refused the query: ${failure.reason}`);
      }
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`logcli ${args[0]}\` failed`);
    }
  }
}
