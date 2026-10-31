import type { ConnectorId } from '@ops-console/shared';
import { useState } from 'react';
import { useUi } from '../app/ui-store';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { useConnectors, useMcpServers } from '../lib/queries';
import { SetupAgentLink } from '../setup/setup-agent-link';
import { ConnectorDrawer, ConnectorRow } from './connector';
import { McpDetail, ServerRow } from './mcp-server';

type Open = { kind: 'connector'; id: ConnectorId } | { kind: 'mcp'; name: string } | null;

/** Settings › Integrations: the Connectors, then every MCP Server no Connector stands for. */
export function IntegrationsTab() {
  const openSettings = useUi((state) => state.openSettings);
  const connectors = useConnectors();
  const servers = useMcpServers();
  const [open, setOpen] = useState<Open>(null);
  const back = () => setOpen(null);

  if (connectors.isPending || servers.isPending) return <Empty>Loading integrations…</Empty>;
  if (connectors.isError) return <Empty>Could not read Connectors: {connectors.error.message}</Empty>;
  if (servers.isError) return <Empty>Could not read MCP servers: {servers.error.message}</Empty>;

  const connectorList = connectors.data.data;
  const { data: serverList, meta } = servers.data;
  if (open?.kind === 'connector') {
    const connector = connectorList.find((item) => item.id === open.id);
    if (connector) return <ConnectorDrawer connector={connector} onBack={back} />;
  }
  if (open?.kind === 'mcp') {
    const server = serverList.find((item) => item.name === open.name);
    if (server) return <McpDetail server={server} onBack={back} />;
  }
  // A Connector's row stands for its server, connected or not.
  const shown = serverList.filter((server) => server.used_by === null);

  return (
    <div>
      <SetupAgentLink what="one" />
      <ul aria-label="Integrations" className="m-0 list-none p-0">
        {connectorList.map((connector) => (
          <ConnectorRow
            key={connector.id}
            connector={connector}
            onOpen={() => setOpen({ kind: 'connector', id: connector.id })}
          />
        ))}
        {shown.map((server) => (
          <ServerRow key={server.name} server={server} onOpen={() => setOpen({ kind: 'mcp', name: server.name })} />
        ))}
      </ul>
      <div className="flex items-center gap-2 px-5 py-3.5 text-xs text-neutral-700">
        {meta.connection_server_count > 0
          ? `${meta.connection_server_count} database servers are listed in Dev tools.`
          : 'Database servers are managed in Dev tools.'}
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => openSettings('dev')}>
          Open Dev tools →
        </Button>
      </div>
    </div>
  );
}
