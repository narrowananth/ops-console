import {
  AccessLevel,
  type Connection,
  ConnectionEnv,
  ConnectionType,
  READ_ONLY_TYPES,
  SECRET_REQUIRED,
  SERVER_TYPES,
} from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { useCreateConnection, useDeleteConnection, useTestConnection, useUpdateConnection } from '../lib/queries';
import { FIELDS, SECRET_LABELS, TYPE_LABELS, toConfig } from './fields';

const input = 'w-full border-[1.5px] border-text bg-bg px-2 py-1.5 font-mono text-[13px] text-text';

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <legend className="p-0 text-xs font-extrabold">{label}</legend>
      <div className="flex w-max border border-divider">
        {options.map((option) => (
          <label
            key={option.value}
            className={`px-3.5 py-1.5 text-xs ${option.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${
              value === option.value ? 'bg-text text-bg' : 'bg-bg text-text'
            }`}
          >
            <input
              type="radio"
              name={label}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const ACCESS_HINT: Record<AccessLevel, string> = {
  [AccessLevel.None]: 'Claude cannot see this database. You can still query it from Dev tools.',
  [AccessLevel.Read]: 'The server starts in read-only mode.',
  [AccessLevel.Write]: 'Claude can write. On a PROD database every write needs your typed confirm.',
};

/** Add (no `connection`) or edit one Connection. Blank fields on edit keep their value. */
export function ConnectionForm({
  type,
  connection,
  onDone,
  onCancel,
}: {
  type: ConnectionType;
  connection?: Connection;
  onDone: () => void;
  onCancel: () => void;
}) {
  const create = useCreateConnection();
  const update = useUpdateConnection();
  const remove = useDeleteConnection();
  const test = useTestConnection();
  const [name, setName] = useState(connection?.name ?? '');
  const [env, setEnv] = useState<ConnectionEnv>(connection?.env ?? ConnectionEnv.Dev);
  const [access, setAccess] = useState<AccessLevel>(
    connection?.access ?? (READ_ONLY_TYPES.includes(type) ? AccessLevel.Read : AccessLevel.None),
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState('');
  const [confirming, setConfirming] = useState(false);
  const secretInfo = SECRET_LABELS[type];
  const hasServer = SERVER_TYPES.includes(type);
  const config = toConfig(type, drafts);
  const error = create.error ?? update.error ?? remove.error ?? test.error;
  const needsSecret = !connection && SECRET_REQUIRED.includes(type);

  const save = () => {
    if (connection) {
      update.mutate(
        { id: connection.id, body: { name, env, access, config, ...(secret ? { secret } : {}) } },
        { onSuccess: onDone },
      );
    } else {
      create.mutate({ name, type, env, access, config, ...(secret ? { secret } : {}) }, { onSuccess: onDone });
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-neutral-300 px-5 py-2.5">
        <Button className="px-2.5 py-1 text-xs" onClick={onCancel}>
          ← Back
        </Button>
        <strong className="text-[13px]">{connection ? connection.name : `New ${TYPE_LABELS[type]} connection`}</strong>
        {(connection?.is_prod || env === ConnectionEnv.Prod) && (
          <span className="border-[1.5px] border-accent px-1.5 py-px text-[10px] font-extrabold text-accent-700">
            PROD
          </span>
        )}
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        {connection && (
          <div className="text-[13px] text-neutral-700">Leave a field blank to keep its current value.</div>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor="connection-name" className="text-xs font-extrabold">
            Name
          </label>
          <input
            id="connection-name"
            className={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="orders-staging"
          />
          <span className="text-[11px] text-neutral-700">Also the name of the MCP Server Claude sees.</span>
        </div>
        <Segmented
          label="Environment"
          value={env}
          onChange={setEnv}
          options={Object.values(ConnectionEnv).map((value) => ({ value, label: value }))}
        />
        {FIELDS[type].map((field) => {
          const current = connection?.config[field.key];
          return (
            <div key={field.key} className="flex flex-col gap-1">
              <label htmlFor={`conn-${field.key}`} className="text-xs font-extrabold">
                {field.label}
              </label>
              <input
                id={`conn-${field.key}`}
                className={input}
                type={field.kind === 'number' ? 'number' : 'text'}
                value={drafts[field.key] ?? ''}
                placeholder={
                  current === undefined
                    ? field.placeholder
                    : Array.isArray(current)
                      ? current.join(', ')
                      : String(current)
                }
                onChange={(e) => setDrafts({ ...drafts, [field.key]: e.target.value })}
              />
            </div>
          );
        })}
        <div className="flex flex-col gap-1">
          <label htmlFor="connection-secret" className="text-xs font-extrabold">
            {secretInfo.label}
            {secretInfo.optional ? ' (optional)' : ''}
          </label>
          {secretInfo.multiline ? (
            <textarea
              id="connection-secret"
              className={input}
              rows={4}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          ) : (
            <input
              id="connection-secret"
              className={input}
              type="password"
              autoComplete="off"
              value={secret}
              placeholder={connection?.secret_stored ? 'stored in the Keychain' : ''}
              onChange={(e) => setSecret(e.target.value)}
            />
          )}
          <span className="text-[11px] text-neutral-700">Kept in the Keychain; never shown again.</span>
        </div>
        <div className="flex flex-col gap-1">
          <Segmented
            label="Claude access"
            value={access}
            onChange={setAccess}
            options={[
              { value: AccessLevel.None, label: 'Off' },
              { value: AccessLevel.Read, label: 'Read-only', disabled: !READ_ONLY_TYPES.includes(type) },
              { value: AccessLevel.Write, label: 'Read / write', disabled: !hasServer },
            ]}
          />
          <span className="text-[11px] text-neutral-700">
            {hasServer
              ? ACCESS_HINT[access]
              : `No MCP server is picked for ${TYPE_LABELS[type]} yet; it can be saved with access Off.`}
            {!READ_ONLY_TYPES.includes(type) && hasServer && ' This type has no read-only server.'}
          </span>
        </div>
        {test.data && (
          <div role="status" className={`text-xs ${test.data.status === 'ok' ? 'text-text' : 'text-accent-700'}`}>
            {test.data.status === 'ok' ? `Connected in ${test.data.latency_ms} ms.` : `Failed: ${test.data.detail}`}
          </div>
        )}
        {connection?.status_detail && (
          <div role="alert" className="text-xs text-accent-700">
            {connection.status_detail}
          </div>
        )}
        {error && (
          <div role="alert" className="text-xs text-accent-700">
            {error.message}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2.5 border-t-2 border-divider px-5 py-3.5">
        {connection &&
          (confirming ? (
            <>
              <Button
                variant="primary"
                disabled={remove.isPending}
                onClick={() => remove.mutate(connection.id, { onSuccess: onDone })}
              >
                Delete {connection.name}
              </Button>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
            </>
          ) : (
            <Button className="border-accent text-accent-700" onClick={() => setConfirming(true)}>
              Delete…
            </Button>
          ))}
        <Button
          disabled={test.isPending || (needsSecret && secret === '')}
          onClick={() => test.mutate({ type, config, ...(secret ? { secret } : {}) })}
        >
          Test
        </Button>
        <Button
          variant="primary"
          className="ml-auto"
          disabled={create.isPending || update.isPending || name === '' || (needsSecret && secret === '')}
          onClick={save}
        >
          {connection ? 'Save changes' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
