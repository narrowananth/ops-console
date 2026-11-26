import { type LocalServer, type SessionProcess, TabOpener } from '@ops-console/shared';
import { ascending } from '../lib/sort';

/** A server with the tag the Local servers list shows beside it. */
export type ListedServer = { server: LocalServer; tag: string };

/** The Session's servers by port, each tagged with the process that started it, or "this Session" when only the folder matches. */
export function listServers(servers: readonly LocalServer[], processes: readonly SessionProcess[]): ListedServer[] {
  const named = new Map(processes.map((process) => [process.id, process.name]));
  return ascending(servers, (one) => String(one.port)).map((server) => ({
    server,
    tag: (server.process_id === null ? undefined : named.get(server.process_id)) ?? 'this Session',
  }));
}

/** The port the Browser button shows when nothing is open: the Session's first server. */
export function sessionPort(servers: readonly LocalServer[]): number | null {
  return ascending(servers, (server) => String(server.port))[0]?.port ?? null;
}

/**
 * The servers a Session process started since the view opened, not yet opened in a page: `before` holds the processes
 * that were already there, `opened` the ports a page was opened for. A process the agent started opens no page by
 * itself: the agent opens the one it wants seen, and a test run's server on a port of its own would only leave a tab
 * with a sign-in or a dead address.
 */
export function freshServers(
  servers: readonly LocalServer[],
  before: ReadonlySet<string>,
  opened: ReadonlySet<number>,
  processes: readonly Pick<SessionProcess, 'id' | 'started_by'>[],
): LocalServer[] {
  const byAgent = new Set(processes.filter((one) => one.started_by === TabOpener.Agent).map((one) => one.id));
  return servers.filter(
    (server) =>
      server.process_id !== null &&
      !before.has(server.process_id) &&
      !byAgent.has(server.process_id) &&
      !opened.has(server.port),
  );
}

/** A folder as the list shows it: the last three parts, with `…/` before them when there were more. */
export function shortFolder(folder: string): string {
  const parts = folder.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : folder;
}

export const serverAddress = (port: number): string => `http://localhost:${port}/`;
