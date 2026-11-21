import { createHash } from 'node:crypto';
import { NO_ENV, type Sample, type ScanWindow, WINDOW_HOURS } from '@ops-console/shared';
import { z } from 'zod';
import { mapLimit } from '../common/map-limit';
import {
  HostedAuthError,
  HostedFailed,
  type HostedOpen,
  type HostedTools,
  readFailure,
} from '../connectors/hosted-mcp';
import {
  FATAL_ERROR_LEVEL,
  groupEntries,
  ignoredRanges,
  type LogEntry,
  type LogReader,
  pathPattern,
  type ReadRequest,
  routeOf,
  type ServiceCount,
  type ServiceReading,
  statusCodeOf,
  withRouteCounts,
} from './log-reader';

/** The names a log line may use for each field after parsing, first present wins. Nested keys are joined with `_`. */
const STATUS_FIELDS = ['status', 'statusCode', 'status_code', 'http_status_code'];
const METHOD_FIELDS = ['method', 'httpMethod', 'http_method'];
const ROUTE_FIELDS = ['route', 'path', 'resourcePath', 'url_path'];
const LEVEL_FIELDS = ['level', 'severity', 'log_level'];
const MESSAGE_FIELDS = ['message', 'msg'];

/** At most this many failing lines a Scan reads per Service. */
const SAMPLE_LINES = 5_000;
/** The most lines Grafana's hosted server returns for one call. */
const LINES_PER_CALL = 100;
const SERVICES_AT_ONCE = 4;
const STEP_MS = 600_000;
const ENV_WINDOW_MS = 7 * 86_400_000;

/** The labels Loki readings group by: the names OpenTelemetry's Loki exporter gives them. */
export const SERVICE_LABEL = 'service_name';
export const ENV_LABEL = 'deployment_environment_name';

const quote = (text: string) => JSON.stringify(text);
const names = (fields: string[]) => fields.map((name) => `.${name}`).join(' ');

/** Each field under one name that does not clash with the log's own. `or` takes the first non-empty value. */
const ALIASES = `| label_format f_code=\`{{ or ${names(STATUS_FIELDS)} }}\`, f_method=\`{{ or ${names(METHOD_FIELDS)} }}\`, f_route=\`{{ or ${names(ROUTE_FIELDS)} }}\`, f_level=\`{{ or ${names(LEVEL_FIELDS)} }}\``;
/** A string match on the code, since a number filter keeps a line whose code is not a number. */
const FAILING = `| f_code=~"[4-9][0-9][0-9]" or f_level=~"(?i)(${FATAL_ERROR_LEVEL.join('|')})"`;
const FAILING_CODE = '| f_code=~"[4-9][0-9][0-9]"';

const labelsSchema = z
  .record(z.string(), z.string())
  .nullish()
  .transform((labels) => labels ?? {});
const entrySchema = z.looseObject({
  timestamp: z.string().optional(),
  line: z.string().optional(),
  labels: labelsSchema,
  value: z.number().optional(),
  values: z.array(z.looseObject({ timestamp: z.string(), value: z.number() })).optional(),
});
/** What `query_loki_logs` answers: log entries, or metric samples, and how the server cut them. */
const answerSchema = z.looseObject({
  data: z.array(entrySchema),
  metadata: z.looseObject({ resultsTruncated: z.boolean().optional() }).optional(),
});
type Answer = z.infer<typeof answerSchema>;
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

/** The line's fields as Loki names them, and the same fields as the Sample keeps them; null when the line is not JSON. */
function parseLine(line: string): { flat: Flat; attributes: Record<string, unknown> } | null {
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

const minutesOf = (milliseconds: number) => `${Math.max(1, Math.round(milliseconds / 60_000))}m`;
const rangeOf = (window: ScanWindow) => `${Math.round(WINDOW_HOURS[window] * 60)}m`;

/** A log entry's time in ms: an RFC 3339 time, or a number of seconds, milliseconds, microseconds or nanoseconds. */
function timeOf(stamp: string | undefined): number {
  if (stamp === undefined) return Number.NaN;
  if (!/^\d+(?:\.\d+)?$/.test(stamp)) return Date.parse(stamp);
  const value = Number(stamp);
  if (value >= 1e17) return Math.floor(value / 1e6);
  if (value >= 1e14) return Math.floor(value / 1e3);
  return value >= 1e11 ? value : value * 1000;
}

type Found = { at: number; line: string };

/**
 * Loki read through Grafana Cloud's hosted MCP server, signed in with the console's own token. A Scan lists the
 * Services from the streams the service label names, counts failing lines per 10 minutes with a metric query, and
 * reads the newest failing lines as Samples, a page at a time. The failing test, the field names and the ignored codes
 * are LogQL, so Loki does the filtering. A failure names the server and its own words.
 */
export class LokiLogs implements LogReader {
  constructor(
    /** The Loki data source the Connector reads. */
    private readonly source: () => string,
    private readonly open: HostedOpen,
    /** Told when Grafana refuses the sign-in, so the Connector reads needs auth. */
    private readonly onAuthLost: () => void,
  ) {}

  async read(request: ReadRequest): Promise<ServiceReading[]> {
    const window = this.windowOf(request.window);
    return this.within(async (tools, uid) => {
      const streams = (await this.streams(tools, uid, window.to - window.from, request)).filter(
        (stream) => request.envs.includes(stream.env) && (!request.services || request.services.includes(stream.name)),
      );
      const readings = await mapLimit(streams, SERVICES_AT_ONCE, async (service): Promise<ServiceReading | null> => {
        const base = this.pipeline(this.selector(service), this.exclusions(request));
        const evaluated = this.evaluationPoints(window);
        const [counts, lines] = await Promise.all([
          this.rows(
            tools,
            uid,
            {
              logql: this.counted(base, '10m'),
              queryType: 'range',
              startRfc3339: evaluated.from,
              endRfc3339: evaluated.to,
              stepSeconds: STEP_MS / 1000,
            },
            request.signal,
          ),
          this.lines(tools, uid, base, window, request.signal),
        ]);
        const entries = this.entries(service, lines.found);
        const total = counts.reduce((sum, row) => sum + row.points.reduce((points, [, count]) => points + count, 0), 0);
        if (total > SAMPLE_LINES || lines.capped) {
          request.note?.(`${service.name}: read the newest ${SAMPLE_LINES.toLocaleString('en-US')} failing lines only`);
        }
        const groups = withRouteCounts(
          groupEntries(entries, ({ statusCode, method, path }) =>
            JSON.stringify({
              service: service.name,
              env: service.env,
              status: statusCode,
              method: method || null,
              path: path || null,
            }),
          ),
          counts.map((row) => ({
            statusCode: statusCodeOf(row.metric.f_code),
            ...routeOf(row.metric.f_method, row.metric.f_route),
            points: row.points,
          })),
        );
        return groups.length > 0 ? { name: service.name, env: service.env, groups, repoUrl: null } : null;
      });
      if (streams.length === 0) {
        request.note?.(`Loki logs: no Services found under the label ${SERVICE_LABEL}`);
      }
      return readings
        .flatMap((reading) => (reading ? [reading] : []))
        .sort((a, b) => a.name.localeCompare(b.name) || a.env.localeCompare(b.env));
    }, request.signal);
  }

  async envs(): Promise<string[]> {
    return this.within(async (tools, uid) => {
      const streams = await this.streams(tools, uid, ENV_WINDOW_MS, {});
      return [...new Set(streams.map((stream) => stream.env))].sort();
    });
  }

  async services(envs: string[], window: ScanWindow, codes: number[]): Promise<ServiceCount[]> {
    const query = `sum by (${SERVICE_LABEL}, ${ENV_LABEL}, f_code) (count_over_time(${this.pipeline(this.selector(), [FAILING])} [${rangeOf(window)}]))`;
    const rows = await this.within((tools, uid) => this.rows(tools, uid, { logql: query, queryType: 'instant' }));
    const totals = new Map<string, ServiceCount>();
    for (const row of rows) {
      const name = row.metric[SERVICE_LABEL];
      const stream = row.metric[ENV_LABEL] || NO_ENV;
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
    const query = `sum by (f_code) (count_over_time(${this.pipeline(this.selector(), [FAILING_CODE])} [${rangeOf(window)}]))`;
    const rows = await this.within((tools, uid) => this.rows(tools, uid, { logql: query, queryType: 'instant' }));
    const codes: { code: number; count: number }[] = [];
    for (const row of rows) {
      const code = statusCodeOf(row.metric.f_code);
      if (code !== null) codes.push({ code, count: row.points.reduce((sum, [, count]) => sum + count, 0) });
    }
    return codes.sort((a, b) => b.count - a.count || a.code - b.code);
  }

  async countLogs(query: string, window: ScanWindow): Promise<number> {
    const filter = filterSchema.parse(JSON.parse(query));
    const conditions = [FAILING];
    if (filter.status !== null) conditions.push(`| f_code=${quote(String(filter.status))}`);
    if (filter.method !== null) {
      conditions.push(`| f_method=~${quote(`(?i)${filter.method.replace(/[^A-Za-z]/g, '')}`)}`);
    }
    if (filter.path !== null) conditions.push(`| f_route=~${quote(pathPattern(filter.path))}`);
    const selector = this.selector({ name: filter.service, env: filter.env });
    const text = `sum(count_over_time(${this.pipeline(selector, conditions)} [${rangeOf(window)}]))`;
    const [row] = await this.within((tools, uid) => this.rows(tools, uid, { logql: text, queryType: 'instant' }));
    return row?.points.reduce((sum, [, count]) => sum + count, 0) ?? 0;
  }

  /** `use` in one session with the Connector's data source; a failure ends as the Scan's error, a refused sign-in also tells the Connector. */
  private async within<T>(use: (tools: HostedTools, uid: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const uid = this.source();
    try {
      return await this.open((tools) => use(tools, uid), signal);
    } catch (error) {
      if (error instanceof HostedAuthError) this.onAuthLost();
      throw readFailure(error, 'Loki logs');
    }
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

  /** `{service_name=..., deployment_environment_name=...}`; every Service when none is named. */
  private selector(service?: { name: string; env: string }): string {
    const parts = service
      ? [
          `${SERVICE_LABEL}=${quote(service.name)}`,
          service.env === NO_ENV ? `${ENV_LABEL}=""` : `${ENV_LABEL}=${quote(service.env)}`,
        ]
      : [`${SERVICE_LABEL}=~".+"`];
    return `{${parts.join(', ')}}`;
  }

  /** Parse, drop lines that do not parse, name the fields, then keep what `after` says. */
  private pipeline(selector: string, after: string[]): string {
    return `${selector} | json | __error__="" ${ALIASES} ${after.join(' ')}`;
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

  /** Every (service, env) with a stream in the last `span` ms. Told when none has the service label. */
  private async streams(
    tools: HostedTools,
    uid: string,
    span: number,
    request: Pick<ReadRequest, 'signal'>,
  ): Promise<{ name: string; env: string }[]> {
    const query = `sum by (${SERVICE_LABEL}, ${ENV_LABEL}) (count_over_time(${this.selector()} [${minutesOf(span)}]))`;
    const rows = await this.rows(tools, uid, { logql: query, queryType: 'instant' }, request.signal);
    const seen = new Map<string, { name: string; env: string }>();
    for (const row of rows) {
      const name = row.metric[SERVICE_LABEL];
      if (name === undefined || name === '') continue;
      const env = row.metric[ENV_LABEL] || NO_ENV;
      seen.set(JSON.stringify([name, env]), { name, env });
    }
    return [...seen.values()];
  }

  /** One metric query as rows, each with its points; one point for an instant query. */
  private async rows(
    tools: HostedTools,
    uid: string,
    query: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Row[]> {
    signal?.throwIfAborted();
    const answer = await this.query(tools, uid, query);
    if (answer.metadata?.resultsTruncated) {
      throw new HostedFailed('the server cut the result at its own row limit');
    }
    return answer.data.map((entry) => ({
      metric: entry.labels,
      points:
        entry.values?.map(({ timestamp, value }): [number, number] => [timeOf(timestamp) / 1000, value]) ??
        (entry.value === undefined ? [] : [[Date.now() / 1000, entry.value] as [number, number]]),
    }));
  }

  private query(tools: HostedTools, uid: string, query: Record<string, unknown>): Promise<Answer> {
    return tools.callJson('query_loki_logs', { datasourceUid: uid, ...query }, answerSchema);
  }

  /**
   * The newest failing lines in the window, at most `SAMPLE_LINES`: the server returns a hundred a call, so each call
   * starts where the last one's oldest line ended. A server that returns the same lines again is not paging.
   */
  private async lines(
    tools: HostedTools,
    uid: string,
    logql: string,
    window: { from: number; to: number },
    signal?: AbortSignal,
  ): Promise<{ found: Found[]; capped: boolean }> {
    const found = new Map<string, Found>();
    let capped = false;
    let end = window.to;
    while (found.size < SAMPLE_LINES) {
      signal?.throwIfAborted();
      // One more than is missing: each call after the first starts on the line the last one ended with.
      const asked = Math.min(LINES_PER_CALL, SAMPLE_LINES - found.size + 1);
      const answer = await this.query(tools, uid, {
        logql,
        startRfc3339: new Date(window.from).toISOString(),
        endRfc3339: new Date(end).toISOString(),
        limit: asked,
        direction: 'backward',
      });
      const before = found.size;
      let oldest = end;
      for (const entry of answer.data) {
        const at = timeOf(entry.timestamp);
        if (entry.line === undefined || Number.isNaN(at)) continue;
        found.set(JSON.stringify([entry.timestamp, entry.line]), { at, line: entry.line });
        oldest = Math.min(oldest, at);
      }
      // A page as long as the limit asked for may have more behind it, whatever the server says of truncation.
      const full = answer.metadata?.resultsTruncated === true || answer.data.length >= asked;
      if (!full || answer.data.length === 0) break;
      capped = found.size >= SAMPLE_LINES;
      // The next call includes the oldest millisecond again: a second line may share it.
      const next = oldest + 1;
      if (found.size === before || next >= end)
        throw new HostedFailed('the server did not page: it returned the same lines again');
      end = next;
    }
    return { found: [...found.values()].sort((a, b) => b.at - a.at).slice(0, SAMPLE_LINES), capped };
  }

  /** One failing line as a Scan groups it; none for a line that is not JSON. */
  private entries(service: { name: string; env: string }, lines: Found[]): LogEntry[] {
    const entries: LogEntry[] = [];
    for (const { at, line } of lines) {
      const parsed = parseLine(line);
      if (parsed === null) continue;
      const { flat, attributes } = parsed;
      const level = firstOf(flat, LEVEL_FIELDS);
      const stamp = new Date(at).toISOString();
      const sample: Sample = {
        // The same line read by two Scans is one Sample.
        id: createHash('sha256')
          .update(JSON.stringify([service.name, service.env, stamp, line]))
          .digest('hex')
          .slice(0, 32),
        timestamp: stamp,
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
}
