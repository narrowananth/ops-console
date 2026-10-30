import {
  type CreateMcpServer,
  McpScope,
  type McpServer,
  McpTransport,
  type UpdateMcpServer,
} from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { useCreateMcpServer, useUpdateMcpServer } from '../lib/queries';

type Pair = { key: string; value: string };

const input = 'w-full border-[1.5px] border-text bg-bg px-2 py-1.5 font-mono text-[13px] text-text';

function Pairs({
  label,
  pairs,
  onChange,
  valuePlaceholder,
}: {
  label: string;
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
  valuePlaceholder: string;
}) {
  const set = (index: number, change: Partial<Pair>) =>
    onChange(pairs.map((pair, at) => (at === index ? { ...pair, ...change } : pair)));
  return (
    <div className="flex flex-col gap-1.5">
      {pairs.map((pair, index) => (
        // Rows have no identity beyond their place; names are edited in place.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-1.5">
          <input
            aria-label={`${label} name ${index + 1}`}
            className={input}
            value={pair.key}
            placeholder="NAME"
            onChange={(event) => set(index, { key: event.target.value })}
          />
          <input
            aria-label={`${label} value ${index + 1}`}
            className={input}
            type="password"
            autoComplete="off"
            value={pair.value}
            placeholder={valuePlaceholder}
            onChange={(event) => set(index, { value: event.target.value })}
          />
          <Button
            icon
            className="size-8"
            aria-label={`Remove ${label} ${index + 1}`}
            onClick={() => onChange(pairs.filter((_, at) => at !== index))}
          >
            ×
          </Button>
        </div>
      ))}
      <div>
        <Button className="px-2.5 py-1 text-xs" onClick={() => onChange([...pairs, { key: '', value: '' }])}>
          + Add {label.toLowerCase()}
        </Button>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <legend className="p-0 text-xs font-extrabold">{label}</legend>
      <div className="flex w-max border border-divider">
        {options.map((option) => (
          <label
            key={option}
            className={`cursor-pointer px-3.5 py-1.5 text-xs ${value === option ? 'bg-text text-bg' : 'bg-bg text-text'}`}
          >
            <input
              type="radio"
              name={label}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
              className="sr-only"
            />
            {option}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const toRecord = (pairs: Pair[]): Record<string, string> =>
  Object.fromEntries(pairs.filter((pair) => pair.key.trim() !== '').map((pair) => [pair.key.trim(), pair.value]));

/** Add (no `server`) or edit one MCP server. Blank values on edit keep what is stored. */
export function McpForm({
  server,
  onDone,
  onCancel,
}: {
  server?: McpServer;
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  const create = useCreateMcpServer();
  const update = useUpdateMcpServer();
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? McpTransport.Stdio);
  const [target, setTarget] = useState(server?.target ?? '');
  const [scope, setScope] = useState<McpScope>(server?.scope ?? McpScope.User);
  const [env, setEnv] = useState<Pair[]>((server?.env_keys ?? []).map((key) => ({ key, value: '' })));
  const [headers, setHeaders] = useState<Pair[]>([]);
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const stdio = transport === McpTransport.Stdio;

  const save = () => {
    const secrets = stdio ? { env: toRecord(env) } : { headers: toRecord(headers) };
    if (server) {
      const body: UpdateMcpServer = { transport, target, scope, ...secrets };
      update.mutate({ name: server.name, body }, { onSuccess: () => onDone(server.name) });
    } else {
      const body: CreateMcpServer = { name, transport, target, scope, ...secrets };
      create.mutate(body, { onSuccess: () => onDone(name) });
    }
  };

  return (
    <div className="flex flex-col gap-3.5 px-5 py-4">
      <div className="text-[13px] text-neutral-700">
        {server
          ? 'Changes register the server again in every Claude account. Leave a value blank to keep it.'
          : 'The server is registered in every Claude account. Env vars go to the Keychain, not to Claude Code config.'}
      </div>
      <label className="flex flex-col gap-1 text-xs font-extrabold">
        Name
        <input
          className={input}
          value={name}
          disabled={server !== undefined}
          onChange={(event) => setName(event.target.value)}
          placeholder="sentry"
        />
      </label>
      <Segmented label="Transport" options={Object.values(McpTransport)} value={transport} onChange={setTransport} />
      <label className="flex flex-col gap-1 text-xs font-extrabold">
        {stdio ? 'Command' : 'URL'}
        <input
          className={input}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder={stdio ? 'npx -y @example/server' : 'https://mcp.example.com/mcp'}
        />
      </label>
      <div className="flex flex-col gap-1">
        <Segmented label="Scope" options={[McpScope.User, McpScope.Local]} value={scope} onChange={setScope} />
        <span className="text-[11px] font-normal text-neutral-700">Project scope arrives with Settings › Repos.</span>
      </div>
      {stdio ? (
        <div className="flex flex-col gap-1 text-xs font-extrabold">
          Env vars
          <Pairs label="Env var" pairs={env} onChange={setEnv} valuePlaceholder={server ? 'unchanged' : 'value'} />
          <span className="text-[11px] font-normal text-neutral-700">Stored in the Keychain; shown as names only.</span>
        </div>
      ) : (
        <div className="flex flex-col gap-1 text-xs font-extrabold">
          Headers
          <Pairs
            label="Header"
            pairs={headers}
            onChange={setHeaders}
            valuePlaceholder={server?.has_headers ? 'unchanged' : 'value'}
          />
          <span className="text-[11px] font-normal text-accent-700">
            Claude Code sends headers itself, so it keeps their values in its own config file in plain text. Leave
            headers empty and Authenticate to sign in with OAuth instead.
          </span>
        </div>
      )}
      {error && (
        <div role="alert" className="text-xs text-accent-700">
          {error.message}
        </div>
      )}
      <div className="flex gap-2.5 border-t-2 border-divider pt-3.5">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" className="ml-auto" disabled={busy || name === '' || target === ''} onClick={save}>
          {server ? 'Save changes' : 'Add server'}
        </Button>
      </div>
    </div>
  );
}
