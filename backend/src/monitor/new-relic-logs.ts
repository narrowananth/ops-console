import { createHash } from 'node:crypto';
import { NO_ENV, type Sample, type ScanWindow, WINDOW_HOURS } from '@ops-console/shared';
import { z } from 'zod';
import { mapLimit } from '../common/map-limit';
import { HostedAuthError, type HostedOpen, readFailure } from '../connectors/hosted-mcp';
import { type NewRelicRegion, type NewRelicRow, newRelicTools } from '../connectors/new-relic-mcp';
import {
  FATAL_ERROR_LEVEL,
  groupEntries,
  type LogEntry,
  type LogReader,
  pathPattern,
  type ReadRequest,
  routeOf,
  type ServiceCount,
  type ServiceReading,
  statusCodeOf,
  statusKept,
  withRouteCounts,
} from './log-reader';

/** The attributes New Relic readings group by: the names OpenTelemetry's exporters give them. */
export const SERVICE_ATTRIBUTE = 'service.name';
export const ENV_ATTRIBUTE = 'environment';

/** The names an event may use for each field, first present wins. */
const STATUS_FIELDS = ['http.response.status_code', 'http.status_code', 'status', 'statusCode', 'status_code'];
const METHOD_FIELDS = ['http.request.method', 'http.method', 'method', 'httpMethod'];
const ROUTE_FIELDS = ['http.route', 'url.path', 'route', 'path', 'resourcePath'];
const LEVEL_FIELDS = ['level', 'severity.text', 'severity', 'log_level'];
const MESSAGE_FIELDS = ['message', 'msg'];

/** At most this many failing events a Scan reads per Service: NRQL's `LIMIT` ceiling. */
const SAMPLE_EVENTS = 5_000;
const SERVICES_AT_ONCE = 4;
/** NRQL's TIMESERIES holds at most 366 buckets: 61 hours of 10-minute ones. */
const COUNT_MINUTES = 61 * 60;
const ENV_WINDOW_MINUTES = 7 * 1440;
/** The most `uniques()` returns. */
const UNIQUES_LIMIT = 10_000;

/** The filter an Alert keeps to find its events again. */
const filterSchema = z.object({
  service: z.string(),
  env: z.string(),
  status: z.number().int().nullable(),
  method: z.string().nullable(),
  path: z.string().nullable(),
});

type Row = NewRelicRow;
/** One NRQL query's rows, for the account the Connector reads. */
type Run = (nrql: string) => Promise<Row[]>;
/** An attribute the account has, and the kinds of value it holds. */
type Attribute = { name: string; numeric: boolean; text: boolean };
/** The attributes an account or a Service has for each field, in the order of the names above. */
type Fields = { status: Attribute[]; level: Attribute[]; method: string[]; route: string[]; message: string[] };

/** An attribute name, in backticks so a dot is part of the name. */
const name = (attribute: string) => `\`${attribute.replaceAll('`', '\\`')}\``;
/** A string value, escaped. */
const text = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const minutesOf = (window: ScanWindow) => Math.round(WINDOW_HOURS[window] * 60);
const since = (minutes: number) => `SINCE ${minutes} minutes ago`;
const where = (...conditions: (string | null)[]) => `WHERE ${conditions.filter(Boolean).join(' AND ')}`;

/** The attributes `keyset()` lists, from its rows. Without a type, an attribute may hold either. */
function attributesOf(rows: Row[]): Map<string, Attribute> {
  const names = (row: Row, key: string): string[] => {
    const value = row[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  };
  const found = new Map<string, Attribute>();
  for (const row of rows) {
    const numeric = new Set(names(row, 'numericKeys'));
    const strings = new Set(names(row, 'stringKeys'));
    const every = [...names(row, 'allKeys'), ...numeric, ...strings, ...names(row, 'booleanKeys')];
    for (const attribute of every) {
      const untyped = !numeric.has(attribute) && !strings.has(attribute);
      found.set(attribute, {
        name: attribute,
        numeric: numeric.has(attribute) || untyped,
        text: strings.has(attribute) || untyped,
      });
    }
  }
  return found;
}

/** Every name present for a field when `all`, else the first. */
function fieldsOf(attributes: Map<string, Attribute>, all: boolean): Fields {
  const present = (names: string[]) => {
    const found = names.flatMap((one) => attributes.get(one) ?? []);
    return all ? found : found.slice(0, 1);
  };
  const plain = (names: string[]) => present(names).map((attribute) => attribute.name);
  return {
    status: present(STATUS_FIELDS),
    level: present(LEVEL_FIELDS),
    method: plain(METHOD_FIELDS),
    route: plain(ROUTE_FIELDS),
    message: plain(MESSAGE_FIELDS),
  };
}

/** The status codes of 400 and up, for a number and for text. */
const statusFailing = ({ name: attribute, numeric, text: isText }: Attribute): string[] => [
  ...(numeric ? [`${name(attribute)} >= 400`] : []),
  ...(isText ? [`${name(attribute)} RLIKE '[4-9][0-9][0-9]'`] : []),
];

/** What makes an event failing: a status of 400 or more, or an error level in any case. Null when no field can tell. */
function failing(fields: Fields): string | null {
  const levels = `(?i)(${FATAL_ERROR_LEVEL.join('|')})`;
  const parts = [
    ...fields.status.flatMap(statusFailing),
    ...fields.level.map((level) => `${name(level.name)} RLIKE ${text(levels)}`),
  ];
  return parts.length > 0 ? `(${parts.join(' OR ')})` : null;
}

/** The first of `names` the row holds, as the Service's field. */
const firstOf = (row: Row, names: string[]): unknown =>
  names.map((one) => row[one]).find((value) => value !== undefined && value !== null && value !== '');

/** The values of a FACET row, in the order of `facets`: its `facet` field, or one field per attribute. */
function facetValues(row: Row, facets: string[]): unknown[] {
  if (Array.isArray(row.facet)) return row.facet;
  if (facets.length === 1 && 'facet' in row) return [row.facet];
  return facets.map((facet) => row[facet]);
}

/** The env a facet value names: none for an event with no env attribute. */
const envOf = (value: unknown): string => (typeof value === 'string' && value !== '' ? value : NO_ENV);

type ServiceKey = { name: string; env: string };

/**
 * New Relic logs read through New Relic's hosted MCP server, signed in with the token Claude Code stored for it. A Scan
 * lists the Services from the distinct values of the service attribute on failing events, asks once per Service which
 * attribute names its logs use, counts failing events per 10 minutes with one NRQL query, and reads the newest failing
 * events with another. A failure names the server and its own words.
 */
export class NewRelicLogs implements LogReader {
  constructor(
    /** The account and Region the Connector reads. */
    private readonly source: () => { accountId: string; region: NewRelicRegion },
    private readonly open: (region: NewRelicRegion) => HostedOpen,
    /** Told when New Relic refuses the sign-in, so the Connector reads needs auth. */
    private readonly onAuthLost: () => void,
  ) {}

  /** `use` in one session with the Connector's account; a failure ends as the Scan's error, a refused sign-in also tells the Connector. */
  private async within<T>(use: (run: Run) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const { accountId, region } = this.source();
    try {
      return await this.open(region)(async (tools) => {
        const api = await newRelicTools(tools);
        return use((nrql) => {
          signal?.throwIfAborted();
          return api.nrql(accountId, nrql);
        });
      }, signal);
    } catch (error) {
      if (error instanceof HostedAuthError) this.onAuthLost();
      throw readFailure(error, 'New Relic logs');
    }
  }

  async read(request: ReadRequest): Promise<ServiceReading[]> {
    return this.within(async (run) => {
      const minutes = minutesOf(request.window);
      const keep = statusKept(request);
      const countMinutes = Math.min(minutes, COUNT_MINUTES);
      if (countMinutes < minutes) request.note?.('New Relic logs: counts read the newest 61 hours only');
      const found = (await this.serviceKeys(run, minutes)).filter(
        (service) =>
          request.envs.includes(service.env) && (!request.services || request.services.includes(service.name)),
      );
      const readings = await mapLimit(found, SERVICES_AT_ONCE, async (service): Promise<ServiceReading | null> => {
        const scope = this.scope(service);
        const keys = await run(`SELECT keyset() FROM Log ${where(scope)} ${since(minutes)}`);
        const fields = fieldsOf(attributesOf(keys), false);
        const failingNow = failing(fields);
        if (failingNow === null) return null;
        const conditions = where(scope, failingNow);
        const facets = [fields.status[0]?.name, fields.method[0], fields.route[0]].filter(
          (one): one is string => one !== undefined,
        );
        const facetClause = facets.length > 0 ? `FACET ${facets.map(name).join(', ')} ` : '';
        const [counted, read] = await Promise.all([
          run(
            `SELECT count(*) FROM Log ${conditions} ${facetClause}${facets.length > 0 ? 'LIMIT MAX ' : ''}TIMESERIES 10 minutes ${since(countMinutes)}`,
          ),
          run(`SELECT * FROM Log ${conditions} ORDER BY timestamp DESC LIMIT ${SAMPLE_EVENTS} ${since(minutes)}`),
        ]);
        const entries = read.flatMap((row) => this.entryOf(service, fields, row, keep));
        const counts = counted.flatMap((row) => {
          const values = facetValues(row, facets);
          const at = (attribute: string | undefined) =>
            attribute === undefined ? undefined : values[facets.indexOf(attribute)];
          const statusCode = statusCodeOf(at(fields.status[0]?.name));
          if (!keep(statusCode)) return [];
          return [
            {
              statusCode,
              ...routeOf(at(fields.method[0]), at(fields.route[0])),
              points: [[Number(row.beginTimeSeconds ?? 0), Number(row.count ?? 0)] as [number, number]],
            },
          ];
        });
        const total = counts.flatMap(({ points }) => points).reduce((sum, [, count]) => sum + count, 0);
        if (total > SAMPLE_EVENTS) {
          request.note?.(
            `${service.name}: read the newest ${SAMPLE_EVENTS.toLocaleString('en-US')} failing events only`,
          );
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
          counts,
        );
        return groups.length > 0 ? { name: service.name, env: service.env, groups, repoUrl: null } : null;
      });
      if ((await this.attributes(run, minutes)).size === 0) {
        request.note?.(`New Relic logs: no Services found under the attribute ${SERVICE_ATTRIBUTE}`);
      }
      return readings
        .flatMap((reading) => (reading ? [reading] : []))
        .sort((a, b) => a.name.localeCompare(b.name) || a.env.localeCompare(b.env));
    }, request.signal);
  }

  async envs(): Promise<string[]> {
    return this.within(async (run) => {
      const rows = await run(
        `SELECT count(*) FROM Log ${where(`${name(SERVICE_ATTRIBUTE)} IS NOT NULL`)} FACET ${name(ENV_ATTRIBUTE)} LIMIT MAX ${since(ENV_WINDOW_MINUTES)}`,
      );
      // Events with no env are their own choice in the Scan, not an env to list.
      return [...new Set(rows.map((row) => envOf(facetValues(row, [ENV_ATTRIBUTE])[0])))]
        .filter((env) => env !== NO_ENV)
        .sort();
    });
  }

  async services(envs: string[], window: ScanWindow, codes: number[]): Promise<ServiceCount[]> {
    return this.within(async (run) => {
      const minutes = minutesOf(window);
      const all = fieldsOf(await this.attributes(run, minutes), true);
      const failingNow = failing(all);
      const among = codes.length > 0 ? this.codesAmong(all.status, codes) : null;
      if (failingNow === null || among === '') return [];
      const asked = among === null ? null : `(${among})`;
      const rows = await run(
        `SELECT count(*) FROM Log ${where(failingNow, asked)} FACET ${name(SERVICE_ATTRIBUTE)}, ${name(ENV_ATTRIBUTE)} LIMIT MAX ${since(minutes)}`,
      );
      return rows.flatMap((row): ServiceCount[] => {
        const [service, env] = facetValues(row, [SERVICE_ATTRIBUTE, ENV_ATTRIBUTE]);
        const errors = Number(row.count ?? 0);
        return typeof service === 'string' && envs.includes(envOf(env)) && errors > 0
          ? [{ name: service, env: envOf(env), errors }]
          : [];
      });
    });
  }

  async statusCodes(window: ScanWindow): Promise<{ code: number; count: number }[]> {
    return this.within(async (run) => {
      const minutes = minutesOf(window);
      const totals = new Map<number, number>();
      for (const attribute of fieldsOf(await this.attributes(run, minutes), true).status) {
        const rows = await run(
          `SELECT count(*) FROM Log ${where(`(${statusFailing(attribute).join(' OR ')})`)} FACET ${name(attribute.name)} LIMIT MAX ${since(minutes)}`,
        );
        for (const row of rows) {
          const code = statusCodeOf(facetValues(row, [attribute.name])[0]);
          if (code !== null) totals.set(code, (totals.get(code) ?? 0) + Number(row.count ?? 0));
        }
      }
      return [...totals].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code - b.code);
    });
  }

  async countLogs(query: string, window: ScanWindow): Promise<number> {
    const filter = filterSchema.parse(JSON.parse(query));
    return this.within(async (run) => {
      const minutes = minutesOf(window);
      const scope = this.scope({ name: filter.service, env: filter.env });
      const fields = fieldsOf(
        attributesOf(await run(`SELECT keyset() FROM Log ${where(scope)} ${since(minutes)}`)),
        false,
      );
      const failingNow = failing(fields);
      if (failingNow === null) return 0;
      const conditions: string[] = [];
      if (filter.status !== null) {
        const [status] = fields.status;
        if (status === undefined) return 0;
        conditions.push(`(${this.codesAmong([status], [filter.status])})`);
      }
      if (filter.method !== null) {
        const [method] = fields.method;
        if (method === undefined) return 0;
        conditions.push(`${name(method)} RLIKE ${text(`(?i)${filter.method.replace(/[^A-Za-z]/g, '')}`)}`);
      }
      if (filter.path !== null) {
        const [route] = fields.route;
        if (route === undefined) return 0;
        conditions.push(`${name(route)} RLIKE ${text(pathPattern(filter.path))}`);
      }
      const [row] = await run(`SELECT count(*) FROM Log ${where(scope, failingNow, ...conditions)} ${since(minutes)}`);
      return Number(row?.count ?? 0);
    });
  }

  /** `(service attribute) = 'name' AND (env attribute) = 'env'`; an env of `no env` is an event with none. */
  private scope(service: ServiceKey): string {
    const env = name(ENV_ATTRIBUTE);
    return [
      `${name(SERVICE_ATTRIBUTE)} = ${text(service.name)}`,
      service.env === NO_ENV ? `(${env} IS NULL OR ${env} = '')` : `${env} = ${text(service.env)}`,
    ].join(' AND ');
  }

  /** The attributes any event of the source has. */
  private async attributes(run: Run, minutes: number) {
    return attributesOf(
      await run(`SELECT keyset() FROM Log ${where(`${name(SERVICE_ATTRIBUTE)} IS NOT NULL`)} ${since(minutes)}`),
    );
  }

  /** The condition that an event's status is one of `codes`, on any of `attributes`; empty when there is none. */
  private codesAmong(attributes: Attribute[], codes: number[]): string {
    return attributes
      .flatMap(({ name: attribute, numeric, text: isText }) => [
        ...(numeric ? [`${name(attribute)} IN (${codes.join(', ')})`] : []),
        ...(isText ? [`${name(attribute)} IN (${codes.map((code) => text(String(code))).join(', ')})`] : []),
      ])
      .join(' OR ');
  }

  /** Every (service, env) with a failing event in the window, inside the filter. */
  private async serviceKeys(run: Run, minutes: number): Promise<ServiceKey[]> {
    const failingNow = failing(fieldsOf(await this.attributes(run, minutes), true));
    if (failingNow === null) return [];
    const rows = await run(
      `SELECT uniques(${name(SERVICE_ATTRIBUTE)}, ${UNIQUES_LIMIT}) FROM Log ${where(failingNow)} FACET ${name(ENV_ATTRIBUTE)} LIMIT MAX ${since(minutes)}`,
    );
    const seen = new Map<string, ServiceKey>();
    for (const row of rows) {
      const env = envOf(facetValues(row, [ENV_ATTRIBUTE])[0]);
      const names = Object.values(row).find(Array.isArray) ?? [];
      for (const found of names.flatMap((one) => asText(one) ?? []))
        seen.set(JSON.stringify([found, env]), { name: found, env });
    }
    return [...seen.values()];
  }

  /** One failing event as a Scan groups it; none for one the Scan does not read. */
  private entryOf(
    service: ServiceKey,
    fields: Fields,
    row: Row,
    keep: (statusCode: number | null) => boolean,
  ): LogEntry[] {
    const at = typeof row.timestamp === 'number' ? row.timestamp : Date.parse(String(row.timestamp));
    const statusCode = statusCodeOf(
      firstOf(
        row,
        fields.status.map((status) => status.name),
      ),
    );
    if (Number.isNaN(at) || !keep(statusCode)) return [];
    const { timestamp: _timestamp, ...attributes } = row;
    const level = asText(
      firstOf(
        row,
        fields.level.map((one) => one.name),
      ),
    );
    const message = firstOf(row, fields.message);
    const sample: Sample = {
      // The same event read by two Scans is one Sample.
      id: createHash('sha256')
        .update(JSON.stringify([service.name, service.env, at, attributes]))
        .digest('hex')
        .slice(0, 32),
      timestamp: new Date(at).toISOString(),
      status: level ? level.toLowerCase() : 'error',
      message: typeof message === 'string' ? message : message === undefined ? '(no message)' : JSON.stringify(message),
      attributes,
      tags: [`service:${service.name}`, `env:${service.env}`],
    };
    return [{ sample, statusCode, ...routeOf(firstOf(row, fields.method), firstOf(row, fields.route)) }];
  }
}
