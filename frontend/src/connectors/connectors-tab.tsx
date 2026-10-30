import { CONNECTOR_NAMES, type Connector, ConnectorId, HealthStatus, TOKEN_CONNECTORS } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import {
  useConnectConnector,
  useConnectors,
  useDisconnectConnector,
  useSaveConnector,
  useTestConnector,
} from '../lib/queries';
import { statusGlyph } from '../mcp/status';
import { FIELDS, read, toPatch } from './fields';

const input = 'w-full border-[1.5px] border-text bg-bg px-2 py-1.5 font-mono text-[13px] text-text';

function Drawer({ connector, onBack }: { connector: Connector; onBack: () => void }) {
  const save = useSaveConnector();
  const connect = useConnectConnector();
  const test = useTestConnector();
  const disconnect = useDisconnectConnector();
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>({});
  const [secret, setSecret] = useState('');
  const [confirming, setConfirming] = useState(false);
  const fields = FIELDS[connector.id];
  const needsToken = TOKEN_CONNECTORS.includes(connector.id);
  const connected = connector.status !== HealthStatus.Off;
  const error = save.error ?? connect.error ?? test.error ?? disconnect.error;
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
      <div className="border-b border-neutral-300 px-5 py-3 text-xs text-neutral-700">
        <div>Reached through {connector.via}.</div>
        {connector.account_label && <div>Account: {connector.account_label}</div>}
        {connector.login && <div>Signed in as {connector.login}</div>}
        {connector.status_detail && (
          <div role="alert" className="text-accent-700">
            {connector.status_detail}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="text-[13px] text-neutral-700">Leave a field blank to keep its current value.</div>
        {fields.map((field) => {
          const current = read(connector.config, field.key);
          const shown =
            field.kind === 'list'
              ? (current as string[] | undefined)?.join(', ')
              : field.kind === 'ignore'
                ? (current as { kind: string; value: string }[] | undefined)
                    ?.map((i) => `${i.kind}:${i.value}`)
                    .join(' · ')
                : current;
          if (field.kind === 'bool') {
            return (
              <label key={field.key} className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={Boolean(drafts[field.key] ?? current)}
                  onChange={(event) => setDrafts({ ...drafts, [field.key]: event.target.checked })}
                />
                {field.label}
              </label>
            );
          }
          return (
            <div key={field.key} className="flex flex-col gap-1 text-xs font-extrabold">
              <label htmlFor={`field-${field.key}`}>{field.label}</label>
              {field.kind === 'ignore' ? (
                <textarea
                  id={`field-${field.key}`}
                  className={input}
                  rows={3}
                  value={String(drafts[field.key] ?? '')}
                  placeholder={String(shown ?? '')}
                  onChange={(event) => setDrafts({ ...drafts, [field.key]: event.target.value })}
                />
              ) : (
                <input
                  id={`field-${field.key}`}
                  className={input}
                  type={field.kind === 'number' ? 'number' : 'text'}
                  value={String(drafts[field.key] ?? '')}
                  placeholder={String(shown ?? '')}
                  onChange={(event) => setDrafts({ ...drafts, [field.key]: event.target.value })}
                />
              )}
            </div>
          );
        })}
        {needsToken && (
          <label className="flex flex-col gap-1 text-xs font-extrabold">
            Access token
            <input
              className={input}
              type="password"
              autoComplete="off"
              value={secret}
              placeholder={connector.secret_stored ? 'stored in the Keychain' : 'paste a token'}
              onChange={(event) => setSecret(event.target.value)}
            />
            <span className="text-[11px] font-normal text-neutral-700">Kept in the Keychain; never shown again.</span>
          </label>
        )}
        {error && (
          <div role="alert" className="text-xs text-accent-700">
            {error.message}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2.5 border-t-2 border-divider px-5 py-3.5">
        <Button
          variant={connected ? 'secondary' : 'primary'}
          disabled={connect.isPending || (needsToken && secret === '')}
          onClick={() =>
            connect.mutate(
              { id: connector.id, secret: needsToken ? secret : undefined },
              { onSuccess: () => setSecret('') },
            )
          }
        >
          {connected ? 'Connect again' : 'Connect'}
        </Button>
        <Button disabled={test.isPending || !connected} onClick={() => test.mutate(connector.id)}>
          Test
        </Button>
        <Button
          variant="primary"
          className="ml-auto"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({ id: connector.id, config: toPatch(drafts, fields) }, { onSuccess: () => setDrafts({}) })
          }
        >
          Save changes
        </Button>
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
          <div className="flex items-center gap-3 px-5 py-3.5">
            <div className="flex-1 text-xs text-neutral-700">Stops the console using {connector.name}.</div>
            <Button className="border-accent text-accent-700" onClick={() => setConfirming(true)}>
              Disconnect…
            </Button>
          </div>
        ))}
    </div>
  );
}

export function ConnectorsTab() {
  const connectors = useConnectors();
  const [open, setOpen] = useState<ConnectorId | null>(null);
  if (connectors.isPending) return <Empty>Loading Connectors…</Empty>;
  if (connectors.isError) return <Empty>Could not read Connectors: {connectors.error.message}</Empty>;
  const opened = connectors.data.data.find((connector) => connector.id === open);
  if (opened) return <Drawer connector={opened} onBack={() => setOpen(null)} />;
  return (
    <ul className="m-0 list-none p-0">
      {connectors.data.data.map((connector) => {
        const status = statusGlyph[connector.status];
        return (
          <li key={connector.id} aria-label={CONNECTOR_NAMES[connector.id]} className="border-b border-neutral-300">
            <button
              type="button"
              onClick={() => setOpen(connector.id)}
              className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_120px_auto] items-center gap-3 border-0 bg-transparent px-5 py-3 text-left text-text hover:bg-neutral-200"
            >
              <span className="min-w-0">
                <span className="block text-[13px] font-extrabold">{connector.name}</span>
                <span className="block truncate font-mono text-[11px] text-neutral-700">
                  {connector.via}
                  {connector.account_label ? ` · ${connector.account_label}` : ''}
                </span>
              </span>
              <span className={`font-mono text-xs ${status.className}`}>{status.glyph}</span>
              <span className="text-xs text-neutral-700">
                {connector.status === HealthStatus.Off ? 'Connect' : 'Manage'}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
