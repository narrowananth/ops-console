import path from 'node:path';
import { isConsolePort } from '../browser/addresses';
import { output } from './command';
import { processTable } from './process-tree';

/** A listening TCP socket that accepts loopback connections, with the process behind it. `folder` is empty when unknown. */
export type ListeningServer = { port: number; pid: number; process: string; folder: string };

export const LOCAL_SERVER_SCANNER = Symbol('LOCAL_SERVER_SCANNER');

export interface LocalServerScanner {
  /** A reading no older than `maxAgeMs` may be reused; the default reads fresh. */
  scan(maxAgeMs?: number): Promise<ListeningServer[]>;
  /** Why the last scan could list nothing, such as a missing `lsof`; null when it could. */
  notice?(): string | null;
}

/** What the server list says on a machine with no `lsof`. */
export const LSOF_MISSING =
  'lsof is not installed, so the servers on this machine cannot be listed. Install it with your package manager (for example `sudo apt install lsof`).';

const LOOPBACK_HOSTS = new Set(['*', 'localhost', '[::1]', '[::]']);

/** `lsof -F` lines: `p<pid>`, `c<command>`, then `n<host>:<port>` per socket. */
function parseListeners(text: string): { pid: number; command: string; port: number }[] {
  const found: { pid: number; command: string; port: number }[] = [];
  let pid = 0;
  let command = '';
  for (const line of text.split('\n')) {
    const value = line.slice(1);
    if (line.startsWith('p')) pid = Number(value);
    else if (line.startsWith('c')) command = value;
    else if (line.startsWith('n')) {
      const split = value.lastIndexOf(':');
      const host = value.slice(0, split);
      const port = Number(value.slice(split + 1));
      if (split > 0 && Number.isInteger(port) && (LOOPBACK_HOSTS.has(host) || host.startsWith('127.'))) {
        found.push({ pid, command, port });
      }
    }
  }
  return found;
}

/** `p<pid>` then `n<path>` for each process asked about. */
function parseCwds(text: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** Reads listening sockets with `lsof` and each process's folder with one more call; names come from the shared `ps`. */
export class LsofScanner implements LocalServerScanner {
  private missing = false;

  notice(): string | null {
    return this.missing ? LSOF_MISSING : null;
  }

  private last: { at: number; result: Promise<ListeningServer[]> } | null = null;

  scan(maxAgeMs = 0): Promise<ListeningServer[]> {
    if (this.last && Date.now() - this.last.at <= maxAgeMs) return this.last.result;
    const result = this.read(maxAgeMs);
    const mine = { at: Date.now(), result };
    this.last = mine;
    result.catch(() => {
      if (this.last === mine) this.last = null;
    });
    return result;
  }

  private async read(maxAgeMs: number): Promise<ListeningServer[]> {
    let listening: string;
    try {
      listening = await output('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { missing: 'throw' });
      this.missing = false;
    } catch (error) {
      // A machine with no `lsof` lists no servers, as on a minimal Linux install; nothing else depends on it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.missing = true;
      return [];
    }
    const listeners = parseListeners(listening);
    const byPort = new Map<number, (typeof listeners)[number]>();
    for (const listener of listeners) {
      if (!isConsolePort(listener.port) && !byPort.has(listener.port)) {
        byPort.set(listener.port, listener);
      }
    }
    if (byPort.size === 0) return [];
    const pids = [...new Set([...byPort.values()].map((listener) => listener.pid))].join(',');
    const [cwdText, table] = await Promise.all([
      output('lsof', ['-a', '-p', pids, '-d', 'cwd', '-Fn']),
      processTable(maxAgeMs),
    ]);
    const cwds = parseCwds(cwdText);
    const names = new Map(table.map((entry) => [entry.pid, path.basename(entry.command)]));
    return [...byPort.entries()].map(([port, listener]) => ({
      port,
      pid: listener.pid,
      process: names.get(listener.pid) || listener.command,
      folder: cwds.get(listener.pid) ?? '',
    }));
  }
}
