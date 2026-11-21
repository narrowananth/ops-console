import { type ConnectBody, type Connector, ConnectorId, HealthStatus, isGoogleConnector } from '@ops-console/shared';
import type { ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { SignInHandoff } from './sign-in-handoff';

/** Shopify's Dev MCP has docs only: Connect registers it with no sign-in. */
const NO_SIGN_IN: ConnectorId[] = [ConnectorId.Shopify];

/** The Connectors that read logs. A signed-out one is signed in again with Reconnect. */
export const LOG_SOURCES: ConnectorId[] = [
  ConnectorId.CloudWatchLogs,
  ConnectorId.LokiLogs,
  ConnectorId.NewRelicLogs,
  ConnectorId.OtelLogs,
];

/** What a log pane gets from the drawer: Connect with the pane's choices, and Cancel while a sign-in waits. */
export type ConnectPane = {
  connector: Connector;
  pending: boolean;
  cancelling: boolean;
  onConnect: (body: ConnectBody) => void;
  onCancel: () => void;
};

/** The card that holds a pane's choices, above the step that Connect belongs to. */
export function ChoiceCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-3 rounded-lg border border-line bg-card px-4 py-3.5 shadow-sm"
    >
      {children}
    </section>
  );
}

/** Connect hands off to the provider's own sign-in page; any choice it needs sits in a card above it. */
export function SignInStep(props: {
  connector: Connector;
  pending: boolean;
  cancelling: boolean;
  onConnect: () => void;
  onCancel: () => void;
  /** The region's name; "Sign in" unless the step is not a sign-in. */
  label?: string;
  title?: string;
  /** Replaces the line under the title while no sign-in waits. */
  detail?: string;
  /** Why Connect cannot be pressed yet. */
  blocked?: string;
}) {
  const { connector } = props;
  const signIn = connector.sign_in;
  const connected = connector.status === HealthStatus.Ok;
  const checking = connector.status === HealthStatus.Checking;
  const noSignIn = NO_SIGN_IN.includes(connector.id);
  const viaGoogle = isGoogleConnector(connector.id);
  const again = connected || (LOG_SOURCES.includes(connector.id) && connector.status !== HealthStatus.Off);
  const detail = signIn
    ? 'Finish in the browser tab that opened. This updates on its own.'
    : (props.detail ??
      (connected && connector.login
        ? `Signed in as ${connector.login}${connector.account_label && connector.account_label !== connector.login ? ` · ${connector.account_label}` : ''}.`
        : connected && connector.account_label
          ? `Signed in to ${connector.account_label}.`
          : noSignIn
            ? 'Adds its MCP server. No sign-in needed.'
            : viaGoogle
              ? 'Opens Google in your browser. Pick the Google account to use; every Claude account uses it.'
              : `Opens ${connector.name}'s sign-in page in your browser. Nothing to fill in here.`));
  return (
    <section
      aria-label={props.label ?? 'Sign in'}
      className="flex flex-col gap-3 rounded-lg border border-line bg-card px-4 py-3.5 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-6.5 shrink-0 items-center justify-center rounded-full bg-neutral-200 font-mono text-xs font-semibold">
          1
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">
            {props.title ?? (noSignIn ? `Add ${connector.name}` : `Sign in to ${connector.name}`)}
          </div>
          <div className="text-xs text-neutral-700">{detail}</div>
          {connector.status_detail && !signIn && (
            <div role="alert" className="text-xs text-accent-700">
              {connector.status_detail}
            </div>
          )}
        </div>
        <Button
          variant={again ? 'secondary' : 'primary'}
          className="shrink-0"
          title={
            signIn
              ? 'Finish signing in, in the browser tab that opened'
              : (props.blocked ??
                (again
                  ? `Sign in to ${connector.name} again, for another account or a sign-in that lapsed`
                  : undefined))
          }
          disabled={props.pending || checking || signIn !== null || props.blocked !== undefined}
          onClick={props.onConnect}
        >
          {signIn ? 'Waiting…' : again ? 'Reconnect' : 'Connect'}
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
