// `newrelic nrql query --query <NRQL> [--format JSON]` over log events a test wrote.
//
// NR_FAKE_STATE: a JSON file { events: [{ at: ms, attrs: { "service.name": "x", ... } }],
//   behavior: null | "throttle" | "unauthorized" | "forbidden" | "unreachable" | "timeout" | "hang" | "leak",
//   reject: null | "<message of a 400 that every query answers>",
//   requires: null | { apiKey, accountId, region }: any other call is refused as a rejected key,
//   facetStyle: "array" | "keys": how a FACET row names its values,
//   only: { counts?: "hang", samples?: "hang" } }.
//   `only` applies to the counts query (it has TIMESERIES) or to the samples query (`SELECT *`).
// NR_FAKE_LOG: each call is appended here as one JSON line: its arguments, its pid and its NEW_RELIC_* variables.
//
// The output has the shapes the CLI prints: an indented JSON array of result rows. A failing call prints a logrus
// style line to stderr and exits 1. Queries are evaluated by reading what they say: SELECT of `count(*)`,
// `uniques(attr, n)`, `keyset()` or `*`, WHERE with AND, OR, NOT, parentheses, comparisons, IS [NOT] NULL, [NOT] RLIKE,
// [NOT] LIKE and IN, FACET, TIMESERIES, ORDER BY, LIMIT and a relative SINCE. NRQL's limits apply: 10 facets and 100
// rows unless LIMIT says otherwise, LIMIT is at most 5000 and a TIMESERIES has at most 366 buckets.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.NR_FAKE_STATE, 'utf8'));
const nrEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('NEW_RELIC_')));
appendFileSync(process.env.NR_FAKE_LOG, `${JSON.stringify({ args, pid: process.pid, env: nrEnv })}\n`);

const die = (message) => {
  process.stderr.write(`time="${new Date().toISOString()}" level=fatal msg=${JSON.stringify(message)}\n`);
  process.exit(1);
};

const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const [name, value] = arg.slice(2).split(/=(.*)/s);
    flags[name] = value !== undefined ? value : args[++i];
  } else positional.push(arg);
}
if (positional[0] !== 'nrql' || positional[1] !== 'query' || typeof flags.query !== 'string') {
  die('usage: newrelic nrql query --query <NRQL>');
}

const refusedKey = () => die('http response: 401 Unauthorized: the API key was not accepted');
if (state.behavior === 'unreachable') {
  die('Post "https://api.newrelic.com/graphql": dial tcp: lookup api.newrelic.com: no such host');
}
if (state.behavior === 'unauthorized') refusedKey();
if (state.behavior === 'forbidden') die('http response: 403 Forbidden: this key cannot read the account');
const { requires } = state;
if (
  requires &&
  (nrEnv.NEW_RELIC_API_KEY !== requires.apiKey ||
    nrEnv.NEW_RELIC_ACCOUNT_ID !== requires.accountId ||
    nrEnv.NEW_RELIC_REGION !== requires.region)
) {
  refusedKey();
}
if (state.behavior === 'throttle') die('http response: 429 Too Many Requests: rate limit exceeded');
if (state.behavior === 'timeout') die('NRQL query timed out: the query took longer than 60 seconds');
if (state.reject) die(state.reject);
// An account that echoes the key it was given, to show it is cut from what the agent reads.
if (state.behavior === 'leak') {
  const given = nrEnv.NEW_RELIC_API_KEY ?? '';
  process.stdout.write(`${JSON.stringify([{ message: `key ${given}` }])}\n`);
  process.stderr.write(`key ${given}\n`);
  process.exit(0);
}

/** Waits for a signal: the timer keeps the process alive, as a call that waits on New Relic does. */
const hang = () => {
  setInterval(() => {}, 1 << 30);
  return new Promise(() => {});
};

const syntax = (text) => die(`NRQL Syntax Error: ${text}`);
const query = flags.query;

// --- the clauses --------------------------------------------------------------------------------------------------
const KEYWORDS = ['WHERE', 'FACET', 'TIMESERIES', 'ORDER BY', 'LIMIT', 'SINCE', 'UNTIL'];
/** The text after FROM split at the clause keywords that sit outside quotes. */
function clausesOf(text) {
  const found = [];
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      i++;
    } else if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (i === 0 || /\W/.test(text[i - 1])) {
      const keyword = KEYWORDS.find((word) => new RegExp(`^${word.replace(' ', '\\s+')}\\b`, 'i').test(text.slice(i)));
      if (keyword) found.push({ keyword, at: i });
    }
  }
  const out = {};
  found.forEach(({ keyword, at }, index) => {
    const from = at + keyword.length;
    const raw = text.slice(from, found[index + 1]?.at ?? text.length);
    out[keyword] = raw.replace(/^\s+/, '').replace(/\s+$/, '');
  });
  return { head: text.slice(0, found[0]?.at ?? text.length).trim(), ...out };
}

const selected = /^\s*SELECT\s+(.+?)\s+FROM\s+(\w+)\s*(.*)$/is.exec(query);
if (!selected) syntax('expected SELECT ... FROM ...');
const [, select, eventType, rest] = selected;
const clauses = clausesOf(rest);

// --- the condition ------------------------------------------------------------------------------------------------
function tokens(text) {
  const out = [];
  const pattern = /\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?|>=|<=|!=|=|>|<|\(|\)|,|[A-Za-z_][\w.]*)/gy;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    out.push(match[1]);
    last = pattern.lastIndex;
  }
  if (text.slice(last).trim() !== '') syntax(`unexpected '${text.slice(last).trim().slice(0, 12)}'`);
  return out;
}
const unquote = (literal) => literal.slice(1, -1).replace(/\\(.)/g, '$1');
const isWord = (token, word) => token?.toUpperCase() === word;

/** A function of an event that answers whether it matches. */
function parseCondition(text) {
  const list = tokens(text);
  let at = 0;
  const peek = () => list[at];
  const next = () => list[at++];
  const attribute = (token) => (token.startsWith('`') ? unquote(token) : token);
  const value = () => {
    const token = next();
    if (token === undefined) syntax('a value was expected');
    if (token.startsWith("'")) return unquote(token);
    if (/^\d/.test(token)) return Number(token);
    return syntax(`unexpected '${token}'`);
  };
  function comparison() {
    const name = attribute(next() ?? syntax('an attribute was expected'));
    const token = next();
    if (isWord(token, 'IS')) {
      const negated = isWord(peek(), 'NOT') && next();
      if (!isWord(next(), 'NULL')) syntax('NULL was expected');
      return (row) => (row[name] === undefined || row[name] === null) !== Boolean(negated);
    }
    const negated = isWord(token, 'NOT');
    const operator = negated ? next() : token;
    if (isWord(operator, 'RLIKE')) {
      const pattern = value();
      const flag = /^\(\?i\)/.test(pattern) ? 'i' : '';
      const expression = new RegExp(`^(?:${pattern.replace(/^\(\?i\)/, '')})$`, flag);
      return (row) => typeof row[name] === 'string' && expression.test(row[name]) !== negated;
    }
    if (isWord(operator, 'LIKE')) {
      const pattern = value();
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
      return (row) => values.includes(row[name]) !== negated;
    }
    const wanted = value();
    // Types are strict: a number is never compared with text.
    const same = (row) => typeof row[name] === typeof wanted;
    return (
      {
        '=': (row) => same(row) && row[name] === wanted,
        '!=': (row) => same(row) && row[name] !== wanted,
        '>=': (row) => same(row) && row[name] >= wanted,
        '<=': (row) => same(row) && row[name] <= wanted,
        '>': (row) => same(row) && row[name] > wanted,
        '<': (row) => same(row) && row[name] < wanted,
      }[operator] ?? syntax(`unexpected '${operator}'`)
    );
  }
  function primary() {
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
  function and() {
    const parts = [primary()];
    while (isWord(peek(), 'AND')) {
      next();
      parts.push(primary());
    }
    return (row) => parts.every((part) => part(row));
  }
  function or() {
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

// --- the window ---------------------------------------------------------------------------------------------------
const UNIT = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
const since = /^(\d+)\s+(minute|hour|day|week)s?\s+ago$/i.exec(clauses.SINCE ?? '1 hour ago');
if (!since) syntax('SINCE takes a relative time such as 24 hours ago');
const to = Date.now();
const from = to - Number(since[1]) * UNIT[since[2].toLowerCase()];

const attrs = (event) => ({ ...event.attrs, timestamp: event.at });
let matched = eventType === 'Log' ? state.events.filter((event) => event.at >= from && event.at < to) : [];
if (clauses.WHERE) {
  const test = parseCondition(clauses.WHERE);
  matched = matched.filter((event) => test(attrs(event)));
}

// --- the answer ---------------------------------------------------------------------------------------------------
const MAX = 5000;
const limitOf = (fallback) => {
  if (clauses.LIMIT === undefined) return fallback;
  if (/^MAX$/i.test(clauses.LIMIT)) return MAX;
  const n = Number(clauses.LIMIT);
  if (!Number.isInteger(n) || n < 1 || n > MAX) syntax(`LIMIT must be between 1 and ${MAX}`);
  return n;
};
const output = (rows) => process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
const nameOf = (token) => (token.startsWith('`') ? unquote(token) : token);
const facets = clauses.FACET ? clauses.FACET.split(',').map((part) => nameOf(part.trim())) : [];

const counting = /^count\(\*\)$/i.test(select);
const uniquesOf = /^uniques\(\s*(`(?:[^`\\]|\\.)*`|[\w.]+)\s*(?:,\s*(\d+))?\s*\)$/i.exec(select);

if (state.only?.counts && clauses.TIMESERIES) await hang();
if (state.only?.samples && select === '*') await hang();

if (/^keyset\(\)$/i.test(select)) {
  const kinds = { string: new Set(), numeric: new Set(), boolean: new Set() };
  for (const event of matched) {
    for (const [name, value] of Object.entries(attrs(event))) {
      const kind = typeof value === 'number' ? 'numeric' : typeof value === 'boolean' ? 'boolean' : 'string';
      kinds[kind].add(name);
    }
  }
  const sorted = (set) => [...set].sort();
  output([
    {
      allKeys: sorted(new Set([...kinds.string, ...kinds.numeric, ...kinds.boolean])),
      booleanKeys: sorted(kinds.boolean),
      numericKeys: sorted(kinds.numeric),
      stringKeys: sorted(kinds.string),
    },
  ]);
} else if (uniquesOf) {
  const name = nameOf(uniquesOf[1]);
  const cap = Number(uniquesOf[2] ?? 1000);
  const key = `uniques.${name}`;
  const valuesOf = (events) =>
    [...new Set(events.map((event) => attrs(event)[name]).filter((value) => value != null))].slice(0, cap);
  if (facets.length === 0) output([{ [key]: valuesOf(matched) }]);
  else {
    const groups = new Map();
    for (const event of matched) {
      const facet = JSON.stringify(facets.map((facetName) => attrs(event)[facetName] ?? null));
      groups.set(facet, [...(groups.get(facet) ?? []), event]);
    }
    const rows = [...groups].slice(0, limitOf(10)).map(([facet, events]) => {
      const values = JSON.parse(facet);
      return { facet: values.length === 1 ? values[0] : values, [key]: valuesOf(events) };
    });
    output(rows);
  }
} else if (counting) {
  if (facets.length === 0) {
    output([{ count: matched.length }]);
  } else {
    const groups = new Map();
    for (const event of matched) {
      const facet = JSON.stringify(facets.map((name) => attrs(event)[name] ?? null));
      groups.set(facet, [...(groups.get(facet) ?? []), event]);
    }
    const ranked = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, limitOf(10));
    const shaped = (facet) => {
      const values = JSON.parse(facet);
      if (state.facetStyle === 'keys') return Object.fromEntries(facets.map((name, index) => [name, values[index]]));
      return { facet: values.length === 1 ? values[0] : values };
    };
    if (!clauses.TIMESERIES) {
      output(ranked.map(([facet, events]) => ({ ...shaped(facet), count: events.length })));
    } else {
      const step = /^(\d+)\s+minutes?$/i.exec(clauses.TIMESERIES);
      if (!step) syntax('TIMESERIES takes a bucket such as 10 minutes');
      const width = Number(step[1]) * 60_000;
      const buckets = Math.ceil((to - from) / width);
      // New Relic answers a TIMESERIES of more than 366 buckets with an error.
      if (buckets > 366) die(`NRQL Syntax Error: TIMESERIES is limited to 366 buckets, this query has ${buckets}`);
      const rows = [];
      for (const [facet, events] of ranked) {
        for (let index = 0; index < buckets; index++) {
          const begin = to - (buckets - index) * width;
          const count = events.filter((event) => event.at >= begin && event.at < begin + width).length;
          rows.push({
            beginTimeSeconds: Math.floor(begin / 1000),
            endTimeSeconds: Math.floor((begin + width) / 1000),
            ...shaped(facet),
            count,
          });
        }
      }
      output(rows);
    }
  }
} else if (select === '*') {
  const ordered = [...matched].sort((a, b) => b.at - a.at);
  if (clauses['ORDER BY'] && !/^timestamp(\s+(ASC|DESC))?$/i.test(clauses['ORDER BY']))
    syntax('ORDER BY takes timestamp');
  if (/ASC$/i.test(clauses['ORDER BY'] ?? '')) ordered.reverse();
  output(ordered.slice(0, limitOf(100)).map(attrs));
} else {
  syntax(`cannot select ${select}`);
}
