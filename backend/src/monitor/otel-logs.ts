import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ErrorCode, NO_ENV, type Sample, ScanWindow, WINDOW_HOURS } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { normalizePath } from './fingerprint';
import {
  groupEntries,
  type LogEntry,
  type LogReader,
  type ReadRequest,
  type ServiceCount,
  type ServiceReading,
  statusKept,
} from './log-reader';

/** A Scan reads at most this many bytes from the Log folder, newest files first. */
export const READ_LIMIT_BYTES = 100 * 1024 * 1024;

const MEGABYTE = 1024 * 1024;
const ENV_WINDOW = ScanWindow.Week;
/** OpenTelemetry's `ERROR` severity number: a record at or above it is failing whatever its status code. */
const ERROR_SEVERITY = 17;
const FATAL_SEVERITY = 21;
const anyValueSchema = z
  .object({
    stringValue: z.string().optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
    boolValue: z.boolean().optional(),
    doubleValue: z.number().optional(),
  })
  .loose();
type AnyValue = z.infer<typeof anyValueSchema>;
const attributesSchema = z.array(z.object({ key: z.string(), value: anyValueSchema.optional() }).loose()).optional();
const nanos = z.union([z.string(), z.number()]).optional();
const recordSchema = z
  .object({
    timeUnixNano: nanos,
    observedTimeUnixNano: nanos,
    severityNumber: z.union([z.number(), z.string()]).optional(),
    severityText: z.string().optional(),
    body: anyValueSchema.optional(),
    attributes: attributesSchema,
    traceId: z.string().optional(),
    spanId: z.string().optional(),
  })
  .loose();
type LogRecord = z.infer<typeof recordSchema>;
/** One line of a Collector's file exporter. */
const requestSchema = z.object({
  resourceLogs: z.array(
    z
      .object({
        resource: z.object({ attributes: attributesSchema }).loose().optional(),
        scopeLogs: z.array(z.object({ logRecords: z.array(recordSchema).optional() }).loose()).optional(),
      })
      .loose(),
  ),
});

/** The filter an Alert keeps to find its records again. */
const filterSchema = z.object({
  service: z.string(),
  env: z.string(),
  status: z.number().int().nullable(),
  method: z.string().nullable(),
  path: z.string().nullable(),
});
type Filter = z.infer<typeof filterSchema>;

/** A record read from the folder, with the fields a Scan groups by. */
type Found = {
  service: string;
  env: string;
  time: number;
  severity: number | null;
  entry: LogEntry;
};

type Walk = { files: number; skippedLines: number; skippedFiles: number; capped: boolean };

function plainValue(value: AnyValue | undefined): string | number | boolean | undefined {
  if (value === undefined) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) {
    const int = Number(value.intValue);
    return Number.isSafeInteger(int) ? int : String(value.intValue);
  }
  return value.boolValue ?? value.doubleValue;
}

function attributesOf(list: z.infer<typeof attributesSchema>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const { key, value } of list ?? []) {
    const found = plainValue(value);
    if (found !== undefined) out[key] = found;
  }
  return out;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** The OpenTelemetry severity number as the status a Sample shows, in the words Datadog uses. */
function statusOf(number: number | null, severityText: string | undefined): string {
  if (number === null || number < 1) return severityText?.toLowerCase() || 'unspecified';
  if (number >= FATAL_SEVERITY) return 'fatal';
  if (number >= ERROR_SEVERITY) return 'error';
  if (number >= 13) return 'warn';
  if (number >= 9) return 'info';
  return number >= 5 ? 'debug' : 'trace';
}

/** Nanoseconds since the epoch, as milliseconds; null for a record with no usable time. */
function millisOf(...candidates: (string | number | undefined)[]): number | null {
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value / 1e6);
    if (typeof value === 'string' && /^\d+$/.test(value) && value !== '0') return Number(BigInt(value) / 1_000_000n);
  }
  return null;
}

/** One record of one resource, as a Scan reads it; null for a record with no time. */
function readRecord(resource: Record<string, string | number | boolean>, record: LogRecord): Found | null {
  const time = millisOf(record.timeUnixNano, record.observedTimeUnixNano);
  if (time === null) return null;
  const own = attributesOf(record.attributes);
  const attribute = (...keys: string[]) => keys.map((key) => own[key] ?? resource[key]).find((v) => v !== undefined);
  const service = text(resource['service.name']) ?? 'unknown_service';
  const env = text(attribute('deployment.environment.name', 'deployment.environment')) ?? NO_ENV;
  const code = Number(attribute('http.response.status_code', 'http.status_code'));
  const statusCode = Number.isInteger(code) && code > 0 ? code : null;
  const method = text(attribute('http.request.method', 'http.method'));
  const route = text(attribute('http.route', 'url.path'));
  const severityNumber = Number(record.severityNumber);
  const severity = record.severityNumber === undefined || Number.isNaN(severityNumber) ? null : severityNumber;
  const body = plainValue(record.body);
  const message = body === undefined || body === '' ? '(no message)' : String(body);
  const version = text(resource['service.version']);
  const attributes: Record<string, unknown> = {
    ...resource,
    ...own,
    ...(severity === null ? {} : { severity_number: severity }),
    ...(record.traceId ? { trace_id: record.traceId } : {}),
    ...(record.spanId ? { span_id: record.spanId } : {}),
  };
  const sample: Sample = {
    // The same record read by two Scans is one Sample.
    id: createHash('sha256')
      .update(JSON.stringify([time, message, attributes]))
      .digest('hex')
      .slice(0, 32),
    timestamp: new Date(time).toISOString(),
    status: statusOf(severity, record.severityText),
    message,
    attributes,
    tags: [`service:${service}`, ...(env === NO_ENV ? [] : [`env:${env}`]), ...(version ? [`version:${version}`] : [])],
  };
  return {
    service,
    env,
    time,
    severity,
    entry: {
      sample,
      statusCode,
      method: method && route ? method.toUpperCase() : '',
      path: method && route ? normalizePath(route) : '',
    },
  };
}

const failing = ({ severity, entry }: Found) =>
  (entry.statusCode !== null && entry.statusCode >= 400) || (severity !== null && severity >= ERROR_SEVERITY);

function sizeOf(bytes: number): string {
  return bytes >= MEGABYTE ? `${Math.round(bytes / MEGABYTE)} MB` : `${bytes} bytes`;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * OTLP JSON log records a Collector's `file` exporter wrote into one folder, read by the daemon as the operator, read
 * only (ADR 0003). Reads `.json` and `.jsonl` files directly in the folder, newest first, one request per line.
 */
export class OtelLogFolder implements LogReader {
  constructor(
    private readonly folder: () => string,
    private readonly limit = READ_LIMIT_BYTES,
  ) {}

  async read(request: ReadRequest): Promise<ServiceReading[]> {
    const kept = statusKept(request);
    const byService = new Map<string, { name: string; env: string; entries: LogEntry[] }>();
    const walked = await this.walk(request.window, request.signal, (found) => {
      const { statusCode } = found.entry;
      if (!failing(found) || !request.envs.includes(found.env)) return;
      if (request.services && !request.services.includes(found.service)) return;
      if (!kept(statusCode)) return;
      const key = `${found.env}\n${found.service}`;
      const service = byService.get(key) ?? { name: found.service, env: found.env, entries: [] };
      service.entries.push(found.entry);
      byService.set(key, service);
    });
    this.noteOf(walked, request.note);
    return [...byService.values()]
      .map(({ name, env, entries }) => {
        const newestFirst = entries.sort((a, b) => b.sample.timestamp.localeCompare(a.sample.timestamp));
        const groups = groupEntries(newestFirst, ({ statusCode, method, path }) =>
          JSON.stringify({ service: name, env, status: statusCode, method: method || null, path: path || null }),
        );
        return { name, env, groups, repoUrl: null };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.env.localeCompare(b.env));
  }

  async envs(): Promise<string[]> {
    const names = new Set<string>();
    await this.walk(ENV_WINDOW, undefined, ({ env }) => {
      if (env !== NO_ENV) names.add(env);
    });
    return [...names].sort();
  }

  async services(envs: string[], window: ScanWindow, codes: number[]): Promise<ServiceCount[]> {
    const counts = new Map<string, ServiceCount>();
    await this.walk(window, undefined, (found) => {
      const { statusCode } = found.entry;
      if (!failing(found) || !envs.includes(found.env)) return;
      if (codes.length > 0 && (statusCode === null || !codes.includes(statusCode))) return;
      const key = `${found.env}\n${found.service}`;
      const count = counts.get(key) ?? { name: found.service, env: found.env, errors: 0 };
      count.errors += 1;
      counts.set(key, count);
    });
    return [...counts.values()];
  }

  async statusCodes(window: ScanWindow): Promise<{ code: number; count: number }[]> {
    const counts = new Map<number, number>();
    await this.walk(window, undefined, (found) => {
      const { statusCode } = found.entry;
      if (failing(found) && statusCode !== null && statusCode >= 400) {
        counts.set(statusCode, (counts.get(statusCode) ?? 0) + 1);
      }
    });
    return [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code - b.code);
  }

  async countLogs(query: string, window: ScanWindow): Promise<number> {
    const filter: Filter = filterSchema.parse(JSON.parse(query));
    let matched = 0;
    await this.walk(window, undefined, (found) => {
      const { statusCode, method, path } = found.entry;
      if (!failing(found) || found.service !== filter.service || found.env !== filter.env) return;
      if (filter.status !== null && statusCode !== filter.status) return;
      if (filter.method !== null && method !== filter.method) return;
      if (filter.path !== null && path !== filter.path) return;
      matched += 1;
    });
    return matched;
  }

  private noteOf(walked: Walk, note: ((text: string) => void) | undefined): void {
    if (!note) return;
    if (walked.files === 0) note('The Log folder has no .json or .jsonl files');
    if (walked.capped) note(`Read the newest ${sizeOf(this.limit)} only`);
    if (walked.skippedLines > 0) {
      const { skippedLines: n } = walked;
      note(
        `Skipped ${n} ${plural(n, 'line that was not a valid log record', 'lines that were not valid log records')}`,
      );
    }
    if (walked.skippedFiles > 0) {
      const { skippedFiles: n } = walked;
      note(`Skipped ${n} ${plural(n, 'file', 'files')} that could not be read`);
    }
  }

  /** Every record of the window in the folder's files, newest file first, up to the read limit. */
  private async walk(
    window: ScanWindow,
    signal: AbortSignal | undefined,
    visit: (found: Found) => void,
  ): Promise<Walk> {
    const folder = this.folder();
    const names = await readdir(folder).catch(() => {
      throw new ApiError(422, ErrorCode.FolderNotFound, 'Folder not found or not readable');
    });
    const from = Date.now() - WINDOW_HOURS[window] * 3_600_000;
    const walked: Walk = { files: 0, skippedLines: 0, skippedFiles: 0, capped: false };
    const files: { file: string; modified: number; size: number }[] = [];
    for (const name of names.filter((one) => /\.jsonl?$/i.test(one))) {
      const file = path.join(folder, name);
      const found = await stat(file).catch(() => null);
      if (found === null) walked.skippedFiles += 1;
      else if (found.isFile()) {
        walked.files += 1;
        // A file untouched since before the window holds no record of it.
        if (found.mtimeMs >= from) files.push({ file, modified: found.mtimeMs, size: found.size });
      }
    }
    files.sort((a, b) => b.modified - a.modified);
    let remaining = this.limit;
    for (const { file, size } of files) {
      // A file past what is left of the budget gives its newest bytes: a log file grows at its end.
      const tail = size > remaining;
      if (tail) walked.capped = true;
      if (remaining <= 0) break;
      const decoder = new StringDecoder('utf8');
      let rest = '';
      let skipPartial = tail;
      const take = (line: string) => {
        if (line.trim() === '') return;
        const parsed = this.parse(line);
        if (parsed === null) {
          walked.skippedLines += 1;
          return;
        }
        let bad = false;
        for (const found of parsed) {
          if (found === null) bad = true;
          else if (found.time >= from) visit(found);
        }
        if (bad) walked.skippedLines += 1;
      };
      try {
        // One byte before the tail shows whether the tail starts on a line.
        const start = tail ? size - remaining - 1 : 0;
        for await (const chunk of createReadStream(file, { start })) {
          signal?.throwIfAborted();
          rest += decoder.write(chunk as Buffer);
          const lines = rest.split('\n');
          rest = lines.pop() ?? '';
          for (const line of lines) {
            if (skipPartial) skipPartial = false;
            else take(line);
          }
        }
        if (!skipPartial) take(rest + decoder.end());
        remaining -= tail ? remaining : size;
      } catch (error) {
        if (signal?.aborted) throw error;
        walked.skippedFiles += 1;
      }
    }
    return walked;
  }

  /** The records of one line, `null` for a record with no time; null when the line is not a log request at all. */
  private parse(line: string): (Found | null)[] | null {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return null;
    }
    const request = requestSchema.safeParse(json);
    if (!request.success) return null;
    return request.data.resourceLogs.flatMap((resourceLog) => {
      const resource = attributesOf(resourceLog.resource?.attributes);
      return (resourceLog.scopeLogs ?? []).flatMap((scope) =>
        (scope.logRecords ?? []).map((record) => readRecord(resource, record)),
      );
    });
  }
}
