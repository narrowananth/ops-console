import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import path from 'node:path';
import { AccessLevel } from '@ops-console/shared';

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
/** Files that show how to fill in an `.env`, not an operator's own. */
const TEMPLATE_FILE = /\.(example|sample|template|dist)$/;
const GIT_TIMEOUT_MS = 2000;

/** One file's lower-cased text, or null for a link, a pipe, a device, a directory, an oversize file or any error. */
function readEnvFile(file: string): string | null {
  let fd: number | undefined;
  try {
    // No link is followed and a pipe does not block the open; only a plain file is read.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, null);
      if (n === 0) break;
      read += n;
    }
    return buffer.toString('utf8', 0, read).toLowerCase();
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to release.
      }
    }
  }
}

/** Whether git tracks the file: repository content a pull request can change. Any failure reads as not tracked. */
function isTracked(folder: string, name: string): boolean {
  try {
    execFileSync('git', ['-C', folder, 'ls-files', '--error-unmatch', '--', name], {
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The lower-cased text of a folder's `.env` files; read again only when one changed. `own` keeps only the operator's own
 * local config (no template names, nothing git tracks), for the automatic pick. A link, a pipe, a device, a directory or a
 * file over 1 MB is skipped on its own and never stops the rest. Read synchronously: the runs that ask are small (a
 * folder listing, a few stats, files under 1 MB) and a run's set-up is not async here.
 */
function envText(folder: string, own: boolean): string {
  const files = readdirSync(folder)
    .filter((entry) => ENV_FILE.test(entry) && !(own && TEMPLATE_FILE.test(entry)))
    .sort();
  const stamp = files
    .map((name) => {
      try {
        const info = lstatSync(path.join(folder, name));
        return `${name}:${info.mtimeMs}:${info.size}`;
      } catch {
        return `${name}:gone`;
      }
    })
    .join('|');
  const key = `${own ? 'own' : 'any'}:${folder}`;
  const known = texts.get(key);
  if (known?.stamp === stamp) return known.text;
  let text = '';
  for (const name of files) {
    if (own && isTracked(folder, name)) continue;
    const content = readEnvFile(path.join(folder, name));
    if (content !== null) text += `${content}\n`;
  }
  texts.delete(key);
  texts.set(key, { stamp, text });
  if (texts.size > MAX_FOLDERS) texts.delete(texts.keys().next().value ?? '');
  return text;
}

/** The text of a folder's `.env` files, or '' when the folder cannot be read. */
function envTextOrEmpty(folder: string, own = false): string {
  try {
    return envText(folder, own);
  } catch {
    return '';
  }
}

function configOf(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Whether `token` stands alone in the text: not inside a longer name, address or number. Before it, none of `a-z 0-9 . _ -`;
 * after it, none of `a-z 0-9 -` and no `.` that goes on with a letter or digit (a full stop ending a sentence is fine).
 */
function tokenIn(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9._-])${escaped}(?![a-z0-9-])(?!\\.[a-z0-9])`).test(text);
}

const MIN_HOST = 5;

/** The host of a value that is a URL, else null. */
function urlHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * The names a Connection answers to: its `host` field, and the host of a URL in any string field. No other string,
 * such as a user or a database name with a dot in it. Lower case.
 */
function hostNamesOf(config: Record<string, unknown>): string[] {
  const hosts = new Set<string>();
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string') continue;
    const host = value.includes('://') ? urlHost(value) : key === 'host' ? value.trim().toLowerCase() : null;
    if (host) hosts.add(host);
  }
  return [...hosts];
}

/** The ports a Connection's config names: `port` and `http_port`, as numbers. */
function portsOf(config: Record<string, unknown>): string[] {
  return [config.port, config.http_port].filter((port) => typeof port === 'number').map(String);
}

/**
 * A host that is not this machine (5 characters or more, with a dot) stands alone in the text, or, for a Connection on
 * this machine, its port and its database name both do.
 */
function namedBy(text: string, config: Record<string, unknown>): boolean {
  const hosts = hostNamesOf(config);
  if (hosts.some((host) => host.length >= MIN_HOST && host.includes('.') && !LOCAL.has(host) && tokenIn(text, host))) {
    return true;
  }
  const database = typeof config.database === 'string' ? config.database.trim().toLowerCase() : '';
  const ports = portsOf(config);
  return (
    hosts.some((host) => LOCAL.has(host)) &&
    database !== '' &&
    ports.length > 0 &&
    tokenIn(text, database) &&
    ports.some((port) => tokenIn(text, port))
  );
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
  const text = envTextOrEmpty(folder);
  if (!text.trim()) return [];
  return prod
    .filter((connection) => hostsOf(configOf(connection.config)).some((host) => text.includes(host)))
    .map((connection) => connection.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The Connections with Access Level `read` that the operator's own `.env` files of a folder name (not what git tracks,
 * not templates), so a Session in that Repo may reach them (ADR 0002). Only the given rows come back: the file's text
 * goes nowhere. A folder with no readable `.env` names none.
 */
export function connectionsNamedIn<T extends { config: string; access: string }>(
  folder: string,
  connections: readonly T[],
): T[] {
  const readable = connections.filter((connection) => connection.access === AccessLevel.Read);
  if (readable.length === 0) return [];
  const text = envTextOrEmpty(folder, true);
  if (!text.trim()) return [];
  return readable.filter((connection) => namedBy(text, configOf(connection.config)));
}
