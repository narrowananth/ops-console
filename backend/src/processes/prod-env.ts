import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ENV_FILE = /^\.env(\..+)?$/;
const MAX_BYTES = 1_000_000;
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** The host names a Connection's own fields hold: its `host`, or the host of a URL in any field. Secrets are not here. */
function hostsOf(config: Record<string, unknown>): string[] {
  const hosts = new Set<string>();
  for (const value of Object.values(config)) {
    if (typeof value !== 'string' || value.length < 4 || /\s/.test(value)) continue;
    let host = value;
    try {
      if (value.includes('://')) host = new URL(value).hostname;
    } catch {
      continue;
    }
    host = host.toLowerCase();
    if (host.includes('.') && !LOCAL.has(host)) hosts.add(host);
  }
  return [...hosts];
}

const texts = new Map<string, { stamp: string; text: string }>();
const MAX_FOLDERS = 64;

/** The lower-cased text of a folder's `.env` files; read again only when one changed. */
async function envText(folder: string): Promise<string> {
  const files = (await readdir(folder)).filter((entry) => ENV_FILE.test(entry)).sort();
  const infos = await Promise.all(files.map((name) => stat(path.join(folder, name))));
  const stamp = files.map((name, i) => `${name}:${infos[i]?.mtimeMs}:${infos[i]?.size}`).join('|');
  const known = texts.get(folder);
  if (known?.stamp === stamp) return known.text;
  let text = '';
  for (const [i, name] of files.entries()) {
    if ((infos[i]?.size ?? 0) <= MAX_BYTES)
      text += `${(await readFile(path.join(folder, name), 'utf8')).toLowerCase()}\n`;
  }
  texts.delete(folder);
  texts.set(folder, { stamp, text });
  if (texts.size > MAX_FOLDERS) texts.delete(texts.keys().next().value ?? '');
  return text;
}

/**
 * The PROD Connections whose host appears in the `.env` files of a folder. A process runs with that file, so it may
 * reach those databases; the console cannot tell what the process does with them, only that the file names them.
 */
export async function prodConnectionsNamedIn(
  folder: string,
  prod: readonly { name: string; config: string }[],
): Promise<string[]> {
  if (prod.length === 0) return [];
  let text: string;
  try {
    text = await envText(folder);
  } catch {
    return [];
  }
  if (!text.trim()) return [];
  return prod
    .filter((connection) => {
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(connection.config) as Record<string, unknown>;
      } catch {}
      return hostsOf(config).some((host) => text.includes(host));
    })
    .map((connection) => connection.name)
    .sort((a, b) => a.localeCompare(b));
}
