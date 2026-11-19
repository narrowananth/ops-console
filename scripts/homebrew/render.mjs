// Renders the Homebrew formula for one release:
//   node scripts/homebrew/render.mjs <version> <checksums.txt> > ops-console.rb
// checksums.txt is the release's, with a line for each darwin tarball.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const here = import.meta.dirname;

/** Indents the script to sit in the heredoc, which Ruby dedents again. */
const indent = (text) =>
  text
    .split('\n')
    .map((line) => (line === '' ? line : `      ${line}`))
    .join('\n');

export async function renderFormula({ version, sha256Arm64, sha256X64 }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version "${version}" is not a plain release version`);
  for (const sum of [sha256Arm64, sha256X64]) {
    if (!/^[0-9a-f]{64}$/.test(sum)) throw new Error(`sha256 "${sum}" is not 64 hex digits`);
  }
  const template = await readFile(path.join(here, 'ops-console.rb.tmpl'), 'utf8');
  const entry = (await readFile(path.join(here, 'entry.sh'), 'utf8')).replace(/\n$/, '');
  const values = { version, sha256Arm64, sha256X64 };
  return template
    .replaceAll(/\{\{(version|sha256Arm64|sha256X64)\}\}/g, (_, key) => values[key])
    .replace('{{entry}}', () => indent(entry));
}

/** The sha256 of a tarball, from a `checksums.txt` line `<sha256>  <file>`. */
export function checksumOf(checksums, file) {
  const line = checksums.split('\n').find((l) => l.trim().endsWith(` ${file}`));
  if (!line) throw new Error(`checksums.txt has no line for ${file}`);
  return line.trim().split(/\s+/)[0];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, checksumsFile] = process.argv.slice(2);
  const checksums = await readFile(checksumsFile, 'utf8');
  process.stdout.write(
    await renderFormula({
      version,
      sha256Arm64: checksumOf(checksums, 'ops-console-darwin-arm64.tar.gz'),
      sha256X64: checksumOf(checksums, 'ops-console-darwin-x64.tar.gz'),
    }),
  );
}
