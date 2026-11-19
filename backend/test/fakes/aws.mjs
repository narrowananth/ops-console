#!/usr/bin/env node
// `aws logs start-query | get-query-results | stop-query` over raw log events a test wrote.
//
// AWS_FAKE_STATE: a JSON file { groups: { "<log group>": { events: [{ at: ms, message: "<line>" }] } },
//   behavior: null | "throttle" | "signed_out" | "unreachable" | "hang", bytes: <bytes each query scans>,
//   startDelayMs: <how long start-query takes>, only: { counts?: "hang" | "fail", events?: "hang" | "fail" } }.
//   A group the file does not list does not exist. "hang" leaves every query running; `only` does so for one of the
//   Scan's two queries ("counts" is the one that aggregates, "events" the one that sorts), and "fail" ends it Failed.
// AWS_FAKE_LOG: each call is appended here as one JSON line.
//
// Queries are not parsed in full. The fake reads what the console's two queries say about field names and failing
// events (the coalesce lists, the status threshold, the level list) and evaluates them over the raw events, so a
// query that leaves out a name the spec lists finds fewer events.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
// Like the CLI, a value that starts with `-` is read as the next option unless it is written `--name=value`.
const flag = (name) => {
  const joined = args.find((arg) => arg.startsWith(`--${name}=`));
  if (joined !== undefined) return joined.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  if (at === -1) return undefined;
  if (args[at + 1] === undefined || args[at + 1].startsWith('-')) {
    process.stderr.write(`aws: error: argument --${name}: expected one argument\n`);
    process.exit(252);
  }
  return args[at + 1];
};
const state = JSON.parse(readFileSync(process.env.AWS_FAKE_STATE, 'utf8'));
if (process.env.AWS_FAKE_LOG) {
  appendFileSync(
    process.env.AWS_FAKE_LOG,
    `${JSON.stringify({ args, profile: flag('profile'), region: flag('region') })}\n`,
  );
}

const fail = (code, operation, message, exit = 254) => {
  process.stderr.write(`An error occurred (${code}) when calling the ${operation} operation: ${message}\n`);
  process.exit(exit);
};
const [service, command] = args;
if (service !== 'logs') process.exit(2);

if (state.behavior === 'signed_out') {
  process.stderr.write('Error when retrieving token from sso: Token has expired and refresh failed\n');
  process.exit(255);
}
if (state.behavior === 'unreachable') {
  process.stderr.write('Could not connect to the endpoint URL: "https://logs.us-east-1.amazonaws.com/"\n');
  process.exit(255);
}
if (state.behavior === 'throttle' && command !== 'stop-query') {
  fail('ThrottlingException', 'StartQuery', '(reached max retries: 2) Rate exceeded');
}

const out = (body) => process.stdout.write(`${JSON.stringify(body)}\n`);

if (command === 'stop-query') {
  out({ success: true });
  process.exit(0);
}

if (command === 'start-query') {
  const group = flag('log-group-name');
  if (!state.groups[group]) fail('ResourceNotFoundException', 'StartQuery', 'The specified log group does not exist.');
  const query = {
    group,
    from: Number(flag('start-time')) * 1000,
    to: Number(flag('end-time')) * 1000,
    text: flag('query-string'),
  };
  setTimeout(() => {
    out({ queryId: Buffer.from(JSON.stringify(query)).toString('base64url') });
    process.exit(0);
  }, state.startDelayMs ?? 0);
  await new Promise(() => {});
}

if (command !== 'get-query-results') process.exit(2);
const query = JSON.parse(Buffer.from(flag('query-id'), 'base64url').toString());
const only = state.only?.[/sort\s+@timestamp/.test(query.text) ? 'events' : 'counts'];
if (state.behavior === 'hang' || only === 'hang') {
  out({ status: 'Running', results: [], statistics: { bytesScanned: 0 } });
  process.exit(0);
}
if (only === 'fail') {
  out({ status: 'Failed', results: [], statistics: { bytesScanned: 0 } });
  process.exit(0);
}

// `fields a, b, "x" as alias`: each name is a field of the line, an alias made before it, or a quoted fallback.
const aliases = [...query.text.matchAll(/coalesce\(([^)]*)\)\s+as\s+(\w+)/g)].map(([, list, alias]) => [
  alias,
  list.split(',').map((name) => name.trim().replace(/^`|`$/g, '')),
]);
const [, codeAlias, threshold] = /(\w+)\s*>=\s*(\d+)/.exec(query.text) ?? [];
const [, levelAlias, levelList] = /tolower\((\w+)\)\s+in\s+\[([^\]]*)\]/.exec(query.text) ?? [];
const levels = (levelList ?? '').split(',').map((level) => level.trim().replace(/^"|"$/g, ''));

const lookup = (json, name) => {
  if (name in json) return json[name];
  let at = json;
  for (const part of name.split('.')) at = at !== null && typeof at === 'object' ? at[part] : undefined;
  return at;
};
const first = (json, row, list) =>
  list
    .map((name) => (/^".*"$/.test(name) ? name.slice(1, -1) : name in row ? row[name] : lookup(json, name)))
    .find((value) => value !== undefined && value !== null);

const rows = [];
for (const event of state.groups[query.group].events) {
  if (event.at < query.from || event.at >= query.to) continue;
  let json;
  try {
    json = JSON.parse(event.message);
  } catch {
    continue;
  }
  if (json === null || typeof json !== 'object') continue;
  const row = {};
  for (const [alias, list] of aliases) row[alias] = first(json, row, list);
  const failing =
    (codeAlias !== undefined && row[codeAlias] !== undefined && Number(row[codeAlias]) >= Number(threshold)) ||
    (levelAlias !== undefined && levels.includes(String(row[levelAlias] ?? '').toLowerCase()));
  if (!failing) continue;
  const code = /(\w+)\s*=\s*(\d+)\b/.exec(query.text);
  if (code && String(row[code[1]]) !== code[2]) continue;
  const method = /toupper\((\w+)\)\s*=\s*"([^"]*)"/.exec(query.text);
  if (method && String(row[method[1]] ?? '').toUpperCase() !== method[2]) continue;
  const route = /(\w+)\s+like\s+\/(.*?)\/\s*(?:\||$)/.exec(query.text);
  if (route && !new RegExp(route[2].replaceAll('\\/', '/')).test(String(row[route[1]] ?? ''))) continue;
  rows.push({ event, row });
}

const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const field = (name, value) => ({ field: name, value: String(value) });
let results;
const stats = /stats\s+count\(\*\)\s+as\s+(\w+)(?:\s+by\s+([^|]*))?/.exec(query.text);
if (stats) {
  const dims = (stats[2] ?? '')
    .split(',')
    .map((dim) => dim.trim())
    .filter(Boolean);
  const limit = Number(/limit\s+(\d+)/.exec(query.text)?.[1] ?? 10000);
  const buckets = new Map();
  for (const { event, row } of rows) {
    const values = dims.map((dim) => {
      const bin = /^bin\((\d+)m\)\s+as\s+(\w+)$/.exec(dim);
      if (bin) return [bin[2], stamp(Math.floor(event.at / (Number(bin[1]) * 60_000)) * Number(bin[1]) * 60_000)];
      return [dim, row[dim]];
    });
    // An event with no value for a field it is grouped by is left out, as Logs Insights leaves it out.
    if (values.some(([, value]) => value === null || value === undefined)) continue;
    const key = JSON.stringify(values);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  results = [...buckets]
    .slice(0, limit)
    .map(([key, count]) => [...JSON.parse(key).map(([name, value]) => field(name, value)), field(stats[1], count)]);
} else {
  const limit = Number(/limit\s+(\d+)/.exec(query.text)?.[1] ?? 10000);
  results = rows
    .sort((a, b) => b.event.at - a.event.at)
    .slice(0, limit)
    .map(({ event }) => [field('@timestamp', stamp(event.at)), field('@message', event.message)]);
}
out({ status: 'Complete', results, statistics: { recordsMatched: rows.length, bytesScanned: state.bytes ?? 1000 } });
