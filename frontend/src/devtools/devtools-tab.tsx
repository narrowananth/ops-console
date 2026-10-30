import { AccessLevel, type Connection, ConnectionType, HealthStatus } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { useConnections, useStartSetupTerminal } from '../lib/queries';
import { statusGlyph } from '../mcp/status';
import { ConnectionForm } from './connection-form';
import { hostOf, TYPE_LABELS } from './fields';
import { SetupTerminal } from './setup-terminal';

type View = { kind: 'list' } | { kind: 'pick' } | { kind: 'new'; type: ConnectionType } | { kind: 'edit'; id: string };

const ACCESS_LABEL: Record<AccessLevel, string> = {
  [AccessLevel.None]: 'Claude: off',
  [AccessLevel.Read]: 'Claude: read-only',
  [AccessLevel.Write]: 'Claude: read / write',
};

function Row({ connection, onOpen }: { connection: Connection; onOpen: () => void }) {
  const status = statusGlyph[connection.status];
  const failed = connection.status === HealthStatus.Fail && connection.status_detail;
  return (
    <li aria-label={connection.name} className="border-b border-neutral-300">
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_120px_auto] items-center gap-3 border-0 bg-transparent px-5 py-2.5 text-left text-text hover:bg-neutral-200"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2 font-mono text-[13px] font-semibold">
            {connection.name}
            {connection.is_prod && (
              <span className="border-[1.5px] border-accent px-1.5 py-px font-sans text-[10px] font-extrabold text-accent-700">
                PROD
              </span>
            )}
          </span>
          <span className={`block truncate font-mono text-[11px] ${failed ? 'text-accent-700' : 'text-neutral-700'}`}>
            {failed ? connection.status_detail : `${TYPE_LABELS[connection.type]} · ${hostOf(connection.config)}`}
          </span>
        </span>
        <span className={`font-mono text-xs ${status.className}`}>{status.glyph}</span>
        <span className="text-xs text-neutral-700">{ACCESS_LABEL[connection.access]}</span>
      </button>
    </li>
  );
}

export function DevToolsTab() {
  const connections = useConnections();
  const start = useStartSetupTerminal();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [terminal, setTerminal] = useState<string | null>(null);
  const list = () => setView({ kind: 'list' });

  if (connections.isPending) return <Empty>Loading connections…</Empty>;
  if (connections.isError) return <Empty>Could not read connections: {connections.error.message}</Empty>;
  const { data } = connections.data;

  if (view.kind === 'pick') {
    return (
      <div>
        <div className="flex items-center gap-2 border-b border-neutral-300 px-5 py-2.5">
          <Button className="px-2.5 py-1 text-xs" onClick={list}>
            ← Back
          </Button>
          <strong className="text-[13px]">Pick a type</strong>
        </div>
        <div className="grid grid-cols-2 gap-2.5 px-5 py-4">
          {Object.values(ConnectionType).map((type) => (
            <Button key={type} className="justify-start" onClick={() => setView({ kind: 'new', type })}>
              {TYPE_LABELS[type]}
            </Button>
          ))}
        </div>
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
      {terminal ? (
        <SetupTerminal terminalId={terminal} onClose={() => setTerminal(null)} />
      ) : (
        <div className="flex items-center gap-3 border-b-2 border-divider px-5 py-3.5">
          <div className="flex-1">
            <div className="font-extrabold">Add with Claude</div>
            <div className="text-xs text-neutral-700">Tell Claude what to connect. Passwords never reach its chat.</div>
          </div>
          <Button
            variant="primary"
            disabled={start.isPending}
            onClick={() => start.mutate(undefined, { onSuccess: setTerminal })}
          >
            Open setup terminal
          </Button>
        </div>
      )}
      {start.error && (
        <div role="alert" className="px-5 py-2 text-xs text-accent-700">
          {start.error.message}
        </div>
      )}
      <div className="flex items-center gap-2.5 border-b border-divider px-5 py-3 text-xs text-neutral-700">
        <span className="flex-1">Databases Claude can reach through MCP servers</span>
        <Button variant="primary" className="px-2.5 py-1 text-xs" onClick={() => setView({ kind: 'pick' })}>
          + Add connection
        </Button>
      </div>
      {data.length === 0 ? (
        <Empty>No connections yet. Add one with Claude above, or pick a type.</Empty>
      ) : (
        <ul className="m-0 list-none p-0">
          {data.map((connection) => (
            <Row
              key={connection.id}
              connection={connection}
              onOpen={() => setView({ kind: 'edit', id: connection.id })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
