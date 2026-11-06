import { CheckTarget, type ConnectorId, HealthArea, type HealthItem } from '@ops-console/shared';
import { PageColumn } from '../app/page';
import { Empty } from '../components/ui/empty';
import { HealthBanner, HealthStrip, useAreaHealth } from '../health/health-parts';
import { useConnectors, useMcpServers } from '../lib/queries';
import { useAddress } from '../lib/remember';
import { ascending } from '../lib/sort';
import { ConnectorAction, ConnectorDrawer, ConnectorRow } from './connector';
import { McpDetail, RowAction, ServerRow } from './mcp-server';

type Open = { kind: 'connector'; id: ConnectorId } | { kind: 'mcp'; name: string } | null;

function parseOpen(value: string | null): Open {
  if (value?.startsWith('connector:'))
    return { kind: 'connector', id: value.slice('connector:'.length) as ConnectorId };
  if (value?.startsWith('mcp:')) return { kind: 'mcp', name: value.slice('mcp:'.length) };
  return null;
}

/** Integrations: the Connectors, then every MCP Server no Connector stands for; the picked one opens beside the list. */
export function IntegrationsTab() {
  const connectors = useConnectors();
  const servers = useMcpServers();
  // The open Connector or MCP Server lives in the address: `connector:<id>` or `mcp:<name>`.
  const [address, setAddress] = useAddress('open');
  const open = parseOpen(address.open);
  const setOpen = (next: Open) =>
    setAddress({
      open: next === null ? null : next.kind === 'connector' ? `connector:${next.id}` : `mcp:${next.name}`,
    });
  const back = () => setOpen(null);
  const { items } = useAreaHealth(HealthArea.Integrations);
  const healthOf = (target: CheckTarget, key: string) =>
    items.find((item) => item.target === target && (target === CheckTarget.McpServer ? item.name : item.id) === key);

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
            <HealthStrip area={HealthArea.Integrations} />
            <HealthBanner
              area={HealthArea.Integrations}
              action={(item: HealthItem) => {
                const own =
                  item.target === CheckTarget.Connector
                    ? connectorList.find((one) => one.id === item.id)
                    : serverList.find((one) => one.name === item.name);
                if (!own) return null;
                return 'via' in own ? (
                  <ConnectorAction connector={own} onOpen={() => setOpen({ kind: 'connector', id: own.id })} />
                ) : (
                  <RowAction server={own} onManage={() => setOpen({ kind: 'mcp', name: own.name })} />
                );
              }}
            />
            <ul aria-label="Integrations" className="m-0 flex list-none flex-col gap-0.5 p-1.5">
              {ascending(connectorList, (item) => item.name).map((item) => (
                <ConnectorRow
                  key={item.id}
                  connector={item}
                  health={healthOf(CheckTarget.Connector, item.id)}
                  selected={connector?.id === item.id}
                  onOpen={() => setOpen({ kind: 'connector', id: item.id })}
                />
              ))}
              {ascending(shown, (item) => item.name).map((item) => (
                <ServerRow
                  key={item.name}
                  server={item}
                  health={healthOf(CheckTarget.McpServer, item.name)}
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
