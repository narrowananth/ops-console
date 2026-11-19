// `logcli query | labels | series` over raw log lines a test wrote.
//
// LOKI_FAKE_STATE: a JSON file { streams: [{ labels: {..}, entries: [{ at: ms, line }] }],
//   behavior: null | "throttle" | "unauthorized" | "forbidden" | "unreachable" | "hang" | "leak",
//   capitalized: true when the error line starts "Error response", as the POST paths of logcli print it.
//   reject: null | "<body of a 400 that `query` answers>",
//   auth: null | { basic: { username, password } } | { bearer: token },
//   orgId: null | "<the X-Scope-OrgID the server accepts>",
//   only: { counts?: "hang", samples?: "hang" } }.
//   `only` applies to the metric query (`counts`) or to the log query (`samples`).
// LOKI_FAKE_LOG: each call is appended here as one JSON line: its arguments, its pid and its LOKI_* variables.
//
// The output has the shapes logcli prints: `-o jsonl` lines for log queries, an indented JSON matrix for metric
// queries whatever `-o` says, `{k="v", ...}` lines for series, one name per line for labels, and a failing call prints
// the response body to stderr without the status code and exits 1. Queries are evaluated by reading what they say:
// the selector, `| json` or `| logfmt`, the `label_format` templates (`{{ or .a .b }}`), label filters made of `=`,
// `=~` and `!~` matches joined by `or`, and `__error__=""`.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.LOKI_FAKE_STATE, 'utf8'));
const lokiEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('LOKI_')));
delete lokiEnv.LOKI_FAKE_STATE;
delete lokiEnv.LOKI_FAKE_LOG;
appendFileSync(process.env.LOKI_FAKE_LOG, `${JSON.stringify({ args, pid: process.pid, env: lokiEnv })}\n`);

const stamp = () => new Date().toISOString().replace(/-/g, '/').replace('T', ' ').slice(0, 19);
const die = (text) => {
  process.stderr.write(`${stamp()} ${text}\n`);
  process.exit(1);
};
/** What logcli prints when the server answers with a body and no 2xx. */
const refused = (body) => {
  process.stderr.write(
    `${stamp()} ${state.capitalized ? 'Error' : 'error'} response from server: ${body} (<nil>) attempts remaining: 0\n`,
  );
  die('Query failed: run out of attempts while querying the server');
};

// Flags: `--name value`, `--name=value`, `-o value`, and bare switches.
const SWITCHES = new Set(['quiet', 'forward', 'no-labels', 'include-common-labels', 'stats']);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const short = { '-q': 'quiet', '-o': 'output', '-z': 'timezone' }[arg];
  if (short) {
    flags[short] = SWITCHES.has(short) ? true : args[++i];
  } else if (arg.startsWith('--')) {
    const [name, value] = arg.slice(2).split(/=(.*)/s);
    flags[name] = value !== undefined ? value : SWITCHES.has(name) ? true : args[++i];
  } else positional.push(arg);
}
const [command, ...rest] = positional;

if (state.behavior === 'unreachable') {
  process.stderr.write(
    `${stamp()} error sending request Get "${lokiEnv.LOKI_ADDR}/loki/api/v1/${command}": dial tcp 127.0.0.1:3100: connect: connection refused\n`,
  );
  die('Query failed: run out of attempts while querying the server');
}
if (lokiEnv.LOKI_BEARER_TOKEN && (lokiEnv.LOKI_USERNAME || lokiEnv.LOKI_PASSWORD)) {
  die('Query failed: bearer token and basic auth cannot be used together');
}
if (state.behavior === 'unauthorized') refused('Unauthorized');
if (state.behavior === 'forbidden') refused('Forbidden');
const { auth, orgId } = state;
if (auth?.basic && (lokiEnv.LOKI_USERNAME !== auth.basic.username || lokiEnv.LOKI_PASSWORD !== auth.basic.password)) {
  refused('invalid authentication credentials');
}
if (auth?.bearer && lokiEnv.LOKI_BEARER_TOKEN !== auth.bearer) refused('invalid authentication credentials');
if (orgId && lokiEnv.LOKI_ORG_ID !== orgId) refused('no org id');
if (state.behavior === 'throttle') refused('rate limit exceeded: too many requests');
// A Loki that echoes the credentials it was given, to show they are cut from what the agent reads.
if (state.behavior === 'leak') {
  const given = `${lokiEnv.LOKI_PASSWORD ?? ''}${lokiEnv.LOKI_BEARER_TOKEN ?? ''}`;
  process.stdout.write(`${JSON.stringify({ line: `credentials ${given}`, timestamp: new Date().toISOString() })}\n`);
  process.stderr.write(`credentials ${given}\n`);
  process.exit(0);
}

/** Waits for a signal: the timer keeps the process alive, as a call that waits on Loki does. */
const hang = () => {
  setInterval(() => {}, 1 << 30);
  return new Promise(() => {});
};

const DURATION = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const durationMs = (text) => {
  const found = /^(\d+)([smhd])$/.exec(text ?? '');
  return found ? Number(found[1]) * DURATION[found[2]] : null;
};
const to = flags.to ? Date.parse(flags.to) : Date.now();
const from = flags.from ? Date.parse(flags.from) : to - (durationMs(flags.since) ?? 3_600_000);

// --- selector and pipeline -------------------------------------------------------------------------------------
const unquote = (text) => JSON.parse(text);
function parseSelector(query) {
  const body = /^\s*\{(.*?)\}\s*(?:\||$)/s.exec(query.replace(/^[^{]*?(?=\{)/s, ''))?.[1] ?? '';
  const matchers = [];
  const pattern = /([A-Za-z_]\w*)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*")/g;
  for (let found = pattern.exec(body); found; found = pattern.exec(body)) {
    matchers.push({ name: found[1], op: found[2], value: unquote(found[3]) });
  }
  return matchers;
}
const matches = (labels, matchers) =>
  matchers.every(({ name, op, value }) => {
    const have = labels[name] ?? '';
    if (op === '=') return have === value;
    if (op === '!=') return have !== value;
    const hit = new RegExp(`^(?:${value})$`).test(have);
    return op === '=~' ? hit : !hit;
  });

/** The text of a pipeline split on top-level `|`, leaving quoted and backtick strings whole. */
function stages(text) {
  const out = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') current += text[++i];
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
    } else if (ch === '|' && text[i + 1] !== '=' && text[i + 1] !== '~') {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

const flatten = (value, prefix = '', into = {}) => {
  for (const [key, inner] of Object.entries(value)) {
    const name = `${prefix}${key}`.replace(/[^A-Za-z0-9_:]/g, '_');
    if (Array.isArray(inner)) continue;
    if (inner !== null && typeof inner === 'object') flatten(inner, `${name}_`, into);
    else if (!(name in into)) into[name] = String(inner);
  }
  return into;
};
const parseJson = (line) => {
  try {
    const parsed = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? flatten(parsed) : null;
  } catch {
    return null;
  }
};
const parseLogfmt = (line) => {
  const out = {};
  const pattern = /([A-Za-z_][\w.]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g;
  let any = false;
  for (let found = pattern.exec(line); found; found = pattern.exec(line)) {
    any = true;
    out[found[1].replace(/[^A-Za-z0-9_:]/g, '_')] =
      found[2] !== undefined ? found[2].replace(/\\(.)/g, '$1') : found[3];
  }
  return any ? out : null;
};

/** `{{ or .a .b }}` as the first of its labels that has a value, else an empty string. */
function template(source, labels) {
  const names = [...source.matchAll(/\.(\w+)/g)].map((found) => found[1]);
  const first = names.find((name) => (labels[name] ?? '') !== '');
  return first === undefined ? '' : labels[first];
}

const RESERVED = '__error__';
function compile(pipeline) {
  const steps = [];
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
        name: found[1],
        source: found[2],
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
      const tests = alternatives.map((text) => {
        const regex = /^(\w+)\s*(=~|!~)\s*("(?:[^"\\]|\\.)*")$/.exec(text.trim());
        if (regex) {
          const source = unquote(regex[3]);
          const pattern = new RegExp(`^(?:${source.replace(/^\(\?i\)/, '')})$`, source.startsWith('(?i)') ? 'i' : '');
          return (labels) => pattern.test(labels[regex[1]] ?? '') === (regex[2] === '=~');
        }
        const equal = /^(\w+)\s*=\s*("(?:[^"\\]|\\.)*")$/.exec(text.trim());
        if (equal) return (labels) => (labels[equal[1]] ?? '') === unquote(equal[2]);
        throw new Error(`the fake does not read this stage: ${text}`);
      });
      steps.push((labels) => {
        for (const test of tests) if (test(labels)) return true;
        return false;
      });
    }
  }
  return (labels, line) => steps.every((step) => step(labels, line));
}

const inRange = (at) => at >= from && at < to;
const streamsOf = (matchers) => state.streams.filter((stream) => matches(stream.labels, matchers));
const output = (text) => process.stdout.write(text);

if (command === 'labels') {
  const found = streamsOf([]).filter((stream) => stream.entries.some((entry) => inRange(entry.at)));
  const names = rest[0]
    ? found.map((stream) => stream.labels[rest[0]]).filter((value) => value !== undefined)
    : found.flatMap((stream) => Object.keys(stream.labels));
  for (const name of [...new Set(names)].sort()) output(`${name}\n`);
  process.exit(0);
}

if (command === 'series') {
  const matchers = parseSelector(rest[0] ?? '{}');
  const seen = new Set();
  for (const stream of streamsOf(matchers)) {
    if (!stream.entries.some((entry) => inRange(entry.at))) continue;
    const text = `{${Object.keys(stream.labels)
      .sort()
      .map((name) => `${name}=${JSON.stringify(stream.labels[name])}`)
      .join(', ')}}`;
    if (!seen.has(text)) output(`${text}\n`);
    seen.add(text);
  }
  process.exit(0);
}

if (command !== 'query' && command !== 'instant-query') die(`the fake does not run ${command}`);

const query = rest[0] ?? '';
const metric = /^\s*sum(?:\s+by\s*\(([^)]*)\))?\s*\(\s*count_over_time\s*\(/.exec(query);
if (command === 'instant-query' && !metric) die('the fake runs only metric instant queries');
const kind = metric ? 'counts' : 'samples';
if (state.only?.[kind] === 'hang' || state.behavior === 'hang') await hang();
if (state.reject) refused(state.reject);

const range = metric ? /\[(\d+[smhd])\]\s*\)\s*\)\s*$/.exec(query) : null;
const pipelineText = metric ? query.slice(metric[0].length, range.index) : query;
const matchers = parseSelector(pipelineText);
const afterSelector = pipelineText.slice(pipelineText.indexOf('}') + 1).replace(/^\s*\|/, '');
const keep = compile(stages(afterSelector));
const by = metric
  ? (metric[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  : [];
const rangeMs = metric ? durationMs(range[1]) : 0;

const found = [];
const readFrom = command === 'instant-query' ? Date.now() - rangeMs : from;
for (const stream of streamsOf(matchers)) {
  for (const entry of stream.entries) {
    if (command === 'instant-query' ? entry.at <= readFrom || entry.at > Date.now() : !inRange(entry.at)) continue;
    const labels = { ...stream.labels };
    if (keep(labels, entry.line)) found.push({ at: entry.at, line: entry.line, labels });
  }
}

const metricOf = (entry) =>
  Object.fromEntries(by.flatMap((name) => (entry.labels[name] ? [[name, entry.labels[name]]] : [])));

if (command === 'instant-query') {
  const counts = new Map();
  for (const entry of found) {
    const key = JSON.stringify(metricOf(entry));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const vector = [...counts].map(([key, count]) => ({
    metric: JSON.parse(key),
    value: [Date.now() / 1000, String(count)],
  }));
  output(JSON.stringify(vector, null, 2));
  process.exit(0);
}

if (metric) {
  const step = durationMs(flags.step) ?? 600_000;
  const series = new Map();
  for (let t = from; t <= to; t += step) {
    const counts = new Map();
    for (const entry of found) {
      if (entry.at <= t - rangeMs || entry.at > t) continue;
      const key = JSON.stringify(metricOf(entry));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      const values = series.get(key) ?? [];
      values.push([t / 1000, String(count)]);
      series.set(key, values);
    }
  }
  const matrix = [...series].map(([key, values]) => ({ metric: JSON.parse(key), values }));
  output(JSON.stringify(matrix, null, 2));
  process.exit(0);
}

const limit = Number(flags.limit ?? 30);
found.sort((a, b) => (flags.forward ? a.at - b.at : b.at - a.at));
for (const entry of found.slice(0, limit)) {
  const row = { line: entry.line, timestamp: new Date(entry.at).toISOString() };
  if (!flags['no-labels']) row.labels = entry.labels;
  output(`${JSON.stringify(row)}\n`);
}
