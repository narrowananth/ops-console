import { z } from 'zod';
import { FakeMcpHost, failure, hang, json, type ToolCall, type ToolDef, type ToolResult, text } from './oauth-mcp';

export type Event = { at: number; attrs: Record<string, unknown> };
type Behavior = 'throttle' | 'timeout' | 'unknownTool' | 'unreadable' | 'hang' | 'unauthorized' | 'unreachable' | null;
export type Row = Record<string, unknown>;
type Test = (row: Row) => boolean;

/** What NRQL answers with a message instead of rows. */
export class NrqlError extends Error {}

const syntax = (message: string): never => {
  throw new NrqlError(`NRQL Syntax Error: ${message}`);
};

// --- the clauses ------------------------------------------------------------------------------------------------
const KEYWORDS = ['WHERE', 'FACET', 'TIMESERIES', 'ORDER BY', 'LIMIT', 'SINCE', 'UNTIL'];

/** The text after FROM split at the clause keywords that sit outside quotes. */
function clausesOf(source: string): Record<string, string> {
  const found: { keyword: string; at: number }[] = [];
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string;
    if (char === '\\') {
      i++;
    } else if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (i === 0 || /\W/.test(source[i - 1] as string)) {
      const keyword = KEYWORDS.find((word) =>
        new RegExp(`^${word.replace(' ', '\\s+')}\\b`, 'i').test(source.slice(i)),
      );
      if (keyword) found.push({ keyword, at: i });
    }
  }
  const out: Record<string, string> = {};
  found.forEach(({ keyword, at }, index) => {
    const raw = source.slice(at + keyword.length, found[index + 1]?.at ?? source.length);
    out[keyword] = raw.replace(/^\s+/, '').replace(/\s+$/, '');
  });
  return out;
}

// --- the condition ----------------------------------------------------------------------------------------------
function tokens(source: string): string[] {
  const out: string[] = [];
  const pattern = /\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?|>=|<=|!=|=|>|<|\(|\)|,|[A-Za-z_][\w.]*)/gy;
  let last = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    out.push(match[1] as string);
    last = pattern.lastIndex;
  }
  if (source.slice(last).trim() !== '') syntax(`unexpected '${source.slice(last).trim().slice(0, 12)}'`);
  return out;
}

const unquote = (literal: string): string => literal.slice(1, -1).replace(/\\(.)/g, '$1');
const isWord = (token: string | undefined, word: string): boolean => token?.toUpperCase() === word;

/** A function of an event's attributes that answers whether it matches. */
function parseCondition(source: string): Test {
  const list = tokens(source);
  let at = 0;
  const peek = (): string | undefined => list[at];
  const next = (): string | undefined => list[at++];
  const attribute = (token: string): string => (token.startsWith('`') ? unquote(token) : token);
  const value = (): string | number => {
    const token = next();
    if (token === undefined) return syntax('a value was expected');
    if (token.startsWith("'")) return unquote(token);
    if (/^\d/.test(token)) return Number(token);
    return syntax(`unexpected '${token}'`);
  };
  function comparison(): Test {
    const name = attribute(next() ?? syntax('an attribute was expected'));
    const token = next();
    if (isWord(token, 'IS')) {
      const negated = isWord(peek(), 'NOT') && next() !== undefined;
      if (!isWord(next(), 'NULL')) syntax('NULL was expected');
      return (row) => (row[name] === undefined || row[name] === null) !== negated;
    }
    const negated = isWord(token, 'NOT');
    const operator = negated ? next() : token;
    if (isWord(operator, 'RLIKE')) {
      const pattern = String(value());
      const flag = /^\(\?i\)/.test(pattern) ? 'i' : '';
      const expression = new RegExp(`^(?:${pattern.replace(/^\(\?i\)/, '')})$`, flag);
      return (row) => typeof row[name] === 'string' && expression.test(row[name]) !== negated;
    }
    if (isWord(operator, 'LIKE')) {
      const pattern = String(value());
      const expression = new RegExp(
        `^${pattern
          .split('%')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`,
      );
      return (row) => typeof row[name] === 'string' && expression.test(row[name]) !== negated;
    }
    if (isWord(operator, 'IN')) {
      if (next() !== '(') syntax('( was expected');
      const values = [value()];
      while (peek() === ',') {
        next();
        values.push(value());
      }
      if (next() !== ')') syntax(') was expected');
      return (row) => values.includes(row[name] as string | number) !== negated;
    }
    const wanted = value();
    // Types are strict: a number is never compared with text.
    const same = (row: Row) => typeof row[name] === typeof wanted;
    const have = (row: Row) => row[name] as string | number;
    const compare: Record<string, Test> = {
      '=': (row) => same(row) && have(row) === wanted,
      '!=': (row) => same(row) && have(row) !== wanted,
      '>=': (row) => same(row) && have(row) >= wanted,
      '<=': (row) => same(row) && have(row) <= wanted,
      '>': (row) => same(row) && have(row) > wanted,
      '<': (row) => same(row) && have(row) < wanted,
    };
    return compare[operator ?? ''] ?? syntax(`unexpected '${operator}'`);
  }
  function primary(): Test {
    if (isWord(peek(), 'NOT')) {
      next();
      const inner = primary();
      return (row) => !inner(row);
    }
    if (peek() === '(') {
      next();
      const inner = or();
      if (next() !== ')') syntax(') was expected');
      return inner;
    }
    return comparison();
  }
  function and(): Test {
    const parts = [primary()];
    while (isWord(peek(), 'AND')) {
      next();
      parts.push(primary());
    }
    return (row) => parts.every((part) => part(row));
  }
  function or(): Test {
    const parts = [and()];
    while (isWord(peek(), 'OR')) {
      next();
      parts.push(and());
    }
    return (row) => parts.some((part) => part(row));
  }
  const parsed = or();
  if (at < list.length) syntax(`unexpected '${list[at]}'`);
  return parsed;
}

const UNIT: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
const MAX = 5000;
const nameOf = (token: string): string => (token.startsWith('`') ? unquote(token) : token);

/** The rows NRQL answers `query` with over `events`, or an `NrqlError`. `facetStyle` is how a FACET row names its values. */
export function runNrql(events: Event[], query: string, facetStyle: 'array' | 'keys'): Row[] {
  const selected = /^\s*SELECT\s+(.+?)\s+FROM\s+(\w+)\s*(.*)$/is.exec(query);
  if (!selected) return syntax('expected SELECT ... FROM ...');
  const [, select = '', eventType, rest = ''] = selected;
  const clauses = clausesOf(rest);

  const since = /^(\d+)\s+(minute|hour|day|week)s?\s+ago$/i.exec(clauses.SINCE ?? '1 hour ago');
  if (!since) return syntax('SINCE takes a relative time such as 24 hours ago');
  const to = Date.now();
  const from = to - Number(since[1]) * (UNIT[(since[2] as string).toLowerCase()] as number);

  const attrs = (event: Event): Row => ({ ...event.attrs, timestamp: event.at });
  let matched = eventType === 'Log' ? events.filter((event) => event.at >= from && event.at < to) : [];
  if (clauses.WHERE) {
    const test = parseCondition(clauses.WHERE);
    matched = matched.filter((event) => test(attrs(event)));
  }

  const limitOf = (fallback: number): number => {
    if (clauses.LIMIT === undefined) return fallback;
    if (/^MAX$/i.test(clauses.LIMIT)) return MAX;
    const n = Number(clauses.LIMIT);
    if (!Number.isInteger(n) || n < 1 || n > MAX) syntax(`LIMIT must be between 1 and ${MAX}`);
    return n;
  };
  const facets = clauses.FACET ? clauses.FACET.split(',').map((part) => nameOf(part.trim())) : [];
  const groupsOf = (list: Event[]): Map<string, Event[]> => {
    const groups = new Map<string, Event[]>();
    for (const event of list) {
      const facet = JSON.stringify(facets.map((name) => attrs(event)[name] ?? null));
      groups.set(facet, [...(groups.get(facet) ?? []), event]);
    }
    return groups;
  };

  const counting = /^count\(\*\)$/i.test(select);
  const uniquesOf = /^uniques\(\s*(`(?:[^`\\]|\\.)*`|[\w.]+)\s*(?:,\s*(\d+))?\s*\)$/i.exec(select);

  if (/^keyset\(\)$/i.test(select)) {
    const kinds = { string: new Set<string>(), numeric: new Set<string>(), boolean: new Set<string>() };
    for (const event of matched) {
      for (const [name, value] of Object.entries(attrs(event))) {
        const kind = typeof value === 'number' ? 'numeric' : typeof value === 'boolean' ? 'boolean' : 'string';
        kinds[kind].add(name);
      }
    }
    const sorted = (set: Set<string>) => [...set].sort();
    return [
      {
        allKeys: sorted(new Set([...kinds.string, ...kinds.numeric, ...kinds.boolean])),
        booleanKeys: sorted(kinds.boolean),
        numericKeys: sorted(kinds.numeric),
        stringKeys: sorted(kinds.string),
      },
    ];
  }
  if (uniquesOf) {
    const name = nameOf(uniquesOf[1] as string);
    const cap = Number(uniquesOf[2] ?? 1000);
    const key = `uniques.${name}`;
    const valuesOf = (list: Event[]) =>
      [...new Set(list.map((event) => attrs(event)[name]).filter((value) => value != null))].slice(0, cap);
    if (facets.length === 0) return [{ [key]: valuesOf(matched) }];
    return [...groupsOf(matched)].slice(0, limitOf(10)).map(([facet, list]) => {
      const values = JSON.parse(facet) as unknown[];
      return { facet: values.length === 1 ? values[0] : values, [key]: valuesOf(list) };
    });
  }
  if (counting) {
    if (facets.length === 0) return [{ count: matched.length }];
    const ranked = [...groupsOf(matched)].sort((a, b) => b[1].length - a[1].length).slice(0, limitOf(10));
    const shaped = (facet: string): Row => {
      const values = JSON.parse(facet) as unknown[];
      if (facetStyle === 'keys') return Object.fromEntries(facets.map((name, index) => [name, values[index]]));
      return { facet: values.length === 1 ? values[0] : values };
    };
    if (!clauses.TIMESERIES) return ranked.map(([facet, list]) => ({ ...shaped(facet), count: list.length }));
    const step = /^(\d+)\s+minutes?$/i.exec(clauses.TIMESERIES);
    if (!step) return syntax('TIMESERIES takes a bucket such as 10 minutes');
    const width = Number(step[1]) * 60_000;
    const buckets = Math.ceil((to - from) / width);
    // New Relic answers a TIMESERIES of more than 366 buckets with an error.
    if (buckets > 366) return syntax(`TIMESERIES is limited to 366 buckets, this query has ${buckets}`);
    const rows: Row[] = [];
    for (const [facet, list] of ranked) {
      for (let index = 0; index < buckets; index++) {
        const begin = to - (buckets - index) * width;
        rows.push({
          beginTimeSeconds: Math.floor(begin / 1000),
          endTimeSeconds: Math.floor((begin + width) / 1000),
          ...shaped(facet),
          count: list.filter((event) => event.at >= begin && event.at < begin + width).length,
        });
      }
    }
    return rows;
  }
  if (select === '*') {
    const ordered = [...matched].sort((a, b) => b.at - a.at);
    if (clauses['ORDER BY'] && !/^timestamp(\s+(ASC|DESC))?$/i.test(clauses['ORDER BY']))
      syntax('ORDER BY takes timestamp');
    if (/ASC$/i.test(clauses['ORDER BY'] ?? '')) ordered.reverse();
    return ordered.slice(0, limitOf(100)).map(attrs);
  }
  return syntax(`cannot select ${select}`);
}

/**
 * A stand-in for New Relic's hosted MCP server: `list_available_new_relic_accounts` and `execute_nrql_query` over log
 * events a test wrote. It takes only the bearer tokens a test grants, since New Relic's sign-in belongs to Claude Code.
 */
export class FakeNewRelic extends FakeMcpHost {
  private readonly stored: Event[] = [];
  private known = [{ id: 1234567, name: 'Example Prod' }];
  private behavior: Behavior = null;
  private reject: string | null = null;
  private readonly only: { counts?: 'hang'; samples?: 'hang' } = {};
  private facetStyle: 'array' | 'keys' = 'array';
  private asArray = false;
  private account: number | null = null;
  private cutAt: number | null = null;

  private constructor() {
    super(false);
  }

  static async start(): Promise<FakeNewRelic> {
    const newRelic = new FakeNewRelic();
    await newRelic.listen();
    return newRelic;
  }

  /** The endpoint takes this bearer token from now on. */
  grant(token: string): this {
    this.accepted.add(token);
    return this;
  }

  /** Every token is refused with a 401 until `grant` gives one again. */
  expireTokens(): this {
    this.expireAccessTokens();
    return this;
  }

  /** The accounts the sign-in can read. */
  accounts(accounts: { id: number; name: string }[]): this {
    this.known = accounts;
    return this;
  }

  /** Log events with these attributes, at times in ms. */
  events(...events: Event[]): this {
    // An attribute set to undefined is one New Relic does not store.
    this.stored.push(
      ...events.map(({ at, attrs }) => ({ at, attrs: JSON.parse(JSON.stringify(attrs)) as typeof attrs })),
    );
    return this;
  }

  /** Every call fails or hangs the way a throttled, refusing, unreachable, slow or odd server does. */
  behave(behavior: Behavior): this {
    this.behavior = behavior;
    this.unknownTools = behavior === 'unknownTool';
    this.refuse = behavior === 'unauthorized' || behavior === 'unreachable' ? behavior : null;
    return this;
  }

  /** One of a Scan's queries, the counts (`counts`) or the events (`samples`), hangs. */
  behaveOn(query: 'counts' | 'samples', behavior: 'hang'): this {
    this.only[query] = behavior;
    return this;
  }

  /** Every query fails with `message`, as New Relic does for a syntax error or a query limit. */
  rejectQueries(message: string): this {
    this.reject = message;
    return this;
  }

  /** A FACET row names its values by attribute, not in one `facet` field. */
  facetsByName(): this {
    this.facetStyle = 'keys';
    return this;
  }

  /** A query answers a bare array of rows, not an object with `results`. */
  answerAsArray(): this {
    this.asArray = true;
    return this;
  }

  /** A query for any other account answers `account not found`. */
  requiresAccount(id: number): this {
    this.account = id;
    return this;
  }

  /** A query answers at most `count` rows and says `"truncated": true`, as a server with its own row limit does. */
  truncatedAfter(count: number): this {
    this.cutAt = count;
    return this;
  }

  /** The tool calls received, in order. */
  calls(): ToolCall[] {
    return this.callLog;
  }

  /** The NRQL of each `execute_nrql_query` call, in order. */
  queries(): string[] {
    return this.callLog.flatMap((call) =>
      call.tool === 'execute_nrql_query' && typeof call.args.query === 'string' ? [call.args.query] : [],
    );
  }

  protected tools(): ToolDef[] {
    return [
      {
        name: 'list_available_new_relic_accounts',
        inputSchema: {},
        run: () => {
          if (this.behavior === 'throttle') return failure('429 Too Many Requests: rate limit exceeded');
          return json(this.known);
        },
      },
      {
        name: 'execute_nrql_query',
        inputSchema: { account_id: z.number(), query: z.string() },
        run: (args) => this.execute(args),
      },
    ];
  }

  private async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? '');
    if (this.behavior === 'hang') return hang();
    if (this.behavior === 'throttle') return failure('429 Too Many Requests: rate limit exceeded');
    if (this.behavior === 'timeout') return failure('NRQL query timed out: the query took longer than 60 seconds');
    if (this.behavior === 'unreadable') return text('this is not what the tool answers');
    if (this.account !== null && args.account_id !== this.account) return failure('account not found');
    if (this.only.counts && /TIMESERIES/i.test(query)) return hang();
    if (this.only.samples && /^\s*SELECT\s+\*/i.test(query)) return hang();
    if (this.reject !== null) return failure(this.reject);
    let rows: Row[];
    try {
      rows = runNrql(this.stored, query, this.facetStyle);
    } catch (error) {
      if (error instanceof NrqlError) return failure(error.message);
      throw error;
    }
    if (this.cutAt !== null) {
      return json({ results: rows.slice(0, this.cutAt), truncated: true });
    }
    return json(this.asArray ? rows : { results: rows });
  }
}
