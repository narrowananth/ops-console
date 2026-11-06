import {
  AccessLevel,
  CheckTarget,
  type Connection,
  ConnectionType,
  HealthArea,
  type HealthItem,
  HealthStatus,
  isFailing,
} from '@ops-console/shared';
import { useQueryClient } from '@tanstack/react-query';
import { BrandIcon, CONNECTION_BRAND } from '../components/ui/brand-icon';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import {
  FailingPill,
  HealthBanner,
  HealthLine,
  HealthStrip,
  isRecovered,
  RecoveredPill,
  rowDomId,
  useAreaHealth,
} from '../health/health-parts';
import { queryKeys, useCheckConnection, useConnections } from '../lib/queries';
import { useAddress } from '../lib/remember';
import { ascending } from '../lib/sort';
import { statusGlyph } from '../mcp/status';
import { ConnectionForm } from './connection-form';
import { ACCESS_TIPS, hostOf, PROD_TIP, TYPE_BLURBS, TYPE_LABELS } from './fields';

type View = { kind: 'list' } | { kind: 'pick' } | { kind: 'new'; type: ConnectionType } | { kind: 'edit'; id: string };

function parseView(value: string | null): View {
  if (value === null) return { kind: 'list' };
  if (value === 'new') return { kind: 'pick' };
  if (value.startsWith('new:')) {
    const type = value.slice('new:'.length) as ConnectionType;
    return Object.values(ConnectionType).includes(type) ? { kind: 'new', type } : { kind: 'pick' };
  }
  return { kind: 'edit', id: value };
}

const ACCESS_LABEL: Record<AccessLevel, string> = {
  [AccessLevel.None]: 'Claude: off',
  [AccessLevel.Read]: 'Claude: read-only',
  [AccessLevel.Write]: 'Claude: read / write',
};

function Row({
  connection,
  health,
  onOpen,
}: {
  connection: Connection;
  health: HealthItem | undefined;
  onOpen: () => void;
}) {
  const client = useQueryClient();
  const retry = useCheckConnection();
  const failing = health !== undefined && isFailing(health.status);
  const status = statusGlyph[connection.status];
  const detail = failing ? (health.detail ?? connection.status_detail) : null;
  const failed = detail ?? (connection.status === HealthStatus.Fail ? connection.status_detail : null);
  return (
    <li
      aria-label={connection.name}
      id={health ? rowDomId(health) : undefined}
      tabIndex={-1}
      className={`rounded-lg outline-none transition-colors ${
        failing ? 'bg-accent-100/50 shadow-[inset_0_0_0_1px_var(--color-accent-200)]' : ''
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_minmax(120px,auto)_130px] items-center gap-3 rounded-lg border-0 bg-transparent px-3.5 py-2.5 text-left text-text transition-colors hover:bg-neutral-200/70"
      >
        <BrandIcon brand={CONNECTION_BRAND[connection.type]} />
        <span className="min-w-0">
          <span className="flex items-center gap-2 font-mono text-[13px] font-semibold">
            {connection.name}
            {connection.is_prod && (
              <span
                title={PROD_TIP}
                className="rounded-full bg-accent-100 px-2 py-px font-sans text-xs font-semibold text-accent-700"
              >
                PROD
              </span>
            )}
            {health && !failing && isRecovered(health) && <RecoveredPill />}
          </span>
          <span className={`block truncate font-mono text-xs ${failed ? 'text-accent-700' : 'text-neutral-700'}`}>
            {failed ? failed : `${TYPE_LABELS[connection.type]} · ${hostOf(connection.config)}`}
          </span>
        </span>
        {failing ? (
          <FailingPill since={health.failing_since} />
        ) : (
          <span title={status.tip} className={`font-mono text-xs ${status.className}`}>
            {status.glyph}
          </span>
        )}
        <span title={ACCESS_TIPS[connection.access]} className="text-right text-xs text-neutral-700">
          {ACCESS_LABEL[connection.access]}
        </span>
      </button>
      {health && (
        <div className="pr-3.5 pb-2.5 pl-14.5">
          <HealthLine item={health}>
            {failing && (
              <button
                type="button"
                disabled={retry.isPending}
                onClick={() =>
                  retry.mutate(connection.id, {
                    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.healthWatch }),
                  })
                }
                className="cursor-pointer rounded-md border border-divider bg-card px-2.5 py-0.75 text-xs font-semibold text-text shadow-sm hover:bg-neutral-200 disabled:cursor-default disabled:opacity-50"
              >
                {retry.isPending ? 'Retrying…' : 'Retry'}
              </button>
            )}
            {failing && health.status === HealthStatus.Auth && (
              <button
                type="button"
                onClick={onOpen}
                className="cursor-pointer rounded-md border border-accent/45 bg-accent-100 px-2.5 py-0.75 text-xs font-semibold text-accent-700 shadow-sm hover:bg-accent-200"
              >
                Edit credentials
              </button>
            )}
            {retry.isError && (
              <span role="alert" className="text-accent-700">
                {retry.error.message}
              </span>
            )}
          </HealthLine>
        </div>
      )}
    </li>
  );
}

export function DevToolsTab() {
  const connections = useConnections();
  // What is open lives in the address: `connection=new` to pick a type, `new:<type>`, or a Connection's id.
  const [address, setAddress] = useAddress('connection');
  const view = parseView(address.connection);
  const setView = (next: View) =>
    setAddress({
      connection:
        next.kind === 'list' ? null : next.kind === 'pick' ? 'new' : next.kind === 'new' ? `new:${next.type}` : next.id,
    });
  const list = () => setView({ kind: 'list' });
  const { items } = useAreaHealth(HealthArea.Connections);

  if (connections.isPending) return <Empty>Loading connections…</Empty>;
  if (connections.isError) return <Empty>Could not read connections: {connections.error.message}</Empty>;
  const { data } = connections.data;

  if (view.kind === 'pick') {
    return (
      <div>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <Button className="px-2.5 py-1 text-xs" onClick={list}>
            ← Back
          </Button>
          <div>
            <strong className="block text-[13px]">Add a connection</strong>
            <span className="text-xs text-neutral-700">Pick the kind of database</span>
          </div>
        </div>
        <ul
          aria-label="Connection types"
          className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 p-5"
        >
          {ascending(Object.values(ConnectionType), (type) => TYPE_LABELS[type]).map((type) => (
            <li key={type}>
              <button
                type="button"
                onClick={() => setView({ kind: 'new', type })}
                className="group flex w-full cursor-pointer items-center gap-3.5 rounded-xl border border-line bg-bg px-4 py-3.5 text-left text-text transition-all hover:-translate-y-px hover:border-accent-300 hover:bg-card hover:shadow-md"
              >
                <BrandIcon brand={CONNECTION_BRAND[type]} size="lg" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{TYPE_LABELS[type]}</span>
                  <span className="block text-xs text-neutral-700">{TYPE_BLURBS[type]}</span>
                </span>
                <span aria-hidden className="text-neutral-500 transition-colors group-hover:text-accent">
                  →
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (view.kind === 'new') return <ConnectionForm type={view.type} onDone={list} onCancel={list} />;
  if (view.kind === 'edit') {
    const connection = data.find((item) => item.id === view.id);
    if (connection)
      return <ConnectionForm type={connection.type} connection={connection} onDone={list} onCancel={list} />;
  }

  return (
    <div>
      <div className="flex items-center gap-2.5 border-b border-divider px-5 py-3 text-xs text-neutral-700">
        <span className="flex-1">Databases Claude can reach through MCP servers</span>
        <Button variant="primary" className="px-2.5 py-1 text-xs" onClick={() => setView({ kind: 'pick' })}>
          + Add connection
        </Button>
      </div>
      <HealthStrip area={HealthArea.Connections} />
      <HealthBanner area={HealthArea.Connections} />
      {data.length === 0 ? (
        <Empty>No connections yet. Ask the Setup agent, or pick a type.</Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-1.5">
          {ascending(data, (connection) => connection.name).map((connection) => (
            <Row
              key={connection.id}
              connection={connection}
              health={items.find((item) => item.target === CheckTarget.Connection && item.id === connection.id)}
              onOpen={() => setView({ kind: 'edit', id: connection.id })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
