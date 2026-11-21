import { ConnectorId, HealthStatus, NEW_RELIC_REGIONS } from '@ops-console/shared';
import { useState } from 'react';
import { Segmented } from '../components/ui/segmented';
import { asksPick, PickStep } from './pick-step';
import { ChoiceCard, type ConnectPane, SignInStep } from './sign-in-step';

type Region = (typeof NEW_RELIC_REGIONS)[number];

/** The Region the Connector kept across a Disconnect; US until chosen. */
const savedRegion = (config: Record<string, unknown>): Region =>
  NEW_RELIC_REGIONS.find((region) => region === config.region) ?? 'US';

/**
 * The Region, then the sign-in through Claude Code. A sign-in that can read several accounts asks for one after, and
 * that pick goes with the Region.
 */
export function NewRelicStep({ connector, pending, cancelling, onConnect, onCancel }: ConnectPane) {
  const [region, setRegion] = useState(savedRegion(connector.config));
  const choosing = asksPick(connector, ConnectorId.NewRelicLogs);
  const connected = connector.status === HealthStatus.Ok;
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
            ? `Reading the New Relic account ${connector.account_label} in ${savedRegion(connector.config)}.`
            : "Opens New Relic's sign-in page in your browser."
        }
      />
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
