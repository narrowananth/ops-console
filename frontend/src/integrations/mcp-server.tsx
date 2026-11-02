import { CONNECTOR_NAMES, type ConnectorId, HealthStatus, type McpServer, McpTransport } from '@ops-console/shared';
import { useState } from 'react';
import { BrandIcon, serverBrand } from '../components/ui/brand-icon';
import { Button } from '../components/ui/button';
import {
  useAuthenticateMcpServer,
  useReconnectMcpServer,
  useRemoveMcpServer,
  useUpdateMcpServer,
} from '../lib/queries';
import { ascending } from '../lib/sort';
import { type StatusLook, statusGlyph } from '../mcp/status';
import { IntegrationRow, rowAction, rowActionAttention } from './integration-row';

const mono = 'font-mono';

function RowAction({ server, onManage }: { server: McpServer; onManage: () => void }) {
  const authenticate = useAuthenticateMcpServer();
  const reconnect = useReconnectMcpServer();
  const signIn = (
    <button
      type="button"
      className={rowActionAttention}
      disabled={authenticate.isPending}
      onClick={() => authenticate.mutate(server.name)}
    >
      Sign in
    </button>
  );
  if (server.registered ? server.status === HealthStatus.Auth : server.transport !== McpTransport.Stdio) return signIn;
  if (server.registered && server.status === HealthStatus.Fail) {
    return (
      <button
        type="button"
        className={rowActionAttention}
        disabled={reconnect.isPending}
        onClick={() => reconnect.mutate(server.name)}
      >
        Reconnect
      </button>
    );
  }
  return (
    <button type="button" className={rowAction} onClick={onManage}>
      Manage
    </button>
  );
}

const REMOVED: StatusLook = {
  glyph: '◐ removed',
  className: 'text-accent-700',
  tip: 'No longer registered in Claude Code. The agent cannot use it until it is added again.',
};

/** What a Details row means, for the rows whose name leaves it open. */
const DETAIL_TIPS: Record<string, string> = {
  Scope:
    "Where Claude Code keeps it: user is every project on this machine, project lives in a Repo's .mcp.json file, local is this project only.",
  Transport: 'How Claude Code talks to it: stdio runs a command on this machine; http and sse call a URL.',
};

/** An MCP Server in the Integrations list. */
export function ServerRow({ server, selected, onOpen }: { server: McpServer; selected: boolean; onOpen: () => void }) {
  const failed = server.status === HealthStatus.Fail && server.status_detail;
  const tools = server.tool_count > 0 ? ` · ${server.tool_count} tools` : '';
  return (
    <IntegrationRow
      label={server.name}
      brand={serverBrand(server.name, server.target)}
      name={<span className={mono}>{server.name}</span>}
      kind="MCP"
      line={failed ? (server.status_detail ?? '') : `${server.scope} · ${server.target}${tools}`}
      alert={Boolean(failed)}
      selected={selected}
      status={server.registered ? statusGlyph[server.status] : REMOVED}
      onOpen={onOpen}
      action={<RowAction server={server} onManage={onOpen} />}
    />
  );
}

/** One MCP Server's details, tools, Reconnect, Disconnect and Remove. */
export function McpDetail({ server, onBack }: { server: McpServer; onBack: () => void }) {
  const reconnect = useReconnectMcpServer();
  const update = useUpdateMcpServer();
  const remove = useRemoveMcpServer();
  const [confirming, setConfirming] = useState(false);
  const error = reconnect.error ?? update.error ?? remove.error;
  const rows: [string, string][] = [
    ['Name', server.name],
    ...(server.used_by
      ? [['Signed in by', `${CONNECTOR_NAMES[server.used_by as ConnectorId]} Connector`] as [string, string]]
      : []),
    ['Scope', server.scope],
    ['Transport', server.transport],
    [server.transport === McpTransport.Stdio ? 'Command' : 'URL', server.target],
    ['Config file', server.config_file || 'removed'],
    ['Auth', server.auth],
    ['Status', server.status_detail ? `${server.status} · ${server.status_detail}` : server.status],
    ...(server.env_keys.length > 0 ? [['Env vars', server.env_keys.join(', ')] as [string, string]] : []),
    ...(server.has_headers ? [['Headers', 'set (values are never shown)'] as [string, string]] : []),
  ];
  const section = 'flex items-center gap-3 border-b border-line px-5 py-3.5';
  return (
    <div>
      <div className="flex items-center gap-2.5 border-b border-line px-5 py-2.5">
        <BrandIcon brand={serverBrand(server.name, server.target)} size="sm" />
        <strong className={`${mono} text-[13px]`}>{server.name}</strong>
        <Button className="ml-auto px-2.5 py-1 text-xs" onClick={onBack}>
          Close
        </Button>
      </div>
      <div className="border-b border-line px-5 pt-3.5 pb-1.5 text-[11px] tracking-[0.08em] text-neutral-700 uppercase">
        Details
      </div>
      {rows.map(([key, value]) => (
        <div
          key={key}
          className="grid grid-cols-[130px_minmax(0,1fr)] gap-3 border-b border-line px-5 py-2 text-[13px]"
        >
          <span title={DETAIL_TIPS[key]} className="text-neutral-700">
            {key}
          </span>
          <span className={`${mono} text-xs break-all`}>{value}</span>
        </div>
      ))}
      <div className="px-5 pt-3.5 pb-1.5 text-[11px] tracking-[0.08em] text-neutral-700 uppercase">Tools</div>
      <div className="flex flex-wrap gap-1.5 border-b border-line px-5 pb-4">
        {ascending(server.tools, (tool) => tool).map((tool) => (
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
      {server.registered &&
        (confirming ? (
          <div className="mx-5 mb-4 flex flex-col gap-2.5 rounded-lg bg-accent-100 px-4 py-3.5">
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
