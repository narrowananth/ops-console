import path from 'node:path';
import { isConsolePort } from '../browser/addresses';
import { output } from './command';

/** A listening TCP socket that accepts loopback connections, with the process behind it. `folder` is empty when unknown. */
export type ListeningServer = { port: number; pid: number; process: string; folder: string };

export const LOCAL_SERVER_SCANNER = Symbol('LOCAL_SERVER_SCANNER');

export interface LocalServerScanner {
  scan(): Promise<ListeningServer[]>;
}

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

/** Reads listening sockets with `lsof`, each process's folder and its full name with one more call each. */
export class LsofScanner implements LocalServerScanner {
  async scan(): Promise<ListeningServer[]> {
    const listeners = parseListeners(await output('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']));
    const byPort = new Map<number, (typeof listeners)[number]>();
    for (const listener of listeners) {
      if (!isConsolePort(listener.port) && !byPort.has(listener.port)) {
        byPort.set(listener.port, listener);
      }
    }
    if (byPort.size === 0) return [];
    const pids = [...new Set([...byPort.values()].map((listener) => listener.pid))].join(',');
    const [cwdText, nameText] = await Promise.all([
      output('lsof', ['-a', '-p', pids, '-d', 'cwd', '-Fn']),
      output('ps', ['-o', 'pid=,comm=', '-p', pids]),
    ]);
    const cwds = parseCwds(cwdText);
    const names = new Map<number, string>();
    for (const line of nameText.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (match?.[1] && match[2]) names.set(Number(match[1]), path.basename(match[2]));
    }
    return [...byPort.entries()].map(([port, listener]) => ({
      port,
      pid: listener.pid,
      process: names.get(listener.pid) ?? listener.command,
      folder: cwds.get(listener.pid) ?? '',
    }));
  }
}
