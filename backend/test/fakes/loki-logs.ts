import { z } from 'zod';
import { LOKI_OAUTH_KEY } from '../../src/connectors/grafana-auth';
import type { Keychain } from '../../src/keychain/keychain';
import { FakeMcpHost, failure, hang, json, type ToolCall, type ToolDef, type ToolResult, text } from './oauth-mcp';

type Entry = { at: number; line: string };
type Stream = { uid: string; labels: Record<string, string>; entries: Entry[] };
type Datasource = { uid: string; name: string; type: string };
type Behavior = 'throttle' | 'unknownTool' | 'unreadable' | 'hang' | 'unauthorized' | 'unreachable' | null;
type Labels = Record<string, string>;
type Found = { at: number; line: string; labels: Labels };

const DEFAULT_UID = 'loki-main';
const MAX_LINES = 100;

// --- the LogQL the fake reads ------------------------------------------------------------------------------------
// The selector, `| json` or `| logfmt`, the `label_format` templates (`{{ or .a .b }}`), label filters made of `=`,
// `=~` and `!~` matches joined by `or`, and `__error__=""`.
const unquote = (quoted: string): string => JSON.parse(quoted) as string;

type Matcher = { name: string; op: string; value: string };

function parseSelector(query: string): Matcher[] {
  const body = /^\s*\{(.*?)\}\s*(?:\||$)/s.exec(query.replace(/^[^{]*?(?=\{)/s, ''))?.[1] ?? '';
  const matchers: Matcher[] = [];
  for (const found of body.matchAll(/([A-Za-z_]\w*)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*")/g)) {
    matchers.push({ name: found[1] as string, op: found[2] as string, value: unquote(found[3] as string) });
  }
  return matchers;
}

const matches = (labels: Labels, matchers: Matcher[]): boolean =>
  matchers.every(({ name, op, value }) => {
    const have = labels[name] ?? '';
    if (op === '=') return have === value;
    if (op === '!=') return have !== value;
    const hit = new RegExp(`^(?:${value})$`).test(have);
    return op === '=~' ? hit : !hit;
  });

/** The text of a pipeline split on top-level `|`, leaving quoted and backtick strings whole. */
function stages(source: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') current += source[++i] ?? '';
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
    } else if (ch === '|' && source[i + 1] !== '=' && source[i + 1] !== '~') {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

function flatten(value: Record<string, unknown>, prefix = '', into: Labels = {}): Labels {
  for (const [key, inner] of Object.entries(value)) {
    const name = `${prefix}${key}`.replace(/[^A-Za-z0-9_:]/g, '_');
    if (Array.isArray(inner)) continue;
    if (inner !== null && typeof inner === 'object') flatten(inner as Record<string, unknown>, `${name}_`, into);
    else if (!(name in into)) into[name] = String(inner);
  }
  return into;
}

function parseJson(line: string): Labels | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? flatten(parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseLogfmt(line: string): Labels | null {
  const out: Labels = {};
  let any = false;
  for (const found of line.matchAll(/([A-Za-z_][\w.]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g)) {
    any = true;
    out[(found[1] as string).replace(/[^A-Za-z0-9_:]/g, '_')] =
      found[2] !== undefined ? found[2].replace(/\\(.)/g, '$1') : (found[3] as string);
  }
  return any ? out : null;
}

/** `{{ or .a .b }}` as the first of its labels that has a value, else an empty string. */
function template(source: string, labels: Labels): string {
  const names = [...source.matchAll(/\.(\w+)/g)].map((found) => found[1] as string);
  const first = names.find((name) => (labels[name] ?? '') !== '');
  return first === undefined ? '' : (labels[first] as string);
}

const RESERVED = '__error__';
type Step = (labels: Labels, line: string) => boolean;

function compile(pipeline: string[]): (labels: Labels, line: string) => boolean {
  const steps: Step[] = [];
  for (const stage of pipeline) {
    if (stage === 'json' || stage === 'logfmt') {
      steps.push((labels, line) => {
        const parsed = stage === 'json' ? parseJson(line) : parseLogfmt(line);
        if (parsed === null) labels[RESERVED] = stage === 'json' ? 'JSONParserErr' : 'LogfmtParserErr';
        else
          for (const [name, value] of Object.entries(parsed))
            labels[name in labels ? `${name}_extracted` : name] = value;
        return true;
      });
    } else if (stage.startsWith('label_format')) {
      const formats = [...stage.slice('label_format'.length).matchAll(/(\w+)\s*=\s*`([^`]*)`/g)].map((found) => ({
        name: found[1] as string,
        source: found[2] as string,
      }));
      steps.push((labels) => {
        const before = { ...labels };
        for (const { name, source } of formats) labels[name] = template(source, before);
        return true;
      });
    } else if (stage === `${RESERVED}=""`) {
      steps.push((labels) => (labels[RESERVED] ?? '') === '');
    } else {
      // A label filter: alternatives joined by `or`, each a regex or an equality match.
      const alternatives = stage.split(/\s+or\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      const tests = alternatives.map((alternative): ((labels: Labels) => boolean) => {
        const regex = /^(\w+)\s*(=~|!~)\s*("(?:[^"\\]|\\.)*")$/.exec(alternative.trim());
        if (regex) {
          const source = unquote(regex[3] as string);
          const pattern = new RegExp(`^(?:${source.replace(/^\(\?i\)/, '')})$`, source.startsWith('(?i)') ? 'i' : '');
          return (labels) => pattern.test(labels[regex[1] as string] ?? '') === (regex[2] === '=~');
        }
        const equal = /^(\w+)\s*=\s*("(?:[^"\\]|\\.)*")$/.exec(alternative.trim());
        if (equal) return (labels) => (labels[equal[1] as string] ?? '') === unquote(equal[2] as string);
        throw new Error(`the fake does not read this stage: ${alternative}`);
      });
      steps.push((labels) => tests.some((test) => test(labels)));
    }
  }
  return (labels, line) => steps.every((step) => step(labels, line));
}

const DURATION: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const durationMs = (value: string): number | null => {
  const found = /^(\d+)([smhd])$/.exec(value);
  return found ? Number(found[1]) * (DURATION[found[2] as string] as number) : null;
};

/** An RFC 3339 time, or `now` and `now-<duration>`, as ms; `fallback` when none is given. */
function timeOf(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || value === '') return fallback;
  const relative = /^now(?:-(\d+[smhd]))?$/.exec(value);
  if (relative) return Date.now() - (relative[1] ? (durationMs(relative[1]) as number) : 0);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`invalid time ${value}`);
  return parsed;
}

const METRIC = /^\s*sum(?:\s+by\s*\(([^)]*)\))?\s*\(\s*count_over_time\s*\(/;

/**
 * A stand-in for Grafana Cloud's hosted MCP server, with Loki behind it: the OAuth endpoints a client signs in with, and
 * the `list_datasources` and `query_loki_logs` tools of mcp-grafana, over streams of raw log lines a test wrote. Log
 * queries return at most 100 lines a call, newest first, as the real tool does.
 */
export class FakeGrafana extends FakeMcpHost {
  private sources: Datasource[] = [{ uid: DEFAULT_UID, name: 'Loki (prod)', type: 'loki' }];
  private readonly streams: Stream[] = [];
  private behavior: Behavior = null;
  private reject: string | null = null;
  private readonly only: { counts?: 'hang'; samples?: 'hang' } = {};
  private maxLines = MAX_LINES;
  private paging = true;
  private says = true;

  private constructor() {
    super(true);
  }

  static async start(): Promise<FakeGrafana> {
    const grafana = new FakeGrafana();
    await grafana.listen();
    return grafana;
  }

  /** The console is signed in: the Keychain holds the item the daemon's own sign-in leaves, with tokens this fake accepts. */
  async signedIn(keychain: Keychain): Promise<this> {
    const client = { client_id: 'seed-client', redirect_uris: ['http://127.0.0.1:1/callback'] };
    await keychain.set(LOKI_OAUTH_KEY, JSON.stringify({ client, tokens: this.issueTokens() }));
    return this;
  }

  /** The tool calls received, in order. */
  calls(): ToolCall[] {
    return this.callLog;
  }

  /** The names of the tools called, in order. */
  commands(): string[] {
    return this.callLog.map((call) => call.tool);
  }

  /** The LogQL of each `query_loki_logs` call, in order. */
  queries(): string[] {
    return this.callLog.flatMap((call) =>
      call.tool === 'query_loki_logs' && typeof call.args.logql === 'string' ? [call.args.logql] : [],
    );
  }

  /** Adds a data source to the stack. */
  datasource(uid: string, name: string, type = 'loki'): this {
    this.sources.push({ uid, name, type });
    return this;
  }

  /** Replaces the stack's data sources; none by default leaves a stack with no Loki. */
  datasources(sources: Datasource[]): this {
    this.sources = sources;
    return this;
  }

  /** A stream with these labels in the data source `uid`, holding `entries` (time in ms, and the JSON or plain line). */
  stream(labels: Labels, entries: { at: number; line: string | object }[] = [], uid = DEFAULT_UID): this {
    this.streams.push({
      uid,
      labels,
      entries: entries.map(({ at, line }) => ({ at, line: typeof line === 'string' ? line : JSON.stringify(line) })),
    });
    return this;
  }

  /** Every call fails or hangs the way a throttled, refusing, unreachable, slow or odd server does. */
  behave(behavior: Behavior): this {
    this.behavior = behavior;
    this.unknownTools = behavior === 'unknownTool';
    this.refuse = behavior === 'unauthorized' || behavior === 'unreachable' ? behavior : null;
    return this;
  }

  /** One of a Scan's two queries, the metric one (`counts`) or the log one (`samples`), hangs. */
  behaveOn(query: 'counts' | 'samples', behavior: 'hang'): this {
    this.only[query] = behavior;
    return this;
  }

  /** Every query answers with a 400 whose body is `body`, as Loki does for a query limit. */
  rejectQueries(body: string): this {
    this.reject = body;
    return this;
  }

  /** Every log query answers the same newest lines and says more follow, whatever end time it gives. */
  neverPages(): this {
    this.paging = false;
    return this;
  }

  /** A log query never says its result was cut: the reader sees only how many lines came back. */
  saysNothingOfTruncation(): this {
    this.says = false;
    return this;
  }

  /** Lines a log query answers at most; a test uses a small number to page without thousands of lines. */
  maxLinesPerCall(count: number): this {
    this.maxLines = count;
    return this;
  }

  protected tools(): ToolDef[] {
    return [
      {
        name: 'list_datasources',
        inputSchema: {
          type: z.string().optional(),
          name: z.string().optional(),
          limit: z.number().optional(),
          offset: z.number().optional(),
        },
        run: (args) => this.listDatasources(args),
      },
      {
        name: 'query_loki_logs',
        inputSchema: {
          datasourceUid: z.string(),
          logql: z.string(),
          startRfc3339: z.string().optional(),
          endRfc3339: z.string().optional(),
          limit: z.number().optional(),
          direction: z.string().optional(),
          queryType: z.string().optional(),
          stepSeconds: z.number().optional(),
          format: z.string().optional(),
        },
        run: (args) => this.queryLogs(args),
      },
    ];
  }

  private listDatasources(args: Record<string, unknown>): ToolResult {
    if (this.behavior === 'throttle') return failure('grafana API returned status code 429: too many requests');
    const type = typeof args.type === 'string' ? args.type.toLowerCase() : '';
    const name = typeof args.name === 'string' ? args.name.toLowerCase() : '';
    const matching = this.sources
      .map((source, index) => ({ id: index + 1, ...source }))
      .filter((source) => source.type.toLowerCase().includes(type) && source.name.toLowerCase().includes(name));
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const limit = Math.min(typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50, 100);
    const page = matching.slice(offset, offset + limit);
    return json({
      datasources: page.map(({ id, uid, name: sourceName, type: sourceType }) => ({
        id,
        uid,
        name: sourceName,
        type: sourceType,
        isDefault: id === 1,
      })),
      total: matching.length,
      hasMore: offset + limit < matching.length,
    });
  }

  private async queryLogs(args: Record<string, unknown>): Promise<ToolResult> {
    const uid = String(args.datasourceUid ?? '');
    const query = String(args.logql ?? '');
    if (this.behavior === 'hang') return hang();
    if (this.behavior === 'throttle') return failure('loki API returned status code 429: too many requests');
    if (this.behavior === 'unreadable') return text('this is not what the tool answers');
    if (!this.sources.some((source) => source.uid === uid)) return failure('datasource not found');
    const metric = METRIC.exec(query);
    if (this.only[metric ? 'counts' : 'samples'] === 'hang') return hang();
    if (this.reject !== null) return failure(`loki API returned status code 400: ${this.reject}`);

    const now = Date.now();
    const instant = args.queryType === 'instant';
    const from = timeOf(args.startRfc3339, now - 3_600_000);
    const to = timeOf(args.endRfc3339, now);
    const range = metric ? /\[(\d+[smhd])\]\s*\)\s*\)\s*$/.exec(query) : null;
    if (metric && !range) return failure('the fake runs only sum(count_over_time(... [range])) metric queries');
    const pipelineText = metric && range ? query.slice(metric[0].length, range.index) : query;
    const matchers = parseSelector(pipelineText);
    const afterSelector = pipelineText.slice(pipelineText.indexOf('}') + 1).replace(/^\s*\|/, '');
    const keep = compile(stages(afterSelector));
    const rangeMs = metric && range ? (durationMs(range[1] as string) ?? 0) : 0;

    const found: Found[] = [];
    const readFrom = instant ? now - rangeMs : from;
    const inWindow = (at: number) =>
      metric && instant ? at > readFrom && at <= now : at >= from && at < (metric ? to : this.logEnd(to, now));
    for (const stream of this.streams.filter((one) => one.uid === uid && matches(one.labels, matchers))) {
      for (const entry of stream.entries) {
        if (!inWindow(entry.at)) continue;
        const labels = { ...stream.labels };
        if (keep(labels, entry.line)) found.push({ at: entry.at, line: entry.line, labels });
      }
    }

    if (!metric) return this.lines(found, args, from, to);
    const by = (metric[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const metricOf = (entry: Found): Labels =>
      Object.fromEntries(by.flatMap((name) => (entry.labels[name] ? [[name, entry.labels[name] as string]] : [])));
    if (instant) {
      const counts = new Map<string, number>();
      for (const entry of found)
        counts.set(JSON.stringify(metricOf(entry)), (counts.get(JSON.stringify(metricOf(entry))) ?? 0) + 1);
      return json({
        data: [...counts].map(([key, count]) => ({
          labels: JSON.parse(key) as Labels,
          value: count,
          timestamp: new Date(now).toISOString(),
        })),
      });
    }
    const step = (typeof args.stepSeconds === 'number' && args.stepSeconds > 0 ? args.stepSeconds : 600) * 1000;
    const series = new Map<string, { timestamp: string; value: number }[]>();
    for (let t = from; t <= to; t += step) {
      const counts = new Map<string, number>();
      for (const entry of found) {
        if (entry.at <= t - rangeMs || entry.at > t) continue;
        const key = JSON.stringify(metricOf(entry));
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const [key, count] of counts) {
        const values = series.get(key) ?? [];
        values.push({ timestamp: new Date(t).toISOString(), value: count });
        series.set(key, values);
      }
    }
    return json({ data: [...series].map(([key, values]) => ({ labels: JSON.parse(key) as Labels, values })) });
  }

  /** The end a log query reads to: its own, or now when the server never pages. */
  private logEnd(to: number, now: number): number {
    return this.paging ? to : now + 1;
  }

  private lines(found: Found[], args: Record<string, unknown>, from: number, to: number): ToolResult {
    const asked = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 10;
    const limit = Math.min(asked, this.maxLines);
    const forward = args.direction === 'forward';
    found.sort((a, b) => (forward ? a.at - b.at : b.at - a.at));
    const page = found.slice(0, limit);
    return json({
      data: page.map((entry) => ({
        timestamp: new Date(entry.at).toISOString(),
        line: entry.line,
        labels: entry.labels,
      })),
      metadata: {
        linesReturned: page.length,
        maxLinesAllowed: this.maxLines,
        resultsTruncated: this.says && (!this.paging || found.length > limit),
        totalLinesScanned: null,
        startTime: new Date(from).toISOString(),
        endTime: new Date(to).toISOString(),
      },
    });
  }
}
