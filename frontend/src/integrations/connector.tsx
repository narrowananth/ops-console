import {
  CONNECTOR_NAMES,
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
  useConnectCloudWatch,
  useConnectConnector,
  useConnectConnectorWith,
  useConnectLogFolder,
  useConnectLoki,
  useConnectNewRelic,
  useDisconnectConnector,
} from '../lib/queries';
import { type StatusLook, statusGlyph } from '../mcp/status';
import { IntegrationRow, rowAction, rowActionAttention } from './integration-row';
import { LogFolderStep, savedFolder } from './log-folder';
import { LogGroupsStep, savedCloudWatch } from './log-groups';
import { LokiStep } from './loki-logs';
import { NewRelicStep } from './new-relic-logs';
import { SignInHandoff } from './sign-in-handoff';

/** What Connect does for a Connector that reads logs instead of signing in to a service. */
const NOT_SET_UP: Partial<Record<ConnectorId, string>> = {
  [ConnectorId.OtelLogs]: 'Not set up yet. Connect starts reading the Log folder.',
  [ConnectorId.CloudWatchLogs]: 'Not set up yet. Connect checks the AWS profile and starts reading the log groups.',
  [ConnectorId.LokiLogs]: 'Not set up yet. Connect checks Loki with the URL and the secret, and starts reading it.',
  [ConnectorId.NewRelicLogs]:
    'Not set up yet. Connect checks New Relic with the account ID and the key, and starts reading it.',
};

/** The Connectors with a typed secret instead of a sign-in, and what a refused one says. */
const REFUSED_SECRET: Partial<Record<ConnectorId, string>> = {
  [ConnectorId.LokiLogs]: 'Loki refused the secret. Reconnect with the right one.',
  [ConnectorId.NewRelicLogs]: 'New Relic refused the key. Reconnect with the right one.',
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
  // These have no sign-in: a refused secret is retyped.
  const refused = REFUSED_SECRET[connector.id];
  if (connector.status === HealthStatus.Auth && refused) return { ...statusGlyph[connector.status], tip: refused };
  return statusGlyph[connector.status];
}

/** Shopify's Dev MCP has docs only: Connect registers it with no sign-in. */
const NO_SIGN_IN: ConnectorId[] = [ConnectorId.Shopify];

/** One Connector: Connect, Reconnect or Disconnect. Nothing else is set here. */
export function ConnectorDrawer({ connector, onBack }: { connector: Connector; onBack: () => void }) {
  const connect = useConnectConnector();
  const connectWith = useConnectConnectorWith();
  const connectFolder = useConnectLogFolder();
  const connectCloudWatch = useConnectCloudWatch();
  const connectLoki = useConnectLoki();
  const connectNewRelic = useConnectNewRelic();
  const disconnect = useDisconnectConnector();
  const cancel = useCancelConnectorSignIn();
  const [confirming, setConfirming] = useState(false);
  const saved = typeof connector.config.server === 'string' ? connector.config.server : '';
  const [server, setServer] = useState(saved);
  const asksServer = connector.id === ConnectorId.Slashdocs;
  const asksFolder = connector.id === ConnectorId.OtelLogs;
  const asksGroups = connector.id === ConnectorId.CloudWatchLogs;
  const asksLoki = connector.id === ConnectorId.LokiLogs;
  const asksNewRelic = connector.id === ConnectorId.NewRelicLogs;
  const connected = connector.status !== HealthStatus.Off;
  const error =
    connect.error ??
    connectWith.error ??
    connectFolder.error ??
    connectCloudWatch.error ??
    connectLoki.error ??
    connectNewRelic.error ??
    disconnect.error ??
    cancel.error;
  const onConnect = () =>
    asksServer && server.trim() !== saved
      ? connectWith.mutate({ id: connector.id, config: { server: server.trim() } })
      : connect.mutate(connector.id);
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
        {asksFolder ? (
          <LogFolderStep
            connector={connector}
            pending={connectFolder.isPending}
            onConnect={(folder) => connectFolder.mutate(folder)}
          />
        ) : asksGroups ? (
          <LogGroupsStep
            connector={connector}
            pending={connectCloudWatch.isPending}
            cancelling={cancel.isPending}
            onConnect={(body) => connectCloudWatch.mutate(body)}
            onCancel={() => cancel.mutate(connector.id)}
          />
        ) : asksLoki ? (
          <LokiStep
            connector={connector}
            pending={connectLoki.isPending}
            onConnect={(body, done) => connectLoki.mutate(body, { onSuccess: done })}
          />
        ) : asksNewRelic ? (
          <NewRelicStep
            connector={connector}
            pending={connectNewRelic.isPending}
            onConnect={(body, done) => connectNewRelic.mutate(body, { onSuccess: done })}
          />
        ) : (
          <SignInStep
            connector={connector}
            pending={connect.isPending || connectWith.isPending}
            cancelling={cancel.isPending}
            onConnect={onConnect}
            onCancel={() => cancel.mutate(connector.id)}
          />
        )}
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
              {asksFolder
                ? 'Stops the console reading the Log folder. The folder and its files stay as they are.'
                : asksGroups
                  ? 'Stops the console reading the log groups and removes the CloudWatch MCP Server. Your AWS profile and account stay as they are.'
                  : asksLoki
                    ? 'Stops the console reading Loki and removes the secret from the Keychain. Loki and its logs stay as they are.'
                    : asksNewRelic
                      ? 'Stops the console reading New Relic and removes the key from the Keychain. New Relic and its logs stay as they are.'
                      : isGoogleConnector(connector.id)
                        ? 'Stops the console using it and takes its access back at Google. Every Claude account loses it.'
                        : 'Signs out and stops Claude from using it. Monitor and tasks that rely on it pause. Your own terminal stays signed in to the CLI.'}
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
                asksFolder
                  ? 'Stop the console reading the Log folder. Asks first.'
                  : asksGroups
                    ? 'Stop the console reading the log groups. Asks first.'
                    : asksLoki
                      ? 'Stop the console reading Loki and remove its secret. Asks first.'
                      : asksNewRelic
                        ? 'Stop the console reading New Relic and remove its key. Asks first.'
                        : `Sign out of ${connector.name} and stop the console using it. Asks first.`
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

/** Connect hands off to the provider's own sign-in page; nothing is typed here. */
function SignInStep(props: {
  connector: Connector;
  pending: boolean;
  cancelling: boolean;
  onConnect: () => void;
  onCancel: () => void;
}) {
  const { connector } = props;
  const signIn = connector.sign_in;
  const connected = connector.status === HealthStatus.Ok;
  const noSignIn = NO_SIGN_IN.includes(connector.id);
  const viaGoogle = isGoogleConnector(connector.id);
  const detail = signIn
    ? 'Finish in the browser tab that opened. This updates on its own.'
    : connected && connector.login
      ? `Signed in as ${connector.login}${connector.account_label && connector.account_label !== connector.login ? ` · ${connector.account_label}` : ''}.`
      : connected && connector.account_label
        ? `Signed in to ${connector.account_label}.`
        : noSignIn
          ? 'Adds its MCP server. No sign-in needed.'
          : viaGoogle
            ? 'Opens Google in your browser. Pick the Google account to use; every Claude account uses it.'
            : `Opens ${connector.name}'s sign-in page in your browser. Nothing to fill in here.`;
  return (
    <section
      aria-label="Sign in"
      className="flex flex-col gap-3 rounded-lg border border-line bg-card px-4 py-3.5 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-6.5 shrink-0 items-center justify-center rounded-full bg-neutral-200 font-mono text-xs font-semibold">
          1
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">
            {noSignIn ? `Add ${connector.name}` : `Sign in to ${connector.name}`}
          </div>
          <div className="text-xs text-neutral-700">{detail}</div>
          {connector.status_detail && !signIn && (
            <div role="alert" className="text-xs text-accent-700">
              {connector.status_detail}
            </div>
          )}
        </div>
        <Button
          variant={connected ? 'secondary' : 'primary'}
          className="shrink-0"
          title={
            signIn
              ? 'Finish signing in, in the browser tab that opened'
              : connected
                ? `Sign in to ${connector.name} again, for another account or a sign-in that lapsed`
                : undefined
          }
          disabled={props.pending || signIn !== null}
          onClick={props.onConnect}
        >
          {signIn ? 'Waiting…' : connected ? 'Reconnect' : 'Connect'}
        </Button>
        {signIn && (
          <Button
            className="shrink-0"
            title="Stop waiting for this sign-in. Connect starts it again."
            disabled={props.cancelling}
            onClick={props.onCancel}
          >
            Cancel
          </Button>
        )}
      </div>
      {signIn && <SignInHandoff signIn={signIn} label={viaGoogle ? 'Google' : connector.name} />}
    </section>
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
  // A typed secret has no sign-in: a refused one is retyped under Reconnect.
  const retypes = connector.id in REFUSED_SECRET;
  const action =
    connector.status === HealthStatus.Off
      ? 'Connect'
      : connector.status === HealthStatus.Auth && !retypes
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
