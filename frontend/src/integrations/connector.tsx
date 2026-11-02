import { CONNECTOR_NAMES, type Connector, ConnectorId, HealthStatus } from '@ops-console/shared';
import { useState } from 'react';
import { BrandIcon, CONNECTOR_BRAND } from '../components/ui/brand-icon';
import { Button } from '../components/ui/button';
import { useCancelConnectorSignIn, useConnectConnector, useDisconnectConnector } from '../lib/queries';
import { type StatusLook, statusGlyph } from '../mcp/status';
import { IntegrationRow, rowAction, rowActionAttention } from './integration-row';

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
      tip: 'Not set up yet. Connect signs you in and adds its MCP Server when it has one.',
    };
  return statusGlyph[connector.status];
}

/** Shopify's Dev MCP has docs only: Connect registers it with no sign-in. */
const NO_SIGN_IN: ConnectorId[] = [ConnectorId.Shopify];

/** One Connector: Connect, Reconnect or Disconnect. Nothing else is set here. */
export function ConnectorDrawer({ connector, onBack }: { connector: Connector; onBack: () => void }) {
  const connect = useConnectConnector();
  const disconnect = useDisconnectConnector();
  const cancel = useCancelConnectorSignIn();
  const [confirming, setConfirming] = useState(false);
  const connected = connector.status !== HealthStatus.Off;
  const error = connect.error ?? disconnect.error ?? cancel.error;
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
          <div className="text-[15px] font-extrabold">Connect {connector.name} to Ops Console</div>
          <div className="text-xs text-neutral-700">Reached through {connector.via}.</div>
        </div>
        <SignInStep
          connector={connector}
          pending={connect.isPending}
          cancelling={cancel.isPending}
          onConnect={() => connect.mutate(connector.id)}
          onCancel={() => cancel.mutate(connector.id)}
        />
        {error && (
          <div role="alert" className="text-xs text-accent-700">
            {error.message}
          </div>
        )}
      </div>
      {connected &&
        (confirming ? (
          <div className="mx-5 mb-4 flex flex-col gap-2.5 rounded-lg bg-accent-100 px-4 py-3.5">
            <div className="font-extrabold text-accent-900">Disconnect {connector.name}?</div>
            <div className="text-xs text-accent-900">
              Signs out and stops Claude from using it. Monitor and tasks that rely on it pause. Your own terminal stays
              signed in to the CLI.
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
              title={`Sign out of ${connector.name} and stop the console using it. Asks first.`}
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
  const detail = signIn
    ? 'Finish in the browser tab that opened. This updates on its own.'
    : connected && connector.login
      ? `Signed in as ${connector.login}${connector.account_label && connector.account_label !== connector.login ? ` · ${connector.account_label}` : ''}.`
      : connected && connector.account_label
        ? `Signed in to ${connector.account_label}.`
        : noSignIn
          ? 'Adds its MCP server. No sign-in needed.'
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
          <div className="text-[13px] font-extrabold">
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
      {signIn && (signIn.code || signIn.url) && (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-neutral-200 px-3.5 py-3">
          {signIn.code && (
            <div className="flex flex-col">
              <span className="text-[11px] text-neutral-700">Enter this code (already copied)</span>
              <span className="font-mono text-lg font-extrabold tracking-widest">{signIn.code}</span>
            </div>
          )}
          {signIn.url && (
            <a
              href={signIn.url}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 font-heading text-sm font-bold text-white no-underline shadow-sm hover:bg-accent-600 hover:text-white"
            >
              Open {connector.name} ↗
            </a>
          )}
        </div>
      )}
    </section>
  );
}

/** A Connector in the Integrations list. Off reads "not connected": a Connector is never disabled. */
export function ConnectorRow({
  connector,
  selected,
  onOpen,
}: {
  connector: Connector;
  selected: boolean;
  onOpen: () => void;
}) {
  const status = connectorStatus(connector);
  const action =
    connector.status === HealthStatus.Off
      ? 'Connect'
      : connector.status === HealthStatus.Auth
        ? 'Sign in'
        : connector.status === HealthStatus.Fail
          ? 'Reconnect'
          : 'Manage';
  const attention = connector.status === HealthStatus.Auth || connector.status === HealthStatus.Fail;
  return (
    <IntegrationRow
      label={CONNECTOR_NAMES[connector.id]}
      brand={CONNECTOR_BRAND[connector.id]}
      name={connector.name}
      kind="Connector"
      line={`${connector.via}${connector.account_label ? ` · ${connector.account_label}` : ''}`}
      status={status}
      selected={selected}
      onOpen={onOpen}
      action={
        <button type="button" className={attention ? rowActionAttention : rowAction} onClick={onOpen}>
          {action}
        </button>
      }
    />
  );
}
