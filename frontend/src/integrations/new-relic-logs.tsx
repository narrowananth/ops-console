import { type Connector, HealthStatus, NEW_RELIC_REGIONS } from '@ops-console/shared';
import { useId, useState } from 'react';
import { z } from 'zod';
import { Button } from '../components/ui/button';
import { Segmented } from '../components/ui/segmented';

const savedSchema = z.object({
  account_id: z.string().catch(''),
  region: z.enum(NEW_RELIC_REGIONS).catch('US'),
  service_attribute: z.string().catch('service.name'),
  env_attribute: z.string().catch('environment'),
  filter: z.string().catch(''),
});

/** The settings the Connector keeps, across a Disconnect. The key is not among them: it is only in the Keychain. */
export function savedNewRelic(connector: Connector) {
  return savedSchema.parse(connector.config);
}

const FIELD = 'w-full border border-divider bg-card px-2 py-1.5 font-mono text-[13px] text-text';

/** Where the body of Connect goes: a field left out keeps its stored value, so the key is sent only when typed. */
export type NewRelicBody = {
  account_id: string;
  region: (typeof NEW_RELIC_REGIONS)[number];
  service_attribute: string;
  env_attribute: string;
  filter: string;
  secret?: string;
};

/**
 * The account ID, the region, the API key, the attribute names and an optional filter. The key goes to the Keychain
 * and never comes back: the pane knows one is set because the Connector is not off, and shows that, never the value.
 */
export function NewRelicStep({
  connector,
  pending,
  onConnect,
}: {
  connector: Connector;
  pending: boolean;
  /** `done` runs when the daemon accepted the body. */
  onConnect: (body: NewRelicBody, done: () => void) => void;
}) {
  const saved = savedNewRelic(connector);
  const [accountId, setAccountId] = useState(saved.account_id);
  const [region, setRegion] = useState(saved.region);
  const [secret, setSecret] = useState('');
  const [serviceAttribute, setServiceAttribute] = useState(saved.service_attribute);
  const [envAttribute, setEnvAttribute] = useState(saved.env_attribute);
  const [filter, setFilter] = useState(saved.filter);
  const secretId = useId();
  const connected = connector.status === HealthStatus.Ok;
  const checking = connector.status === HealthStatus.Checking;
  const secretSet = connector.status !== HealthStatus.Off;
  const ready =
    accountId.trim() !== '' &&
    serviceAttribute.trim() !== '' &&
    envAttribute.trim() !== '' &&
    (secretSet || secret !== '');
  const detail = connected
    ? `Reading logs from account ${saved.account_id} in ${saved.region}.`
    : 'The console reads logs with the newrelic CLI (`brew install newrelic-cli`) and keeps the key in the Keychain.';

  return (
    <section
      aria-label="New Relic connection"
      className="flex flex-col gap-3 rounded-lg border border-line bg-card px-4 py-3.5 shadow-sm"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || pending || checking) return;
          onConnect(
            {
              account_id: accountId.trim(),
              region,
              service_attribute: serviceAttribute.trim(),
              env_attribute: envAttribute.trim(),
              filter: filter.trim(),
              ...(secret !== '' ? { secret } : {}),
            },
            () => setSecret(''),
          );
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-semibold" title="The number of the New Relic account whose logs are read.">
            Account ID
          </span>
          <input
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            placeholder="1234567"
            inputMode="numeric"
            spellCheck={false}
            className={FIELD}
          />
        </label>
        <Segmented
          label="Region"
          hint="The data center the account lives in: US, EU or JP."
          value={region}
          onChange={setRegion}
          options={NEW_RELIC_REGIONS.map((value) => ({ value, label: value }))}
        />
        <div className="flex flex-col gap-1 text-xs">
          <label htmlFor={secretId} className="font-semibold">
            API key
          </label>
          <input
            id={secretId}
            type="password"
            autoComplete="off"
            value={secret}
            placeholder={secretSet ? 'Set. Type a new one to replace it.' : ''}
            onChange={(event) => setSecret(event.target.value)}
            className={FIELD}
          />
          <span className="text-neutral-700">
            {secretSet ? 'Key set in the Keychain.' : 'No key set.'} It is never shown again.
          </span>
        </div>
        <p className="m-0 text-xs text-neutral-700">
          Find the account ID in one.newrelic.com: open the user menu, then Administration, Access management and
          Accounts. Use a User key, and choose the region of its account: a key belongs to one region. Use a dedicated
          user with a read-only role, since the key reaches every account that user can open.
        </p>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-semibold" title="The log attribute whose values are the Service names.">
              Service attribute
            </span>
            <input
              value={serviceAttribute}
              onChange={(event) => setServiceAttribute(event.target.value)}
              spellCheck={false}
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span
              className="font-semibold"
              title="The log attribute that says the env. An event without it reads as no env."
            >
              Env attribute
            </span>
            <input
              value={envAttribute}
              onChange={(event) => setEnvAttribute(event.target.value)}
              spellCheck={false}
              className={FIELD}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-semibold" title="One extra condition that every read is limited to.">
            Filter <span className="font-normal text-neutral-700">(optional)</span>
          </span>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="cluster = 'prod-1'"
            spellCheck={false}
            className={FIELD}
          />
        </label>

        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 text-xs text-neutral-700">{detail}</div>
          <Button
            type="submit"
            variant={connected ? 'secondary' : 'primary'}
            className="shrink-0"
            title={
              ready
                ? 'Check New Relic with these settings and start reading it'
                : 'Needs an account ID, the attribute names and an API key'
            }
            disabled={pending || checking || !ready}
          >
            {connector.status === HealthStatus.Off ? 'Connect' : 'Reconnect'}
          </Button>
        </div>
      </form>
      {checking && (
        <div role="status" className="text-xs text-neutral-700">
          Checking New Relic…
        </div>
      )}
      {connector.status_detail && connector.status !== HealthStatus.Off && (
        <div role="alert" className="text-xs text-accent-700">
          {connector.status_detail}
        </div>
      )}
    </section>
  );
}
