import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ErrorCode } from '@ops-console/shared';
import { ApiError, validationFailed } from '../common/errors';
import { maskText } from './secret-masking';

const run = promisify(execFile);

const READ_BYTES = 512 * 1024;
/** A JSON file read whole to pick one part from it, as `~/.claude.json` grows to megabytes. */
const PICK_BYTES = 32 * 1024 * 1024;
const FETCH_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const DIR_ENTRIES = 500;
const KEYCHAIN_ITEMS = 200;
/** Long enough for the operator to answer macOS's allow prompt. */
const KEYCHAIN_READ_MS = 120_000;

type Keep = (value: string) => number;

/** `~/x` and a relative path both start at the home folder. */
export function localPath(given: string): string {
  const home = os.homedir();
  if (given === '~') return home;
  if (given.startsWith('~/')) return path.join(home, given.slice(2));
  return path.resolve(home, given);
}

function fileError(error: unknown, where: string): ApiError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new ApiError(404, ErrorCode.NotFound, `nothing at ${where}`);
  if (code === 'EACCES' || code === 'EPERM') return validationFailed(`no permission to read ${where}`);
  if (code === 'EISDIR') return validationFailed(`${where} is a folder; list it instead`);
  if (code === 'ENOTDIR') return validationFailed(`${where} is a file; read it instead`);
  return validationFailed(`could not read ${where}: ${code ?? String(error)}`);
}

/**
 * A text file, its secrets swapped for placeholders. A binary file is refused. With `pick`, the part of a JSON file
 * those keys lead to, pretty-printed so each field sits on its own line for the masking.
 */
export async function readLocalFile(given: string, keep: Keep, pick?: string[]) {
  const file = localPath(given);
  try {
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, pick ? PICK_BYTES : READ_BYTES));
      await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.includes(0)) throw validationFailed(`${file} is a binary file`);
      let whole = buffer.toString('utf8');
      if (pick) {
        if (size > PICK_BYTES) throw validationFailed(`${file} is over 32 MB`);
        whole = picked(whole, pick, file);
      }
      const text = maskText(whole.slice(0, READ_BYTES), keep, path.basename(file));
      return { path: file, size, truncated: whole.length > READ_BYTES, text };
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw error instanceof ApiError ? error : fileError(error, file);
  }
}

function picked(text: string, keys: string[], file: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw validationFailed(`${file} is not JSON, so pick does not apply`);
  }
  for (const key of keys) {
    if (value === null || typeof value !== 'object' || !(key in value)) {
      throw new ApiError(404, ErrorCode.NotFound, `no ${keys.join(' › ')} in ${file}`);
    }
    value = (value as Record<string, unknown>)[key];
  }
  return JSON.stringify(value, null, 2);
}

/** A folder's entries: name, kind and a file's size. */
export async function listLocalDir(given: string) {
  const dir = localPath(given);
  try {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    const listed = await Promise.all(
      entries.slice(0, DIR_ENTRIES).map(async (entry) => {
        const kind = entry.isDirectory()
          ? 'folder'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'link'
              : 'other';
        const size = entry.isFile()
          ? await stat(path.join(dir, entry.name)).then(
              (s) => s.size,
              () => null,
            )
          : null;
        return { name: entry.name, kind, size };
      }),
    );
    return { path: dir, entries: listed, truncated: entries.length > DIR_ENTRIES };
  } catch (error) {
    throw fileError(error, dir);
  }
}

/** A page at an http or https URL, its secrets swapped for placeholders. */
export async function fetchUrl(given: string, keep: Keep) {
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw validationFailed(`invalid params: url ${given}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw validationFailed('only http and https URLs');
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  } catch (error) {
    throw new ApiError(502, ErrorCode.UpstreamFailed, `could not fetch ${url.origin}: ${(error as Error).message}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const body = bytes.subarray(0, FETCH_BYTES);
  if (body.includes(0)) throw validationFailed(`${url.href} is not text`);
  return {
    url: url.href,
    status: response.status,
    content_type: response.headers.get('content-type'),
    truncated: bytes.length > FETCH_BYTES,
    text: maskText(body.toString('utf8'), keep, path.basename(url.pathname)),
  };
}

export const LOCAL_KEYCHAIN = Symbol('LOCAL_KEYCHAIN');

export type KeychainItem = { kind: 'generic' | 'internet'; service: string; account: string; label: string };

/** The operator's login Keychain, every app's items, unlike the console's own `Keychain` (ADR 0004). */
export interface LocalKeychain {
  /** Items whose service, account or label holds `filter`: names only, never a secret. */
  items(filter: string): Promise<KeychainItem[]>;
  /** One item's secret, or null when there is none. macOS asks the operator to allow it. */
  read(item: Pick<KeychainItem, 'kind' | 'service' | 'account'>): Promise<string | null>;
}

/** `security`, the macOS Keychain command. */
export class SecurityCliKeychain implements LocalKeychain {
  async items(filter: string): Promise<KeychainItem[]> {
    this.check();
    const { stdout } = await run('security', ['dump-keychain'], { maxBuffer: 50 * 1024 * 1024 });
    const wanted = filter.toLowerCase();
    const items: KeychainItem[] = [];
    for (const block of stdout.split(/^keychain: /m)) {
      const kind = /^class: "genp"/m.test(block) ? 'generic' : /^class: "inet"/m.test(block) ? 'internet' : null;
      if (!kind) continue;
      const field = (name: string) => new RegExp(`"${name}"<blob>="((?:[^"\\\\]|\\\\.)*)"`).exec(block)?.[1] ?? '';
      const item = {
        kind,
        service: field(kind === 'generic' ? 'svce' : 'srvr'),
        account: field('acct'),
        label: field('labl') || field('0x00000007'),
      } as const;
      if (`${item.service} ${item.account} ${item.label}`.toLowerCase().includes(wanted)) items.push(item);
      if (items.length === KEYCHAIN_ITEMS) break;
    }
    return items;
  }

  async read(item: Pick<KeychainItem, 'kind' | 'service' | 'account'>): Promise<string | null> {
    this.check();
    const command = item.kind === 'internet' ? 'find-internet-password' : 'find-generic-password';
    const args = [command, '-s', item.service, ...(item.account ? ['-a', item.account] : []), '-w'];
    try {
      const { stdout } = await run('security', args, { timeout: KEYCHAIN_READ_MS });
      return stdout.replace(/\n$/, '');
    } catch (error) {
      // 44: no such item. 51 or 128: the operator denied it.
      const code = (error as { code?: number }).code;
      if (code === 44) return null;
      throw validationFailed(
        `the Keychain did not hand over ${item.service}: ${code === 51 || code === 128 ? 'denied' : 'failed'}`,
      );
    }
  }

  private check(): void {
    if (process.platform !== 'darwin') throw new ApiError(409, ErrorCode.InvalidState, 'the Keychain is macOS only');
  }
}
