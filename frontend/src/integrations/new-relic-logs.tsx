import { ConnectorId, HealthStatus, NEW_RELIC_REGIONS } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Segmented } from '../components/ui/segmented';
import { asksPick, PickStep } from './pick-step';
import { ChoiceCard, type ConnectPane, SignInStep } from './sign-in-step';

type Region = (typeof NEW_RELIC_REGIONS)[number];

/** The Region the Connector kept across a Disconnect; US until chosen. */
const savedRegion = (config: Record<string, unknown>): Region =>
  NEW_RELIC_REGIONS.find((region) => region === config.region) ?? 'US';

/**
 * The Region, then the sign-in through Claude Code, or under it a User API key for an organization whose administrator
 * has turned the MCP server off. A sign-in or key that can read several accounts asks for one after, and that pick
 * goes with the Region.
 */
export function NewRelicStep({ connector, pending, cancelling, onConnect, onCancel }: ConnectPane) {
  const [region, setRegion] = useState(savedRegion(connector.config));
  const choosing = asksPick(connector, ConnectorId.NewRelicLogs);
  const connected = connector.status === HealthStatus.Ok;
  const byKey = connector.config.route === 'key';
  const [keyOpen, setKeyOpen] = useState(false);
  const [key, setKey] = useState('');
  const waiting = connector.sign_in !== null;
  return (
    <>
      <ChoiceCard label="Region">
        <Segmented
          label="Region"
          hint="The data center the account lives in: US, EU or JP."
          value={region}
          onChange={setRegion}
          options={NEW_RELIC_REGIONS.map((value) => ({ value, label: value, disabled: connector.sign_in !== null }))}
        />
        <p className="m-0 text-xs text-neutral-700">
          Connect signs in to New Relic through Claude Code. macOS may ask for this Mac's login password once, so the
          console can read that sign-in.
        </p>
        <p className="m-0 text-xs text-neutral-700">
          If New Relic's page says your administrator has disabled access, ask a New Relic administrator to turn on New
          Relic MCP Server in Feature Control Manager. Nothing in the console can change that setting. A User API key
          below reads New Relic without that server.
        </p>
      </ChoiceCard>
      <SignInStep
        // The question has its own picker below: the step does not show it as a failure.
        connector={choosing ? { ...connector, status_detail: null } : connector}
        pending={pending}
        cancelling={cancelling}
        onConnect={() => onConnect({ region })}
        onCancel={onCancel}
        detail={
          connected && connector.account_label
            ? `Reading the New Relic account ${connector.account_label} in ${savedRegion(connector.config)}${byKey ? ' with your User API key. Reconnect signs in through Claude Code instead and replaces the key' : ''}.`
            : "Opens New Relic's sign-in page in your browser."
        }
      />
      <button
        type="button"
        aria-expanded={keyOpen}
        className="cursor-pointer self-start border-0 bg-transparent p-0 text-xs text-neutral-700 underline"
        onClick={() => setKeyOpen((open) => !open)}
      >
        {keyOpen ? 'Hide the User API key' : 'Use a User API key instead'}
      </button>
      {keyOpen && (
        <ChoiceCard label="User API key">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-semibold">API key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              placeholder="NRAK-…"
              disabled={waiting}
              onChange={(event) => setKey(event.target.value)}
              className="w-full border border-divider bg-card px-2 py-1.5 font-mono text-[13px] text-text"
            />
          </label>
          <p className="m-0 text-xs text-neutral-700">
            Needs a User API key with read access to the account's logs: not an ingest or browser key. The Region above
            applies. The console keeps the key in the macOS Keychain and never shows it again.
          </p>
          <div>
            <Button
              disabled={pending || waiting || key.trim() === ''}
              onClick={() => {
                onConnect({ region, api_key: key.trim() });
                // The key is gone from the page once sent; a failed one is typed again.
                setKey('');
                setKeyOpen(false);
              }}
            >
              Connect with key
            </Button>
          </div>
        </ChoiceCard>
      )}
      {choosing && (
        <PickStep
          id={ConnectorId.NewRelicLogs}
          pending={pending}
          onPick={(account_id) => onConnect({ region, account_id })}
        />
      )}
    </>
  );
}
