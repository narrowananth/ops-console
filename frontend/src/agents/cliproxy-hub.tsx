import { type CliProxy, CliProxyStatus, LOCAL_ADDRESS } from '@ops-console/shared';
import { useState } from 'react';
import { Section } from '../app/page';
import { Button } from '../components/ui/button';
import { Toggle } from '../components/ui/toggle';
import { useCliProxyAction, usePatchSettings } from '../lib/queries';

const STATUS: Record<CliProxyStatus, { label: string; dot: string; text: string }> = {
  [CliProxyStatus.Connected]: { label: 'Connected', dot: 'bg-ok', text: 'text-ok' },
  [CliProxyStatus.NoKey]: { label: 'No API key', dot: 'bg-neutral-500', text: 'text-neutral-700' },
  [CliProxyStatus.Unchecked]: { label: 'Not checked yet', dot: 'bg-neutral-500', text: 'text-neutral-700' },
  [CliProxyStatus.Refused]: { label: 'Key refused', dot: 'bg-accent', text: 'text-accent-700' },
  [CliProxyStatus.Unreachable]: { label: 'Not reachable', dot: 'bg-accent', text: 'text-accent-700' },
};

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

const INPUT =
  'w-60 rounded-md border border-divider bg-card px-2.5 py-1.5 font-mono text-xs text-text outline-none focus:border-accent-400';

/**
 * Claude account hub: the console's own accounts, or CLIProxy. On, runs sign in to Claude through CLIProxy's API key
 * and CLIProxy picks the account and tracks the quota.
 */
export function CliProxyHub({ hub }: { hub: CliProxy }) {
  const patch = usePatchSettings();
  const action = useCliProxyAction();
  const [address, setAddress] = useState(hub.address);
  const [key, setKey] = useState('');
  const addressOk = LOCAL_ADDRESS.test(address.trim());
  const status = STATUS[hub.status];
  const error = patch.error ?? action.error;

  return (
    <Section
      title="Claude account hub"
      sub="Who signs the agent in to Claude: this console's accounts below, or a CLIProxy server on this Mac that holds the accounts and spreads the usage."
    >
      <div className="divide-y divide-line">
        <div className="flex items-center gap-4 px-5 py-4">
          <div className="flex-1">
            <div className="font-semibold">Use CLIProxy</div>
            <div className="text-xs text-neutral-700">
              Runs go through CLIProxy. It picks the account and tracks the quota; the accounts and switching below
              pause until you turn this off.
            </div>
          </div>
          <Toggle
            label="Use CLIProxy"
            checked={hub.enabled}
            disabled={!hub.has_key && !hub.enabled}
            title={hub.has_key || hub.enabled ? undefined : "Save CLIProxy's API key first"}
            onChange={(enabled) => patch.mutate({ cliproxy: { enabled, address: hub.address } })}
          />
        </div>
        <div className="flex items-center gap-4 px-5 py-4">
          <div className="flex-1">
            <div className="font-semibold">Address</div>
            <div className="text-xs text-neutral-700">
              Where CLIProxy listens. Only an address on this Mac: the agent's prompts and code go there.
            </div>
          </div>
          <input
            aria-label="CLIProxy address"
            value={address}
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
            className={INPUT}
          />
          <Button
            className="px-3 py-1.25 text-xs"
            disabled={!addressOk || address.trim() === hub.address || patch.isPending}
            title={addressOk ? undefined : 'An address on this Mac, such as http://127.0.0.1:8317'}
            onClick={() => patch.mutate({ cliproxy: { enabled: hub.enabled, address: address.trim() } })}
          >
            Save
          </Button>
        </div>
        <div className="flex items-center gap-4 px-5 py-4">
          <div className="flex-1">
            <div className="font-semibold">API key</div>
            <div className="text-xs text-neutral-700">
              One of the keys in CLIProxy's <code className="font-mono">access.api-keys</code>. Kept in the macOS
              Keychain; it never comes back to this page.
            </div>
          </div>
          <input
            aria-label="CLIProxy API key"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={hub.has_key ? 'Saved in the Keychain' : 'sk-…'}
            onChange={(event) => setKey(event.target.value)}
            className={INPUT}
          />
          <Button
            className="px-3 py-1.25 text-xs"
            disabled={key.trim() === '' || action.isPending}
            onClick={() => action.mutate({ kind: 'save', key: key.trim() }, { onSuccess: () => setKey('') })}
          >
            Save
          </Button>
          {hub.has_key && (
            <Button
              className="px-3 py-1.25 text-xs"
              title="Delete the key from the Keychain. CLIProxy turns off with it."
              disabled={action.isPending}
              onClick={() => action.mutate({ kind: 'remove' })}
            >
              Remove
            </Button>
          )}
        </div>
        <div className="flex items-center gap-3 px-5 py-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
            <span aria-hidden className={`size-1.75 flex-none rounded-full ${status.dot}`} />
            <span className={`font-semibold ${status.text}`}>{status.label}</span>
            {(hub.status_detail || hub.checked_at) && (
              <span className="truncate text-neutral-700">
                {[hub.status_detail, hub.checked_at && `checked ${ago(hub.checked_at)}`].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
          <Button
            className="px-3 py-1.25 text-xs"
            title="Ask CLIProxy again with the saved key"
            disabled={!hub.has_key || action.isPending}
            onClick={() => action.mutate({ kind: 'check' })}
          >
            Check
          </Button>
          <a
            href={`${hub.address.replace(/\/+$/, '')}/management.html`}
            target="_blank"
            rel="noreferrer"
            title="CLIProxy's own panel: its accounts and their quota"
            className="rounded-md border border-line bg-card px-3 py-1.25 text-xs font-semibold text-text no-underline hover:bg-neutral-200"
          >
            Open CLIProxy ↗
          </a>
        </div>
        {error && (
          <div role="alert" className="px-5 py-3 text-xs text-accent-700">
            {error.message}
          </div>
        )}
      </div>
    </Section>
  );
}
