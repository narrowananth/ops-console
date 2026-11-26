import {
  CONNECTOR_NAMES,
  type ConnectBody,
  type Connector,
  ConnectorId,
  type HealthItem,
  HealthStatus,
  isGoogleConnector,
} from '@ops-console/shared';
import { useState } from 'react';
import { BrandIcon, CONNECTOR_BRAND } from '../components/ui/brand-icon';
import { Button } from '../components/ui/button';
import {
  useCancelConnectorSignIn,
  useConnectConnector,
  useConnectConnectorWith,
  useDisconnectConnector,
} from '../lib/queries';
import { type StatusLook, statusGlyph } from '../mcp/status';
import { IntegrationRow, rowAction, rowActionAttention } from './integration-row';
import { LogFolderStep, savedFolder } from './log-folder';
import { CloudWatchStep, savedCloudWatch } from './log-groups';
import { LokiStep } from './loki-logs';
import { NewRelicStep } from './new-relic-logs';
import { LOG_SOURCES, SignInStep } from './sign-in-step';

/** What Connect does for a Connector that reads logs instead of signing in to a service. */
const NOT_SET_UP: Partial<Record<ConnectorId, string>> = {
  [ConnectorId.OtelLogs]: 'Not set up yet. Choose the Log folder, then Connect starts reading it.',
  [ConnectorId.CloudWatchLogs]:
    'Not set up yet. Connect signs the AWS profile in, in your browser, and starts reading the log groups.',
  [ConnectorId.LokiLogs]:
    'Not set up yet. Connect signs in to Grafana Cloud, in your browser, and starts reading Loki.',
  [ConnectorId.NewRelicLogs]: 'Not set up yet. Connect signs in to New Relic, in your browser, and starts reading it.',
};

/** The row and the pane read the same: signing in, not connected, or the check's status. */
function connectorStatus(connector: Connector): StatusLook {
  if (connector.sign_in)
    return {
      glyph: '◌ signing in',
      className: 'text-neutral-700',
      tip: 'Waiting for you to finish signing in, in the browser tab that opened.',
    };
  if (connector.status === HealthStatus.Off)
    return {
      glyph: '○ not connected',
      className: 'text-neutral-700',
      tip: NOT_SET_UP[connector.id] ?? 'Not set up yet. Connect signs you in and adds its MCP Server when it has one.',
    };
  return statusGlyph[connector.status];
}

/** What Disconnect says for a Connector that reads logs. */
const DISCONNECT: Partial<Record<ConnectorId, string>> = {
  [ConnectorId.OtelLogs]: 'Stops the console reading the Log folder. The folder and its files stay as they are.',
  [ConnectorId.CloudWatchLogs]:
    'Stops the console reading the log groups and removes the CloudWatch MCP Server. Your AWS profile and account stay as they are.',
  [ConnectorId.LokiLogs]:
    "Stops the console reading Loki, removes the Grafana MCP Server and the console's sign-in from the Keychain. Grafana Cloud and its logs stay as they are, and the data source you picked stays for the next Connect.",
  [ConnectorId.NewRelicLogs]:
    'Stops the console reading New Relic and removes the New Relic MCP Server. New Relic and its logs stay as they are, and the Region and account you picked stay for the next Connect.',
  [ConnectorId.Figma]:
    'Stops Sessions reading Figma and removes the Figma MCP Server. Your Figma account and files stay as they are.',
  [ConnectorId.Notion]:
    'Stops Sessions using Notion and removes the Notion MCP Server. Your Notion account and pages stay as they are.',
};

/** What Disconnect says for New Relic logs read with a User API key. */
const NEW_RELIC_KEY_DISCONNECT =
  'Stops the console reading New Relic and removes your User API key from the Keychain. New Relic and its logs stay as they are, and the Region and account you picked stay for the next Connect.';

/** What a pane says under its sign-in step, for a Connector that limits what Sessions do with the service. */
const NOTES: Partial<Record<ConnectorId, string>> = {
  [ConnectorId.Figma]:
    "Read only. Sessions can look at your designs and never change them. Figma's own limits apply: Dev and Full seats on a paid plan get 200 calls a day on Professional, View and Collab seats 20 a month, and Starter plans none.",
  [ConnectorId.Notion]:
    "Sessions can read your workspace. A change asks you first, a delete always asks, and Full access skips the first. Notion's own limits apply: 180 requests a minute, 600 on Business and Enterprise.",
};

const DISCONNECT_TITLE: Partial<Record<ConnectorId, string>> = {
  [ConnectorId.OtelLogs]: 'Stop the console reading the Log folder. Asks first.',
  [ConnectorId.CloudWatchLogs]: 'Stop the console reading the log groups. Asks first.',
  [ConnectorId.LokiLogs]: 'Stop the console reading Loki and remove its sign-in. Asks first.',
  [ConnectorId.NewRelicLogs]: 'Stop the console reading New Relic and remove its MCP Server. Asks first.',
  [ConnectorId.Figma]: 'Stop Sessions reading Figma and remove its MCP Server. Asks first.',
  [ConnectorId.Notion]: 'Stop Sessions using Notion and remove its MCP Server. Asks first.',
};

/** One Connector: Connect, Reconnect or Disconnect. Nothing else is set here. */
export function ConnectorDrawer({ connector, onBack }: { connector: Connector; onBack: () => void }) {
  const connect = useConnectConnector();
  const connectWith = useConnectConnectorWith();
  const disconnect = useDisconnectConnector();
  const cancel = useCancelConnectorSignIn();
  const [confirming, setConfirming] = useState(false);
  const saved = typeof connector.config.server === 'string' ? connector.config.server : '';
  const [server, setServer] = useState(saved);
  const asksServer = connector.id === ConnectorId.Slashdocs;
  const connected = connector.status !== HealthStatus.Off;
  const error = connect.error ?? connectWith.error ?? disconnect.error ?? cancel.error;
  const onConnect = () =>
    asksServer && server.trim() !== saved
      ? connectWith.mutate({ id: connector.id, config: { server: server.trim() } })
      : connect.mutate({ id: connector.id });
  const logPane = {
    connector,
    pending: connect.isPending,
    cancelling: cancel.isPending,
    onConnect: (body: ConnectBody) => connect.mutate({ id: connector.id, body }),
    onCancel: () => cancel.mutate(connector.id),
  };
  const status = connectorStatus(connector);

  return (
    <div>
      <div className="flex items-center gap-2.5 border-b border-line px-5 py-2.5">
        <BrandIcon brand={CONNECTOR_BRAND[connector.id]} size="sm" />
        <strong className="text-[13px]">{connector.name}</strong>
        <span title={status.tip} className={`ml-auto font-mono text-xs ${status.className}`}>
          {status.glyph}
        </span>
        <Button className="px-2.5 py-1 text-xs" onClick={onBack}>
          Close
        </Button>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        <div>
          <div className="text-[15px] font-semibold">Connect {connector.name} to Ops Console</div>
          <div className="text-xs text-neutral-700">Reached through {connector.via}.</div>
        </div>
        {asksServer && (
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-semibold">slashdocs server</span>
            <input
              value={server}
              onChange={(event) => setServer(event.target.value)}
              placeholder="slashdocs.example.com"
              disabled={connector.sign_in !== null}
              className="w-full border border-divider bg-card px-2 py-1.5 font-mono text-[13px] text-text"
            />
            <span className="text-neutral-700">Blank uses the server the slashdocs CLI already signed in to.</span>
          </label>
        )}
        {connector.id === ConnectorId.OtelLogs ? (
          <LogFolderStep {...logPane} />
        ) : connector.id === ConnectorId.CloudWatchLogs ? (
          <CloudWatchStep {...logPane} />
        ) : connector.id === ConnectorId.LokiLogs ? (
          <LokiStep {...logPane} />
        ) : connector.id === ConnectorId.NewRelicLogs ? (
          <NewRelicStep {...logPane} />
        ) : (
          <SignInStep
            connector={connector}
            pending={connect.isPending || connectWith.isPending}
            cancelling={cancel.isPending}
            onConnect={onConnect}
            onCancel={() => cancel.mutate(connector.id)}
          />
        )}
        {NOTES[connector.id] && <div className="text-xs text-neutral-700">{NOTES[connector.id]}</div>}
        {error && (
          <div role="alert" className="text-xs text-accent-700">
            {error.message}
          </div>
        )}
      </div>
      {connected &&
        (confirming ? (
          <div className="mx-5 mb-4 flex flex-col gap-2.5 rounded-lg bg-accent-100 px-4 py-3.5">
            <div className="font-semibold text-accent-900">Disconnect {connector.name}?</div>
            <div className="text-xs text-accent-900">
              {(connector.id === ConnectorId.NewRelicLogs && connector.config.route === 'key'
                ? NEW_RELIC_KEY_DISCONNECT
                : null) ??
                DISCONNECT[connector.id] ??
                (isGoogleConnector(connector.id)
                  ? 'Stops the console using it and takes its access back at Google. Every Claude account loses it.'
                  : 'Signs out and stops Claude from using it. Monitor and tasks that rely on it pause. Your own terminal stays signed in to the CLI.')}
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate(connector.id, { onSuccess: onBack })}
              >
                Disconnect
              </Button>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="mx-5 flex items-center gap-3 border-t border-line py-3.5">
            <div className="flex-1 text-xs text-neutral-700">Stops the console using {connector.name}.</div>
            <Button
              className="border-accent text-accent-700"
              title={
                (connector.id === ConnectorId.NewRelicLogs && connector.config.route === 'key'
                  ? 'Stop the console reading New Relic and remove its User API key. Asks first.'
                  : null) ??
                DISCONNECT_TITLE[connector.id] ??
                `Sign out of ${connector.name} and stop the console using it. Asks first.`
              }
              onClick={() => setConfirming(true)}
            >
              Disconnect…
            </Button>
          </div>
        ))}
    </div>
  );
}

const folderSuffix = (connector: Connector) => (savedFolder(connector) ? ` · ${savedFolder(connector)}` : '');

const profileSuffix = (connector: Connector) => {
  const { profile, region } = savedCloudWatch(connector);
  return [profile, region]
    .filter((part) => part !== '')
    .map((part) => ` · ${part}`)
    .join('');
};

/** What the row's second line adds to how the Connector is reached: the folder, the profile and region, the account. */
function lineSuffix(connector: Connector): string {
  if (connector.id === ConnectorId.OtelLogs) return folderSuffix(connector);
  if (connector.id === ConnectorId.CloudWatchLogs) return profileSuffix(connector);
  return connector.account_label ? ` · ${connector.account_label}` : '';
}

/** A Connector in the Integrations list. Off reads "not connected": a Connector is never disabled. */
export function ConnectorAction({ connector, onOpen }: { connector: Connector; onOpen: () => void }) {
  // A log source signs in again from the pane's Reconnect.
  const reconnects = LOG_SOURCES.includes(connector.id);
  const action =
    connector.status === HealthStatus.Off
      ? 'Connect'
      : connector.status === HealthStatus.Auth && !reconnects
        ? 'Sign in'
        : connector.status === HealthStatus.Auth || connector.status === HealthStatus.Fail
          ? 'Reconnect'
          : 'Manage';
  const attention = connector.status === HealthStatus.Auth || connector.status === HealthStatus.Fail;
  return (
    <button type="button" className={attention ? rowActionAttention : rowAction} onClick={onOpen}>
      {action}
    </button>
  );
}

export function ConnectorRow({
  connector,
  health,
  selected,
  onOpen,
}: {
  connector: Connector;
  health?: HealthItem;
  selected: boolean;
  onOpen: () => void;
}) {
  const status = connectorStatus(connector);
  return (
    <IntegrationRow
      label={CONNECTOR_NAMES[connector.id]}
      brand={CONNECTOR_BRAND[connector.id]}
      name={connector.name}
      kind="Connector"
      line={`${connector.via}${lineSuffix(connector)}`}
      status={status}
      health={health}
      selected={selected}
      onOpen={onOpen}
      action={<ConnectorAction connector={connector} onOpen={onOpen} />}
    />
  );
}
