const KEYWORD = /\b(password|pass|pwd|token|secret|key)\b(\s*[=:]\s*|\s+(?:is\s+)?)(\S+)/gi;
const URI_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@]+)(@)/gi;
const PLACEHOLDER_SOURCE = String.raw`\{\{secret:(\d+)\}\}`;
export const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE, 'g');
const SPLIT = new RegExp(`(${PLACEHOLDER_SOURCE})`);

const KEY_NAME = String.raw`[\w.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|private[_-]?key|credentials?|authorization|cookie)[\w.-]*`;
// `"password": "x"`, `PASSWORD='x'`, `token = "x y"`: a quoted value may hold spaces.
const QUOTED_FIELD = new RegExp(String.raw`(["']?)(${KEY_NAME})\1(\s*[=:]\s*)(["'])((?:(?!\4)[^\n])+)\4`, 'gi');
// `DB_PASSWORD=x`, `secret_key: x`.
const BARE_FIELD = new RegExp(String.raw`(["']?)(${KEY_NAME})\1([ \t]*[=:][ \t]*)(?!["'{[])([^\s"',;}\]#]+)`, 'gi');
const XML_FIELD = new RegExp(String.raw`<(${KEY_NAME})>([^<]+)</\1>`, 'gi');
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
// `host:port:database:user:password`; a `\:` inside a field is not a separator.
const PGPASS_LINE = /^((?:(?:[^:\\\n]|\\.)*:){4})(.+)$/gm;
const NOT_SECRET = /^(true|false|null|none|yes|no)$/i;
// `credentialModeJson`, `passwordFile`, `tokenUrl`, `AUTH_TOKEN_TYPE`: a setting about the secret, not the secret.
const SETTING_NAME = /(mode|type|kind|method|source|provider|file|path|name|url|length|expiry|expires)(json)?$/i;
const IS_PLACEHOLDER = new RegExp(`^${PLACEHOLDER_SOURCE}$`);

/**
 * Swaps the secrets in a file or a fetched page for `{{secret:<n>}}`: the value of a field whose name says password,
 * secret, token, API key or credential, in .env, JSON, YAML, TOML, INI or XML shape; the password of a URI; a private
 * key block; and the password of each `.pgpass` line. A field named for a setting about the secret, such as
 * `credentialModeJson` or `passwordFile`, keeps its value. A secret in a shape this does not know passes through.
 */
export function maskText(text: string, keep: (value: string) => number, fileName = ''): string {
  const mark = (value: string) =>
    IS_PLACEHOLDER.test(value) || NOT_SECRET.test(value) ? value : `{{secret:${keep(value)}}}`;
  let masked = text.replace(PRIVATE_KEY, (block) => mark(block));
  if (/^(\.pgpass|pgpass\.conf)$/.test(fileName)) {
    masked = masked.replace(PGPASS_LINE, (line: string, head: string, value: string) =>
      line.startsWith('#') ? line : `${head}${mark(value)}`,
    );
  }
  // Each step skips the placeholders already there: the `secret` in one would read as a field name.
  const steps: ((part: string) => string)[] = [
    (part) =>
      part.replace(QUOTED_FIELD, (all, q: string, key: string, joint: string, quote: string, value: string) =>
        SETTING_NAME.test(key) ? all : `${q}${key}${q}${joint}${quote}${mark(value)}${quote}`,
      ),
    (part) =>
      part.replace(BARE_FIELD, (all, q: string, key: string, joint: string, value: string) =>
        SETTING_NAME.test(key) ? all : `${q}${key}${q}${joint}${mark(value)}`,
      ),
    (part) =>
      part.replace(XML_FIELD, (all, key: string, value: string) =>
        SETTING_NAME.test(key) ? all : `<${key}>${mark(value)}</${key}>`,
      ),
    (part) =>
      part.replace(URI_PASSWORD, (_all, head: string, value: string, tail: string) => `${head}${mark(value)}${tail}`),
  ];
  return steps.reduce((current, step) => outsidePlaceholders(current, step), masked);
}

function outsidePlaceholders(text: string, change: (part: string) => string): string {
  // `split` with two groups puts the placeholder at 1 mod 3 and its digits, dropped, at 2 mod 3.
  return text
    .split(SPLIT)
    .map((part, index) => (index % 3 === 0 ? change(part) : index % 3 === 1 ? part : ''))
    .join('');
}

/**
 * Swaps the secrets in a line the operator typed for `{{secret:<n>}}`: the value after `password`, `pass`, `pwd`,
 * `token`, `secret` or `key`, and the password of a `user:password@` URI. `keep` stores a value and returns its number.
 * A placeholder already in the line is left alone. A password in a shape this does not know passes through
 * (spec 05, Not required).
 */
export function maskLine(line: string, keep: (value: string) => number): string {
  const mark = (value: string) => `{{secret:${keep(value)}}}`;
  return line
    .split(SPLIT)
    .map((part, index) => {
      // `split` with two groups puts the placeholder at 1 mod 3 and its digits, dropped, at 2 mod 3.
      if (index % 3 === 1) return part;
      if (index % 3 === 2) return '';
      return part
        .replace(KEYWORD, (_all, word: string, joint: string, value: string) => `${word}${joint}${mark(value)}`)
        .replace(URI_PASSWORD, (_all, head: string, value: string, tail: string) => `${head}${mark(value)}${tail}`);
    })
    .join('');
}
