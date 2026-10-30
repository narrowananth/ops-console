import {
  type AgentAccountsSetting,
  agentAccountsSettingSchema,
  type ClaudeAccount,
  type SessionDefaults,
} from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Dropdown } from '../components/ui/dropdown';
import { Empty } from '../components/ui/empty';
import { Toggle } from '../components/ui/toggle';
import {
  useActivateAccount,
  useAddAccount,
  useAgentAccounts,
  useAgentSettings,
  useCheckAccount,
  usePatchSettings,
} from '../lib/queries';
import { ACCESS_MODES, EFFORTS, MODELS } from './options';

const HOUR_MS = 3_600_000;

function resetsIn(iso: string | null): string {
  if (iso === null) return '';
  const left = Date.parse(iso) - Date.now();
  if (left <= 0) return 'reset';
  if (left >= 24 * HOUR_MS) return `resets in ${Math.round(left / (24 * HOUR_MS))}d`;
  const hours = Math.floor(left / HOUR_MS);
  const minutes = Math.floor((left % HOUR_MS) / 60_000);
  return `resets in ${hours ? `${hours}h ` : ''}${minutes}m`;
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function UsageBar({
  label,
  pct,
  resetsAt,
  accentAt,
}: {
  label: string;
  pct: number;
  resetsAt: string | null;
  accentAt: number;
}) {
  const hot = pct >= accentAt;
  return (
    <div className="grid grid-cols-[48px_minmax(0,1fr)_160px] items-center gap-2.5">
      <span className="text-[11px] text-neutral-700">{label}</span>
      <span className="block h-1.5 bg-neutral-300" aria-hidden>
        <span className={`block h-1.5 ${hot ? 'bg-accent' : 'bg-text'}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </span>
      <span className={`font-mono text-[11px] ${hot ? 'text-accent-700' : 'text-neutral-800'}`}>
        {Math.round(pct)}% · {resetsIn(resetsAt)}
      </span>
    </div>
  );
}

function AccountRow({ account, isPick, onUse }: { account: ClaudeAccount; isPick: boolean; onUse: () => void }) {
  const check = useCheckAccount();
  const known = account.five_hour_pct !== null || account.weekly_pct !== null;
  return (
    <li
      aria-label={account.label}
      className={`grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-divider px-5 py-3 ${
        account.is_active ? 'bg-neutral-200' : ''
      }`}
    >
      <span className="font-mono text-[11px] text-neutral-700">{String(account.position).padStart(2, '0')}</span>
      <div className="flex min-w-0 flex-col gap-1.25">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="font-mono text-[13px]">{account.label}</strong>
          {account.email && (
            <span className="text-xs text-neutral-700">
              {account.email}
              {account.plan ? ` · ${account.plan}` : ''}
            </span>
          )}
          {account.is_active && <span className="bg-text px-1.5 py-px text-[10px] font-extrabold text-bg">ACTIVE</span>}
          {isPick && (
            <span className="border-[1.5px] border-accent px-1.5 py-px text-[10px] font-extrabold text-accent-700">
              SMART PICK
            </span>
          )}
        </div>
        {!account.signed_in ? (
          <div className="text-xs text-neutral-700">Not signed in.</div>
        ) : known ? (
          <>
            <UsageBar
              label="5-hour"
              pct={account.five_hour_pct ?? 0}
              resetsAt={account.five_hour_resets_at}
              accentAt={90}
            />
            <UsageBar label="Weekly" pct={account.weekly_pct ?? 0} resetsAt={account.weekly_resets_at} accentAt={80} />
          </>
        ) : (
          <div className="text-xs text-neutral-700">no usage yet</div>
        )}
        {check.isError && (
          <div role="alert" className="text-xs text-accent-700">
            {check.error.message}
          </div>
        )}
        <div className="text-[11px] text-neutral-700">
          {[account.smart_note, account.usage_seen_at && `usage seen ${ago(account.usage_seen_at)}`]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      {!account.signed_in ? (
        <Button
          className="px-2.5 py-1 text-xs"
          disabled={check.isPending}
          title="Run the sign-in command first; this checks the sign-in."
          onClick={() => check.mutate(account.id)}
        >
          Sign in
        </Button>
      ) : account.is_active ? (
        <span className="w-17.5" />
      ) : (
        <Button className="px-2.5 py-1 text-xs" onClick={onUse}>
          Use
        </Button>
      )}
    </li>
  );
}

function AddAccount() {
  const add = useAddAccount();
  const check = useCheckAccount();
  const [label, setLabel] = useState('');
  const [open, setOpen] = useState(false);
  const added = add.data?.data;

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        + Add Claude account
      </Button>
    );
  }
  if (added) {
    return (
      <div className="flex flex-col gap-2 text-xs">
        <span>Run this in a terminal and sign in with Anthropic, then check:</span>
        <div className="flex items-center gap-2">
          <code className="flex-1 border border-divider bg-surface px-2 py-1.5 font-mono">{added.sign_in_command}</code>
          <Button
            className="px-2.5 py-1 text-xs"
            onClick={() => void navigator.clipboard.writeText(added.sign_in_command)}
          >
            Copy
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            className="px-2.5 py-1 text-xs"
            disabled={check.isPending}
            onClick={() => check.mutate(added.account.id)}
          >
            Check sign-in
          </Button>
          <Button
            className="px-2.5 py-1 text-xs"
            onClick={() => {
              add.reset();
              setLabel('');
              setOpen(false);
            }}
          >
            Done
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (label.trim()) add.mutate(label.trim());
      }}
    >
      <input
        aria-label="Account label"
        placeholder="Label, for example personal"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        className="flex-1 border-[1.5px] border-text bg-bg px-2.5 py-1.5 text-[13px] text-text"
      />
      <Button variant="primary" type="submit" className="px-2.5 py-1.5 text-xs" disabled={add.isPending}>
        Add
      </Button>
      <Button className="px-2.5 py-1.5 text-xs" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {add.isError && <span className="text-xs text-accent-700">Could not add the account.</span>}
    </form>
  );
}

function Switches({
  setting,
  onChange,
}: {
  setting: AgentAccountsSetting;
  onChange: (next: AgentAccountsSetting) => void;
}) {
  const [threshold, setThreshold] = useState(String(setting.threshold));
  const commitThreshold = () => {
    const value = agentAccountsSettingSchema.shape.threshold.safeParse(Number(threshold));
    if (value.success) onChange({ ...setting, threshold: value.data });
    else setThreshold(String(setting.threshold));
  };
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="font-extrabold">Auto-switch accounts</div>
          <div className="text-xs text-neutral-700">
            When the active account reaches {setting.threshold}% of its usage window, the session moves to the next
            account with headroom. Context carries over.
          </div>
        </div>
        <label className="flex items-center gap-1 font-mono text-xs">
          <input
            aria-label="Auto-switch threshold"
            type="number"
            min={50}
            max={100}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            onBlur={commitThreshold}
            onKeyDown={(event) => event.key === 'Enter' && commitThreshold()}
            className="w-14 border-[1.5px] border-text bg-bg px-1.5 py-1 text-right text-text"
          />
          %
        </label>
        <Toggle
          label="Auto-switch accounts"
          checked={setting.auto_switch}
          onChange={(auto_switch) => onChange({ ...setting, auto_switch })}
        />
      </div>
      <div className="flex items-center gap-3 border-t border-neutral-300 pt-3">
        <div className="flex-1">
          <div className="font-extrabold">Smart usage</div>
          <div className="text-xs text-neutral-700">
            Uses the account whose weekly quota would otherwise go unused first: weekly % left ÷ days until weekly
            reset. Accounts with a full 5-hour window are skipped.
          </div>
        </div>
        <Toggle
          label="Smart usage"
          checked={setting.smart_usage}
          onChange={(smart_usage) => onChange({ ...setting, smart_usage })}
        />
      </div>
    </>
  );
}

const DEFAULTS: {
  key: keyof SessionDefaults;
  label: string;
  description: string;
  options: typeof MODELS | typeof EFFORTS | typeof ACCESS_MODES;
}[] = [
  { key: 'model', label: 'Default model', description: 'Model new sessions start with.', options: MODELS },
  { key: 'effort', label: 'Default effort', description: 'How much the agent thinks before acting.', options: EFFORTS },
  {
    key: 'access_mode',
    label: 'Default access',
    description: 'What the agent may do without asking. A PROD write always asks.',
    options: ACCESS_MODES,
  },
];

/** Settings › Agents: Claude accounts and their usage, Auto-switch, Smart usage and the defaults for new Sessions. */
export function AgentsTab() {
  const accounts = useAgentAccounts();
  const settings = useAgentSettings();
  const patch = usePatchSettings();
  const activate = useActivateAccount();

  if (accounts.isPending || settings.isPending) return <Empty>Loading agents…</Empty>;
  if (accounts.isError || settings.isError) {
    return (
      <div className="flex items-center gap-3 px-6 py-5 text-[13px]">
        <span role="alert">Could not load the Claude accounts.</span>
        <Button
          className="px-2.5 py-1 text-xs"
          onClick={() => {
            void accounts.refetch();
            void settings.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  const { data: list, meta } = accounts.data;
  const setting = settings.data.data.agent_accounts;
  const defaults = settings.data.data.session_defaults;
  const pick = list.length > 1 ? meta.smart_pick : null;
  const pickLabel = list.find((account) => account.id === pick?.account_id)?.label;

  return (
    <div className="text-sm">
      <div className="flex flex-col gap-3 border-b border-divider px-5 py-4">
        <Switches
          key={setting.threshold}
          setting={setting}
          onChange={(next) => patch.mutate({ agent_accounts: next })}
        />
        {(patch.isError || activate.isError) && (
          <div role="alert" className="text-xs text-accent-700">
            {(patch.error ?? activate.error)?.message}
          </div>
        )}
        {pick && (
          <div className="flex items-center gap-3 bg-accent-100 px-3 py-2.5 text-xs text-accent-900">
            <span className="flex-1">
              <strong className="font-mono">{pickLabel}</strong> is the smart pick: {pick.reason}.
            </span>
            <Button variant="primary" className="px-2.5 py-1 text-xs" onClick={() => activate.mutate(pick.account_id)}>
              Use
            </Button>
          </div>
        )}
      </div>

      <div className="px-5 pt-4 pb-1 font-extrabold">Defaults for new sessions</div>
      <div className="px-5 pb-2 text-xs text-neutral-700">
        Every new Workspace session starts with these. You can still change them per session from the composer.
      </div>
      {DEFAULTS.map((row) => (
        <div key={row.key} className="flex items-center gap-3 border-t border-neutral-300 px-5 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="font-bold">{row.label}</div>
            <div className="text-xs text-neutral-700">{row.description}</div>
          </div>
          <Dropdown
            label={row.label}
            value={defaults[row.key]}
            options={row.options as { value: string; label: string; description: string }[]}
            onChange={(value) =>
              patch.mutate({ session_defaults: { ...defaults, [row.key]: value } as SessionDefaults })
            }
            className="w-48"
          />
        </div>
      ))}

      <div className="mt-2 border-t-2 border-divider px-5 pt-4 pb-1.5 text-[11px] tracking-[0.08em] text-neutral-700 uppercase">
        Claude Code accounts
      </div>
      <ul aria-label="Claude Code accounts" className="m-0 list-none p-0">
        {list.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            isPick={account.id === pick?.account_id}
            onUse={() => activate.mutate(account.id)}
          />
        ))}
      </ul>
      <div className="border-t border-divider px-5 py-3">
        <AddAccount />
      </div>

      <div className="border-t-2 border-divider px-5 pt-3 pb-1.5 text-[11px] tracking-[0.08em] text-neutral-700 uppercase">
        Other agents
      </div>
      <div className="flex items-center gap-3 border-t border-divider px-5 py-3 opacity-60">
        <div className="flex-1">
          <strong>OpenAI · Codex CLI</strong>
          <div className="text-xs text-neutral-700">Same MCP servers and dev tools, separate usage pool.</div>
        </div>
        <span className="border border-divider px-2 py-0.5 text-[11px] font-semibold">Coming later</span>
      </div>
    </div>
  );
}
