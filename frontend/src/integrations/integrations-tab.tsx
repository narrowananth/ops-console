import type { ConnectorId } from '@ops-console/shared';
import { useState } from 'react';
import { PageColumn } from '../app/page';
import { Empty } from '../components/ui/empty';
import { useConnectors, useMcpServers } from '../lib/queries';
import { ConnectorDrawer, ConnectorRow } from './connector';
import { McpDetail, ServerRow } from './mcp-server';

type Open = { kind: 'connector'; id: ConnectorId } | { kind: 'mcp'; name: string } | null;

/** Integrations: the Connectors, then every MCP Server no Connector stands for; the picked one opens beside the list. */
export function IntegrationsTab() {
  const connectors = useConnectors();
  const servers = useMcpServers();
  const [open, setOpen] = useState<Open>(null);
  const back = () => setOpen(null);

  if (connectors.isPending || servers.isPending) return <Empty>Loading integrations…</Empty>;
  if (connectors.isError) return <Empty>Could not read Connectors: {connectors.error.message}</Empty>;
  if (servers.isError) return <Empty>Could not read MCP servers: {servers.error.message}</Empty>;

  const connectorList = connectors.data.data;
  const { data: serverList } = servers.data;
  const connector = open?.kind === 'connector' ? connectorList.find((item) => item.id === open.id) : undefined;
  const server = open?.kind === 'mcp' ? serverList.find((item) => item.name === open.name) : undefined;
  // A Connector's row stands for its server, connected or not.
  const shown = serverList.filter((item) => item.used_by === null);

  return (
    <>
      <div className="min-w-0 flex-1 overflow-auto">
        <PageColumn wide>
          <div className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
            <ul aria-label="Integrations" className="m-0 flex list-none flex-col gap-0.5 p-1.5">
              {connectorList.map((item) => (
                <ConnectorRow
                  key={item.id}
                  connector={item}
                  selected={connector?.id === item.id}
                  onOpen={() => setOpen({ kind: 'connector', id: item.id })}
                />
              ))}
              {shown.map((item) => (
                <ServerRow
                  key={item.name}
                  server={item}
                  selected={server?.name === item.name}
                  onOpen={() => setOpen({ kind: 'mcp', name: item.name })}
                />
              ))}
            </ul>
          </div>
        </PageColumn>
      </div>
      {(connector || server) && (
        <aside aria-label="Integration" className="w-105 flex-none overflow-auto border-l border-line bg-card">
          {connector && <ConnectorDrawer key={connector.id} connector={connector} onBack={back} />}
          {server && <McpDetail key={server.name} server={server} onBack={back} />}
        </aside>
      )}
    </>
  );
}
