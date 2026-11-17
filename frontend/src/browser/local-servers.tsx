import type { LocalServer, SessionProcess } from '@ops-console/shared';
import { Button } from '../components/ui/button';
import { type ListedServer, listServers, serverAddress, shortFolder } from './servers';

function Row({
  listed,
  onOpen,
  onStop,
}: {
  listed: ListedServer;
  onOpen: (address: string) => void;
  onStop: (port: number) => void;
}) {
  const { server, tag } = listed;
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-line bg-bg px-3 py-2">
      <span aria-hidden className="size-2 flex-none rounded-full bg-ok" />
      <span className="flex-none font-mono text-[13px] font-semibold">:{server.port}</span>
      <span className="min-w-0 flex-none truncate text-[13px]">{server.process}</span>
      <span className="flex-none rounded-full bg-diff-add px-2 font-mono text-[10px] font-semibold text-ok">{tag}</span>
      <span title={server.folder} className="ml-auto min-w-0 truncate font-mono text-[11px] text-neutral-600">
        {shortFolder(server.folder)}
      </span>
      {server.process_id === null && (
        <Button
          className="flex-none px-2.5 py-0.5 text-xs"
          title={`Stop the process on :${server.port}. No Terminals process owns it.`}
          onClick={() => onStop(server.port)}
        >
          Stop
        </Button>
      )}
      <Button
        className="flex-none px-2.5 py-0.5 text-xs"
        title={`Open localhost:${server.port} in this tab`}
        onClick={() => onOpen(serverAddress(server.port))}
      >
        Open
      </Button>
    </li>
  );
}

/**
 * What a blank tab shows: the servers this Session started or runs in its folders. A click opens one in the tab.
 */
export function LocalServers({
  servers,
  processes,
  error,
  onOpen,
  onStop,
}: {
  /** `undefined` while the first read goes on. */
  servers: LocalServer[] | undefined;
  processes: SessionProcess[];
  error: string | null;
  onOpen: (address: string) => void;
  onStop: (port: number) => void;
}) {
  const listed = listServers(servers ?? [], processes);
  return (
    <div className="flex flex-col gap-2.5 px-6 py-5">
      {error !== null ? (
        <p role="alert" className="m-0 text-xs text-accent-700">
          Could not read the local servers: {error}
        </p>
      ) : servers === undefined ? (
        <p className="m-0 text-xs text-neutral-700">Looking for local servers…</p>
      ) : listed.length === 0 ? (
        <p className="m-0 text-[13px] text-neutral-700">
          No server is running for this Session. Start one from Terminals and its page opens here, or type an address
          above.
        </p>
      ) : (
        <>
          <h4 className="m-0 text-xs font-semibold tracking-[0.06em] text-neutral-600 uppercase">Local servers</h4>
          <ul aria-label="Local servers" className="m-0 flex list-none flex-col gap-2 p-0">
            {listed.map((one) => (
              <Row key={`${one.server.port}-${one.server.folder}`} listed={one} onOpen={onOpen} onStop={onStop} />
            ))}
          </ul>
        </>
      )}
      <p className="m-0 text-xs text-neutral-700">
        This Session's servers on the loopback. Type any address above to open another page.
      </p>
    </div>
  );
}
