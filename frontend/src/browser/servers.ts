import type { LocalServer, SessionProcess } from '@ops-console/shared';
import { ascending } from '../lib/sort';

/** A server with the tag the Local servers list shows beside it. */
export type ListedServer = { server: LocalServer; tag: string | null };

/**
 * This Session's servers first, tagged with the process that started them, or "this Session" when only the folder
 * matches; then the rest. Each group by port.
 */
export function listServers(servers: readonly LocalServer[], processes: readonly SessionProcess[]) {
  const named = new Map(processes.map((process) => [process.id, process.name]));
  const mine: ListedServer[] = [];
  const others: ListedServer[] = [];
  for (const server of ascending(servers, (one) => String(one.port))) {
    const process = server.process_id === null ? undefined : named.get(server.process_id);
    if (server.process_id !== null || server.session_id !== null) {
      mine.push({ server, tag: process ?? 'this Session' });
    } else others.push({ server, tag: null });
  }
  return { mine, others };
}

/** The port the Browser button shows when nothing is open: the first server that belongs to the Session. */
export function sessionPort(servers: readonly LocalServer[]): number | null {
  const first = ascending(
    servers.filter((server) => server.process_id !== null || server.session_id !== null),
    (server) => String(server.port),
  )[0];
  return first?.port ?? null;
}

/** A folder as the list shows it: the last three parts, with `…/` before them when there were more. */
export function shortFolder(folder: string): string {
  const parts = folder.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : folder;
}

export const serverAddress = (port: number): string => `http://localhost:${port}/`;
