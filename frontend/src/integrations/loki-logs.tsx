import { type Connector, HealthStatus, LOKI_AUTH } from '@ops-console/shared';
import { useId, useState } from 'react';
import { z } from 'zod';
import { Button } from '../components/ui/button';
import { Segmented } from '../components/ui/segmented';

const FORMATS = ['json', 'logfmt'] as const;

const savedSchema = z.object({
  url: z.string().catch(''),
  org_id: z.string().catch(''),
  auth: z.enum(LOKI_AUTH).catch('none'),
  username: z.string().catch(''),
  service_label: z.string().catch('service_name'),
  env_label: z.string().catch('deployment_environment_name'),
  selector: z.string().catch(''),
  format: z.enum(FORMATS).catch('json'),
});

/** The settings the Connector keeps, across a Disconnect. The secret is not among them: it is only in the Keychain. */
export function savedLoki(connector: Connector) {
  return savedSchema.parse(connector.config);
}

const FIELD = 'w-full border border-divider bg-card px-2 py-1.5 font-mono text-[13px] text-text';

const AUTH_LABELS = { none: 'None', bearer: 'Bearer token', basic: 'Basic' } as const;

/** Where the body of Connect goes: a field left out keeps its stored value, so the secret is sent only when typed. */
export type LokiBody = {
  url: string;
  org_id: string;
  auth: (typeof LOKI_AUTH)[number];
  username: string;
  service_label: string;
  env_label: string;
  selector: string;
  format: (typeof FORMATS)[number];
  secret?: string;
};

/**
 * The Loki URL, how to sign in, the label names and the format. The secret goes to the Keychain and never comes back:
 * the pane knows one is set because a connected Connector uses bearer or basic, and shows that, never the value.
 */
export function LokiStep({
  connector,
  pending,
  onConnect,
}: {
  connector: Connector;
  pending: boolean;
  /** `done` runs when the daemon accepted the body. */
  onConnect: (body: LokiBody, done: () => void) => void;
}) {
  const saved = savedLoki(connector);
  const [url, setUrl] = useState(saved.url);
  const [orgId, setOrgId] = useState(saved.org_id);
  const [auth, setAuth] = useState(saved.auth);
  const [username, setUsername] = useState(saved.username);
  const [secret, setSecret] = useState('');
  const [serviceLabel, setServiceLabel] = useState(saved.service_label);
  const [envLabel, setEnvLabel] = useState(saved.env_label);
  const [selector, setSelector] = useState(saved.selector);
  const [format, setFormat] = useState(saved.format);
  const secretId = useId();
  const connected = connector.status === HealthStatus.Ok;
  const checking = connector.status === HealthStatus.Checking;
  const secretSet = connector.status !== HealthStatus.Off && saved.auth !== 'none';
  const signsIn = auth !== 'none';
  const ready =
    url.trim() !== '' &&
    serviceLabel.trim() !== '' &&
    envLabel.trim() !== '' &&
    (auth !== 'basic' || username.trim() !== '') &&
    (!signsIn || secretSet || secret !== '');
  const detail = connected
    ? `Reading logs from ${saved.url}.`
    : 'The console reads logs with the logcli CLI (`brew install logcli`) and keeps the secret in the Keychain.';

  return (
    <section
      aria-label="Loki connection"
      className="flex flex-col gap-3 rounded-lg border border-line bg-card px-4 py-3.5 shadow-sm"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || pending || checking) return;
          onConnect(
            {
              url: url.trim(),
              org_id: orgId.trim(),
              auth,
              username: auth === 'basic' ? username.trim() : '',
              service_label: serviceLabel.trim(),
              env_label: envLabel.trim(),
              selector: selector.trim(),
              format,
              ...(signsIn && secret !== '' ? { secret } : {}),
            },
            () => setSecret(''),
          );
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-semibold" title="The address of Loki, such as https://loki.example.com.">
            Loki URL
          </span>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://loki.example.com"
            spellCheck={false}
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-semibold" title="The tenant, sent as X-Scope-OrgID. Blank for none.">
            Org ID <span className="font-normal text-neutral-700">(optional)</span>
          </span>
          <input
            value={orgId}
            onChange={(event) => setOrgId(event.target.value)}
            spellCheck={false}
            className={FIELD}
          />
        </label>

        <Segmented
          label="Auth"
          value={auth}
          onChange={setAuth}
          options={LOKI_AUTH.map((value) => ({ value, label: AUTH_LABELS[value] }))}
        />
        {auth === 'basic' && (
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-semibold">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              className={FIELD}
            />
          </label>
        )}
        {signsIn && (
          <div className="flex flex-col gap-1 text-xs">
            <label htmlFor={secretId} className="font-semibold">
              Secret
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
              {secretSet ? 'Secret set in the Keychain.' : 'No secret set.'} It is never shown again.
            </span>
          </div>
        )}
        <p className="m-0 text-xs text-neutral-700">
          Grafana Cloud: choose Basic, use the Loki instance ID as the username and an access-policy token with the{' '}
          <code className="font-mono">logs:read</code> scope as the secret.
        </p>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-semibold" title="The stream label whose values are the Service names.">
              Service label
            </span>
            <input
              value={serviceLabel}
              onChange={(event) => setServiceLabel(event.target.value)}
              spellCheck={false}
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span
              className="font-semibold"
              title="The stream label that says the env. A stream without it reads as no env."
            >
              Env label
            </span>
            <input
              value={envLabel}
              onChange={(event) => setEnvLabel(event.target.value)}
              spellCheck={false}
              className={FIELD}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-semibold" title="Extra stream matchers that every read is limited to.">
            Stream selector <span className="font-normal text-neutral-700">(optional)</span>
          </span>
          <input
            value={selector}
            onChange={(event) => setSelector(event.target.value)}
            placeholder='cluster="prod-1"'
            spellCheck={false}
            className={FIELD}
          />
        </label>
        <Segmented
          label="Format"
          hint="How each log line is written. The reader parses one format."
          value={format}
          onChange={setFormat}
          options={FORMATS.map((value) => ({ value, label: value === 'json' ? 'JSON' : 'logfmt' }))}
        />

        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 text-xs text-neutral-700">{detail}</div>
          <Button
            type="submit"
            variant={connected ? 'secondary' : 'primary'}
            className="shrink-0"
            title={
              ready
                ? 'Check Loki with these settings and start reading it'
                : 'Needs a URL, the label names, and for Basic a username and a secret'
            }
            disabled={pending || checking || !ready}
          >
            {connector.status === HealthStatus.Off ? 'Connect' : 'Reconnect'}
          </Button>
        </div>
      </form>
      {checking && (
        <div role="status" className="text-xs text-neutral-700">
          Checking Loki…
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
