import { CONNECTOR_NAMES, type Connector, ConnectorId, HealthStatus } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { useConnectConnector, useDisconnectConnector } from '../lib/queries';
import { statusGlyph } from '../mcp/status';
import { IntegrationRow, rowAction } from './integration-row';

/** Shopify's Dev MCP has docs only: Connect registers it with no sign-in. */
const NO_SIGN_IN: ConnectorId[] = [ConnectorId.Shopify];

/** One Connector: Connect, Reconnect or Disconnect. Nothing else is set here. */
export function ConnectorDrawer({ connector, onBack }: { connector: Connector; onBack: () => void }) {
  const connect = useConnectConnector();
  const disconnect = useDisconnectConnector();
  const [confirming, setConfirming] = useState(false);
  const connected = connector.status !== HealthStatus.Off;
  const error = connect.error ?? disconnect.error;
  const status = statusGlyph[connector.status];

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-neutral-300 px-5 py-2.5">
        <Button className="px-2.5 py-1 text-xs" onClick={onBack}>
          ← Back
        </Button>
        <strong className="text-[13px]">{connector.name}</strong>
        <span className={`ml-auto font-mono text-xs ${status.className}`}>{status.glyph}</span>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        <div>
          <div className="text-[15px] font-extrabold">Connect {connector.name} to Ops Console</div>
          <div className="text-xs text-neutral-700">Reached through {connector.via}.</div>
        </div>
        <SignInStep connector={connector} pending={connect.isPending} onConnect={() => connect.mutate(connector.id)} />
        {error && (
          <div role="alert" className="text-xs text-accent-700">
            {error.message}
          </div>
        )}
      </div>
      {connected &&
        (confirming ? (
          <div className="flex flex-col gap-2.5 bg-accent-100 px-5 py-3.5">
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
          <div className="flex items-center gap-3 border-t-2 border-divider px-5 py-3.5">
            <div className="flex-1 text-xs text-neutral-700">Stops the console using {connector.name}.</div>
            <Button className="border-accent text-accent-700" onClick={() => setConfirming(true)}>
              Disconnect…
            </Button>
          </div>
        ))}
    </div>
  );
}

/** Connect hands off to the provider's own sign-in page; nothing is typed here. */
function SignInStep(props: { connector: Connector; pending: boolean; onConnect: () => void }) {
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
    <section aria-label="Sign in" className="flex flex-col gap-3 border border-neutral-300 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center border border-neutral-300 font-mono text-xs">
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
          disabled={props.pending || signIn !== null}
          onClick={props.onConnect}
        >
          {signIn ? 'Waiting…' : connected ? 'Reconnect' : 'Connect'}
        </Button>
      </div>
      {signIn && (signIn.code || signIn.url) && (
        <div className="flex flex-wrap items-center gap-3 bg-neutral-200 px-3 py-2.5">
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
              className="ml-auto inline-flex items-center gap-2 bg-accent px-3.5 py-2 font-heading text-sm font-extrabold text-bg hover:bg-accent-600"
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
export function ConnectorRow({ connector, onOpen }: { connector: Connector; onOpen: () => void }) {
  const status = connector.sign_in
    ? { glyph: '◌ signing in', className: 'text-neutral-700' }
    : connector.status === HealthStatus.Off
      ? { glyph: '○ not connected', className: 'text-neutral-700' }
      : statusGlyph[connector.status];
  const action =
    connector.status === HealthStatus.Off ? 'Connect' : connector.status === HealthStatus.Auth ? 'Sign in' : 'Manage';
  return (
    <IntegrationRow
      label={CONNECTOR_NAMES[connector.id]}
      name={connector.name}
      kind="Connector"
      line={`${connector.via}${connector.account_label ? ` · ${connector.account_label}` : ''}`}
      status={status}
      onOpen={onOpen}
      action={
        <button type="button" className={rowAction} onClick={onOpen}>
          {action}
        </button>
      }
    />
  );
}
