import { HealthStatus, type McpServer, McpTransport } from '@ops-console/shared';
import { useState } from 'react';
import { useUi } from '../app/ui-store';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import {
  useAuthenticateMcpServer,
  useMcpServers,
  useReconnectMcpServer,
  useRemoveMcpServer,
  useUpdateMcpServer,
} from '../lib/queries';
import { McpForm } from './mcp-form';
import { statusGlyph } from './status';

type View = { kind: 'list' } | { kind: 'detail'; name: string } | { kind: 'form'; name: string | null };

const mono = 'font-mono';

function RowAction({ server, onManage }: { server: McpServer; onManage: () => void }) {
  const authenticate = useAuthenticateMcpServer();
  const reconnect = useReconnectMcpServer();
  const small = 'min-w-26 justify-start px-2.5 py-0.75 text-xs';
  if (!server.registered) {
    return server.transport === McpTransport.Stdio ? (
      <Button className={small} onClick={onManage}>
        Add again
      </Button>
    ) : (
      <Button className={small} disabled={authenticate.isPending} onClick={() => authenticate.mutate(server.name)}>
        Authenticate
      </Button>
    );
  }
  if (server.status === HealthStatus.Auth) {
    return (
      <Button className={small} disabled={authenticate.isPending} onClick={() => authenticate.mutate(server.name)}>
        Authenticate
      </Button>
    );
  }
  if (server.status === HealthStatus.Fail) {
    return (
      <Button className={small} disabled={reconnect.isPending} onClick={() => reconnect.mutate(server.name)}>
        Reconnect
      </Button>
    );
  }
  return (
    <Button className={small} onClick={onManage}>
      Manage
    </Button>
  );
}

function ServerRow({ server, onOpen }: { server: McpServer; onOpen: () => void }) {
  const status = statusGlyph[server.status];
  const failed = server.status === HealthStatus.Fail && server.status_detail;
  return (
    <li
      aria-label={server.name}
      className="flex items-center gap-3 border-b border-neutral-300 px-5 py-2.5 hover:bg-neutral-200"
    >
      <button
        type="button"
        onClick={onOpen}
        className="grid min-w-0 flex-1 cursor-pointer grid-cols-[minmax(0,1fr)_120px_64px] items-center gap-3 border-0 bg-transparent p-0 text-left text-text"
      >
        <span className="min-w-0">
          <span className={`${mono} block text-[13px] font-semibold`}>{server.name}</span>
          <span className={`${mono} block truncate text-[11px] ${failed ? 'text-accent-700' : 'text-neutral-700'}`}>
            {failed ? server.status_detail : `${server.scope} · ${server.target}`}
          </span>
        </span>
        <span className={`${mono} text-xs ${status.className}`}>{server.registered ? status.glyph : '◐ removed'}</span>
        <span className={`${mono} text-[11px] text-neutral-700`}>
          {server.tool_count > 0 ? `${server.tool_count} tools` : ''}
        </span>
      </button>
      <RowAction server={server} onManage={onOpen} />
    </li>
  );
}

function Detail({ server, onBack, onEdit }: { server: McpServer; onBack: () => void; onEdit: () => void }) {
  const reconnect = useReconnectMcpServer();
  const update = useUpdateMcpServer();
  const remove = useRemoveMcpServer();
  const [confirming, setConfirming] = useState(false);
  const error = reconnect.error ?? update.error ?? remove.error;
  const rows: [string, string][] = [
    ['Name', server.name],
    ['Scope', server.scope],
    ['Transport', server.transport],
    [server.transport === McpTransport.Stdio ? 'Command' : 'URL', server.target],
    ['Config file', server.config_file || 'removed'],
    ['Auth', server.auth],
    ['Status', server.status_detail ? `${server.status} · ${server.status_detail}` : server.status],
    ...(server.env_keys.length > 0 ? [['Env vars', server.env_keys.join(', ')] as [string, string]] : []),
    ...(server.has_headers ? [['Headers', 'set (values are never shown)'] as [string, string]] : []),
  ];
  const section = 'flex items-center gap-3 border-b border-neutral-300 px-5 py-3.5';
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-neutral-300 px-5 py-2.5">
        <Button className="px-2.5 py-1 text-xs" onClick={onBack}>
          ← Back
        </Button>
        <strong className={`${mono} text-[13px]`}>{server.name}</strong>
      </div>
      <div className="border-b border-neutral-300 px-5 pt-3.5 pb-1.5 text-[11px] tracking-[0.08em] text-neutral-700 uppercase">
        Details
      </div>
      {rows.map(([key, value]) => (
        <div
          key={key}
          className="grid grid-cols-[130px_minmax(0,1fr)] gap-3 border-b border-neutral-300 px-5 py-2 text-[13px]"
        >
          <span className="text-neutral-700">{key}</span>
          <span className={`${mono} text-xs break-all`}>{value}</span>
        </div>
      ))}
      <div className="px-5 pt-3.5 pb-1.5 text-[11px] tracking-[0.08em] text-neutral-700 uppercase">Tools</div>
      <div className="flex flex-wrap gap-1.5 border-b-2 border-divider px-5 pb-4">
        {server.tools.map((tool) => (
          <span key={tool} className={`${mono} border border-divider px-2 py-0.5 text-[11px]`}>
            {tool}
          </span>
        ))}
        {server.tools.length === 0 && (
          <span className="text-xs text-neutral-700">Tools are listed once the server is connected.</span>
        )}
      </div>
      {server.registered && (
        <>
          <div className={section}>
            <div className="flex-1">
              <div className="font-extrabold">Reconnect</div>
              <div className="text-xs text-neutral-700">Checks the server again in every Claude account.</div>
            </div>
            <Button
              variant={server.status === HealthStatus.Fail ? 'primary' : 'secondary'}
              disabled={reconnect.isPending}
              onClick={() => reconnect.mutate(server.name)}
            >
              Reconnect
            </Button>
          </div>
          <div className={section}>
            <div className="flex-1">
              <div className="font-extrabold">{server.enabled ? 'Disconnect' : 'Enable'}</div>
              <div className="text-xs text-neutral-700">
                Stop using it in new Claude sessions. Config and login are kept.
              </div>
            </div>
            <Button
              variant={server.enabled ? 'secondary' : 'primary'}
              disabled={update.isPending}
              onClick={() => update.mutate({ name: server.name, body: { enabled: !server.enabled } })}
            >
              {server.enabled ? 'Disconnect' : 'Enable'}
            </Button>
          </div>
        </>
      )}
      <div className={section}>
        <div className="flex-1">
          <div className="font-extrabold">{server.registered ? 'Edit server' : 'Add again'}</div>
          <div className="text-xs text-neutral-700">Change the command, scope, env vars or headers.</div>
        </div>
        <Button onClick={onEdit}>{server.registered ? 'Edit…' : 'Add again…'}</Button>
      </div>
      {server.registered &&
        (confirming ? (
          <div className="flex flex-col gap-2.5 bg-accent-100 px-5 py-3.5">
            <div className="font-extrabold text-accent-900">Remove {server.name}?</div>
            <div className="text-xs text-accent-900">
              Runs <span className={mono}>{`claude mcp remove "${server.name}" -s ${server.scope}`}</span>. Every Claude
              account loses access until it is authenticated again. The server stays in the MCP servers list.
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={remove.isPending}
                onClick={() => remove.mutate(server.name, { onSuccess: onBack })}
              >
                Remove
              </Button>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className={section}>
            <div className="flex-1">
              <div className="font-extrabold text-accent-700">Remove server</div>
              <div className="text-xs text-neutral-700">
                Signs out and clears its credentials. It stays in this list so you can authenticate it again.
              </div>
            </div>
            <Button className="border-accent text-accent-700" onClick={() => setConfirming(true)}>
              Remove…
            </Button>
          </div>
        ))}
      {error && (
        <div role="alert" className="px-5 py-2 text-xs text-accent-700">
          {error.message}
        </div>
      )}
    </div>
  );
}

export function McpTab() {
  const { openSettings } = useUi();
  const servers = useMcpServers();
  const [view, setView] = useState<View>({ kind: 'list' });
  const list = () => setView({ kind: 'list' });

  if (servers.isPending) return <Empty>Checking MCP servers…</Empty>;
  if (servers.isError) return <Empty>Could not read MCP servers: {servers.error.message}</Empty>;
  const { data, meta } = servers.data;
  const open = view.kind === 'list' ? undefined : data.find((server) => server.name === view.name);

  if (view.kind === 'form') {
    return (
      <McpForm
        key={view.name ?? 'new'}
        server={open}
        onDone={(name) => setView({ kind: 'detail', name })}
        onCancel={() => (open ? setView({ kind: 'detail', name: open.name }) : list())}
      />
    );
  }
  if (view.kind === 'detail' && open) {
    return <Detail server={open} onBack={list} onEdit={() => setView({ kind: 'form', name: open.name })} />;
  }

  return (
    <div>
      <div className="flex items-center gap-2.5 border-b border-divider px-5 py-3.5 text-xs text-neutral-700">
        <span className="flex-1">Registered in every Claude account · user and local scope</span>
        <Button variant="primary" className="px-2.5 py-1 text-xs" onClick={() => setView({ kind: 'form', name: null })}>
          + Add server
        </Button>
      </div>
      {data.length === 0 ? (
        <Empty>No MCP servers yet</Empty>
      ) : (
        <ul className="m-0 list-none p-0">
          {data.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              onOpen={() => setView({ kind: 'detail', name: server.name })}
            />
          ))}
        </ul>
      )}
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
