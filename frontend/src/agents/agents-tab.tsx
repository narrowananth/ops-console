import {
  type AgentAccountsSetting,
  agentAccountsSettingSchema,
  type ClaudeAccount,
  type SessionDefaults,
} from '@ops-console/shared';
import { useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { Dropdown } from '../components/ui/dropdown';
import { Empty } from '../components/ui/empty';
import { Toggle } from '../components/ui/toggle';
import {
  useActivateAccount,
  useAddAccount,
  useAgentAccounts,
  useAgentSettings,
  useCancelLogin,
  useLogout,
  usePatchSettings,
  useRemoveAccount,
  useStartLogin,
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
  pct: number | null;
  resetsAt: string | null;
  accentAt: number;
}) {
  const hot = pct !== null && pct >= accentAt;
  return (
    <div className="grid grid-cols-[48px_minmax(0,1fr)_160px] items-center gap-2.5">
      <span className="text-[11px] text-neutral-700">{label}</span>
      <span className="block h-1.5 bg-neutral-300" aria-hidden>
        <span
          className={`block h-1.5 ${hot ? 'bg-accent' : 'bg-text'}`}
          style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
        />
      </span>
      <span className={`font-mono text-[11px] ${hot ? 'text-accent-700' : 'text-neutral-800'}`}>
        {pct === null ? 'no usage yet' : `${Math.round(pct)}% · ${resetsIn(resetsAt)}`}
      </span>
    </div>
  );
}

function AccountRow({
  account,
  number,
  isPick,
  onUse,
}: {
  account: ClaudeAccount;
  number: number;
  isPick: boolean;
  onUse: () => void;
}) {
  const login = useStartLogin();
  const cancel = useCancelLogin();
  const logout = useLogout();
  const remove = useRemoveAccount();
  const error = login.error ?? cancel.error ?? logout.error ?? remove.error;
  const startLogin = () => login.mutate(account.id);
  const current = account.is_active && account.signed_in;
  return (
    <li
      aria-label={account.label}
      className={`grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-divider px-5 py-3 ${
        current ? 'bg-neutral-200' : ''
      }`}
    >
      <span className="font-mono text-[11px] text-neutral-700">{String(number).padStart(2, '0')}</span>
      <div className="flex min-w-0 flex-col gap-1.25">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="font-mono text-[13px]">{account.label}</strong>
          {account.plan && <span className="text-xs text-neutral-700">{account.plan}</span>}
          {current && <span className="bg-text px-1.5 py-px text-[10px] font-extrabold text-bg">ACTIVE</span>}
          {isPick && (
            <span className="border-[1.5px] border-accent px-1.5 py-px text-[10px] font-extrabold text-accent-700">
              SMART PICK
            </span>
          )}
        </div>
        {!account.signed_in ? (
          <div className="text-xs text-neutral-700">
            {account.signing_in ? 'Finish signing in with Anthropic in your browser.' : 'Not signed in.'}
          </div>
        ) : (
          <>
            <UsageBar label="5-hour" pct={account.five_hour_pct} resetsAt={account.five_hour_resets_at} accentAt={90} />
            <UsageBar label="Weekly" pct={account.weekly_pct} resetsAt={account.weekly_resets_at} accentAt={80} />
          </>
        )}
        {error && (
          <div role="alert" className="text-xs text-accent-700">
            {error.message}
          </div>
        )}
        {account.signed_in && (
          <div className="text-[11px] text-neutral-700">
            {[account.smart_note, account.usage_seen_at && `usage seen ${ago(account.usage_seen_at)}`]
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {account.signing_in ? (
          <>
            <Button className="px-2.5 py-1 text-xs" disabled={login.isPending} onClick={startLogin}>
              Re-login
            </Button>
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(account.id)}
            >
              Cancel
            </Button>
          </>
        ) : !account.signed_in ? (
          <Button variant="primary" className="px-2.5 py-1 text-xs" disabled={login.isPending} onClick={startLogin}>
            Sign in
          </Button>
        ) : (
          <>
            {!current && (
              <Button className="px-2.5 py-1 text-xs" onClick={onUse}>
                Use
              </Button>
            )}
            <Button className="px-2.5 py-1 text-xs" disabled={login.isPending} onClick={startLogin}>
              Re-login
            </Button>
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={logout.isPending}
              onClick={() => logout.mutate(account.id)}
            >
              Log out
            </Button>
          </>
        )}
        {!account.signing_in && (
          <Button
            icon
            className="size-7 text-neutral-700 hover:text-accent-700"
            aria-label={`Remove ${account.label}`}
            title="Remove account"
            disabled={remove.isPending}
            onClick={() => remove.mutate(account.id)}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6" />
            </svg>
          </Button>
        )}
      </div>
    </li>
  );
}

/** Adds an account and starts its sign-in; the account is labelled with its email once it signs in. */
function AddAccount({ primary = false }: { primary?: boolean }) {
  const add = useAddAccount();
  const login = useStartLogin();
  return (
    <div className="flex items-center gap-2">
      <Button
        variant={primary ? 'primary' : 'ghost'}
        disabled={add.isPending}
        onClick={() => add.mutate(undefined, { onSuccess: ({ data }) => login.mutate(data.account.id) })}
      >
        + Add Claude account
      </Button>
      {add.isError && <span className="text-xs text-accent-700">Could not add the account.</span>}
    </div>
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
  // Blur on the threshold and a click on a switch land before React re-renders; the click must not send the old threshold.
  const latest = useRef(setting);
  latest.current = setting;
  const save = (change: Partial<AgentAccountsSetting>) => {
    latest.current = { ...latest.current, ...change };
    onChange(latest.current);
  };
  const commitThreshold = () => {
    const value = agentAccountsSettingSchema.shape.threshold.safeParse(Number(threshold));
    if (value.success) save({ threshold: value.data });
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
        {setting.auto_switch && (
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
        )}
        <Toggle
          label="Auto-switch accounts"
          checked={setting.auto_switch}
          onChange={(auto_switch) => save({ auto_switch })}
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
        <Toggle label="Smart usage" checked={setting.smart_usage} onChange={(smart_usage) => save({ smart_usage })} />
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
  // Nothing below the account list means anything until one Claude account is signed in.
  const ready = list.some((account) => account.signed_in);

  if (list.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 px-5 py-8 text-sm">
        <div className="font-extrabold">No Claude account yet</div>
        <div className="text-xs text-neutral-700">
          Add a Claude account to run agents. Signing in opens Anthropic in your browser. The usage and session settings
          appear once an account is signed in.
        </div>
        <AddAccount primary />
      </div>
    );
  }

  return (
    <div className="text-sm">
      {!ready && (
        <div className="border-b border-divider bg-accent-100 px-5 py-4 text-accent-900">
          <div className="font-extrabold">Sign in to a Claude account</div>
          <div className="text-xs">
            The agent runs under a Claude account. Sign in below; the settings appear once one account is signed in.
          </div>
        </div>
      )}
      {ready && (
        <>
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
              <div className="bg-accent-100 px-3 py-2.5 text-xs text-accent-900">
                <strong className="font-mono">{pickLabel}</strong> is the smart pick: {pick.reason}. It is used
                automatically; turn Smart usage off to stop that.
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
        </>
      )}

      <div
        className={`${ready ? 'mt-2 border-t-2' : ''} border-divider px-5 pt-4 pb-1.5 text-[11px] tracking-[0.08em] text-neutral-700 uppercase`}
      >
        Claude Code accounts
      </div>
      <ul aria-label="Claude Code accounts" className="m-0 list-none p-0">
        {list.map((account, index) => (
          <AccountRow
            key={account.id}
            number={index + 1}
            account={account}
            isPick={account.id === pick?.account_id}
            onUse={() => activate.mutate(account.id)}
          />
        ))}
      </ul>
      <div className="border-t border-divider px-5 py-3">
        <AddAccount />
      </div>
    </div>
  );
}
