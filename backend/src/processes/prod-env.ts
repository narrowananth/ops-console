import { readdirSync, readFileSync, statSync } from 'node:fs';
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

/**
 * The PROD Connections whose host appears in the `.env` files of a folder. A process runs with that file, so it may
 * reach those databases; the console cannot tell what the process does with them, only that the file names them.
 */
export function prodConnectionsNamedIn(folder: string, prod: readonly { name: string; config: string }[]): string[] {
  if (prod.length === 0) return [];
  let text = '';
  try {
    for (const entry of readdirSync(folder)) {
      if (!ENV_FILE.test(entry)) continue;
      const file = path.join(folder, entry);
      if (statSync(file).size <= MAX_BYTES) text += `${readFileSync(file, 'utf8').toLowerCase()}\n`;
    }
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
