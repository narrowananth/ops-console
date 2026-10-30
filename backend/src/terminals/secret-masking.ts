const KEYWORD = /\b(password|pass|pwd|token|secret|key)\b(\s*[=:]\s*|\s+(?:is\s+)?)(\S+)/gi;
const URI_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@]+)(@)/gi;
const PLACEHOLDER_SOURCE = String.raw`\{\{secret:(\d+)\}\}`;
export const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE, 'g');
const SPLIT = new RegExp(`(${PLACEHOLDER_SOURCE})`);

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
      // `split` with two groups puts the placeholder at 1 mod 3 and its digits at 2 mod 3.
      if (index % 3 !== 0) return part;
      return part
        .replace(KEYWORD, (_all, word: string, joint: string, value: string) => `${word}${joint}${mark(value)}`)
        .replace(URI_PASSWORD, (_all, head: string, value: string, tail: string) => `${head}${mark(value)}${tail}`);
    })
    .join('');
}
