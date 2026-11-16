import type { LocalServer, SessionProcess } from '@ops-console/shared';
import { Button } from '../components/ui/button';
import { type ListedServer, listServers, serverAddress, shortFolder } from './servers';

function Row({ listed, onOpen }: { listed: ListedServer; onOpen: (address: string) => void }) {
  const { server, tag } = listed;
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-line bg-bg px-3 py-2">
      <span aria-hidden className={`size-2 flex-none rounded-full ${tag === null ? 'bg-neutral-400' : 'bg-ok'}`} />
      <span className="flex-none font-mono text-[13px] font-semibold">:{server.port}</span>
      <span className="min-w-0 flex-none truncate text-[13px]">{server.process}</span>
      {tag !== null && (
        <span className="flex-none rounded-full bg-diff-add px-2 font-mono text-[10px] font-semibold text-ok">
          {tag}
        </span>
      )}
      <span title={server.folder} className="ml-auto min-w-0 truncate font-mono text-[11px] text-neutral-600">
        {shortFolder(server.folder)}
      </span>
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
 * What a blank tab shows: the servers listening on a loopback port, this Session's first. A click opens one in the tab.
 */
export function LocalServers({
  servers,
  processes,
  error,
  onOpen,
}: {
  /** `undefined` while the first read goes on. */
  servers: LocalServer[] | undefined;
  processes: SessionProcess[];
  error: string | null;
  onOpen: (address: string) => void;
}) {
  const { mine, others } = listServers(servers ?? [], processes);
  return (
    <div className="flex flex-col gap-2.5 px-6 py-5">
      {error !== null ? (
        <p role="alert" className="m-0 text-xs text-accent-700">
          Could not read the local servers: {error}
        </p>
      ) : servers === undefined ? (
        <p className="m-0 text-xs text-neutral-700">Looking for local servers…</p>
      ) : servers.length === 0 ? (
        <p className="m-0 text-[13px] text-neutral-700">
          No server is listening on this Mac. Run a script from Terminals, or type an address above.
        </p>
      ) : (
        <>
          {mine.length > 0 && (
            <>
              <h4 className="m-0 text-xs font-semibold tracking-[0.06em] text-neutral-600 uppercase">Local servers</h4>
              <ul aria-label="Local servers" className="m-0 flex list-none flex-col gap-2 p-0">
                {mine.map((listed) => (
                  <Row key={`${listed.server.port}-${listed.server.folder}`} listed={listed} onOpen={onOpen} />
                ))}
              </ul>
            </>
          )}
          {others.length > 0 && (
            <>
              <h4 className="m-0 mt-2 text-xs font-semibold tracking-[0.06em] text-neutral-600 uppercase">
                {mine.length > 0 ? 'Other local servers' : 'Local servers'}
              </h4>
              <ul aria-label="Other local servers" className="m-0 flex list-none flex-col gap-2 p-0">
                {others.map((listed) => (
                  <Row key={`${listed.server.port}-${listed.server.folder}`} listed={listed} onOpen={onOpen} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <p className="m-0 text-xs text-neutral-700">
        Loopback only. Other links open in your browser. The console's own ports are not listed.
      </p>
    </div>
  );
}
