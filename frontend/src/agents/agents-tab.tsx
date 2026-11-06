import {
  type AgentAccountsSetting,
  agentAccountsSettingSchema,
  type ClaudeAccount,
  type SessionDefaults,
  SignInVia,
} from '@ops-console/shared';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useDesktopAlerts } from '../agent-runs/alerts';
import { Section } from '../app/page';
import { BrandIcon } from '../components/ui/brand-icon';
import { Button } from '../components/ui/button';
import { Dropdown } from '../components/ui/dropdown';
import { Empty } from '../components/ui/empty';
import { Toggle } from '../components/ui/toggle';
import { CHIME_KEY, chimeSchema, DEFAULT_VOLUME, playChime, unlockChime, VOLUME_KEY, volumeSchema } from '../lib/chime';
import {
  useActivateAccount,
  useAddAccount,
  useAgentAccounts,
  useAgentSettings,
  useCancelLogin,
  useCliProxy,
  useLogout,
  usePatchSettings,
  useRemoveAccount,
  useStartLogin,
} from '../lib/queries';
import { useAddress, useStored } from '../lib/remember';
import { ascending } from '../lib/sort';
import { AccountSwitch, AllDisabledBanner, allDisabled, successorOf } from './account-switch';
import { AccountUsageView } from './account-usage-view';
import { CliProxyHub } from './cliproxy-hub';
import { ACCESS_MODES, EFFORTS, MODELS } from './options';
import { SignInLinkDialog } from './sign-in-link-dialog';
import { ago, UsageBar } from './usage-bar';

function AccountRow({
  account,
  number,
  isPick,
  successor,
  proxied,
  onUse,
  onShowLink,
}: {
  account: ClaudeAccount;
  number: number;
  isPick: boolean;
  /** The account runs move to when this one, if it is active, is disabled. */
  successor: ClaudeAccount | null;
  proxied: boolean;
  onUse: () => void;
  onShowLink: () => void;
}) {
  const login = useStartLogin();
  const cancel = useCancelLogin();
  const logout = useLogout();
  const remove = useRemoveAccount();
  const error = login.error ?? cancel.error ?? logout.error ?? remove.error;
  const startLogin = () => login.mutate({ id: account.id });
  const current = account.is_active && account.signed_in;
  return (
    <li
      aria-label={account.label}
      className={`grid grid-cols-[24px_auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-4 ${current ? 'bg-ok/5' : ''}`}
    >
      <span className="font-mono text-xs text-neutral-700">{String(number).padStart(2, '0')}</span>
      <BrandIcon brand="claude" />
      <div className={`flex min-w-0 flex-col gap-1.25 ${account.enabled ? '' : 'opacity-55'}`}>
        <div className="flex flex-wrap items-center gap-2">
          <strong className="font-mono text-[13px]">{account.label}</strong>
          {account.plan && <span className="text-xs text-neutral-700">{account.plan}</span>}
          {current && (
            <span
              title="The agent runs under this account now"
              className="rounded-full bg-ok/12 px-2 py-px text-xs font-semibold text-ok"
            >
              ACTIVE
            </span>
          )}
          {!account.enabled && (
            <span
              title="Agents never use this account: Use, Smart pick and failover skip it"
              className="rounded-full bg-neutral-200 px-2 py-px text-xs font-semibold text-neutral-700"
            >
              DISABLED
            </span>
          )}
          {isPick && (
            <span
              title="Smart usage ranks this account first: it has the most weekly quota left per day until its reset"
              className="rounded-full bg-accent-100 px-2 py-px text-xs font-semibold text-accent-700"
            >
              SMART PICK
            </span>
          )}
        </div>
        {!account.signed_in ? (
          <div className="text-xs text-neutral-700">
            {account.sign_in_link
              ? 'Waiting for a sign-in through the link.'
              : account.signing_in
                ? 'Finish signing in with Anthropic in your browser.'
                : 'Not signed in.'}
          </div>
        ) : (
          <>
            <UsageBar
              label="5-hour"
              tip="How much of this account's 5-hour usage window is used. It empties again at the reset."
              pct={account.five_hour_pct}
              resetsAt={account.five_hour_resets_at}
              accentAt={90}
            />
            <UsageBar
              label="Weekly"
              tip="How much of this account's weekly usage is used. It empties again at the weekly reset."
              pct={account.weekly_pct}
              resetsAt={account.weekly_resets_at}
              accentAt={80}
            />
          </>
        )}
        {error && (
          <div role="alert" className="text-xs text-accent-700">
            {error.message}
          </div>
        )}
        {account.signed_in && (
          <div className="text-xs text-neutral-700">
            {account.enabled
              ? [account.smart_note, account.usage_seen_at && `usage seen ${ago(account.usage_seen_at)}`]
                  .filter(Boolean)
                  .join(' · ')
              : 'Disabled: skipped by Use, Smart pick and failover. Runs going on it finish.'}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-1.5">
          {account.signing_in ? (
            <>
              {account.sign_in_link ? (
                <Button
                  className="px-3 py-1.25 text-xs"
                  title="Show the sign-in link and the box for the code Anthropic shows"
                  onClick={onShowLink}
                >
                  Show link
                </Button>
              ) : (
                <Button className="px-3 py-1.25 text-xs" disabled={login.isPending} onClick={startLogin}>
                  Re-login
                </Button>
              )}
              <Button
                className="px-3 py-1.25 text-xs"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(account.id)}
              >
                Cancel
              </Button>
            </>
          ) : !account.signed_in ? (
            <Button variant="primary" className="px-3 py-1.25 text-xs" disabled={login.isPending} onClick={startLogin}>
              Sign in
            </Button>
          ) : (
            <>
              {!current && (
                <Button
                  className="px-3 py-1.25 text-xs"
                  title={
                    account.enabled
                      ? 'Make this the active account. The agent runs under it from now on.'
                      : 'Enable this account first'
                  }
                  disabled={!account.enabled}
                  onClick={onUse}
                >
                  Use
                </Button>
              )}
              <Button
                className="px-3 py-1.25 text-xs"
                title="Sign in to this account again, in your browser"
                disabled={login.isPending}
                onClick={startLogin}
              >
                Re-login
              </Button>
              <Button
                className="px-3 py-1.25 text-xs"
                title="Sign this account out. It stays in the list so you can sign in again."
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
              title="Remove this account from the console. You can add it again later."
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
        {!account.signing_in && (
          <AccountSwitch account={account} current={current} successor={successor} proxied={proxied} />
        )}
      </div>
    </li>
  );
}

/**
 * The two ways to add an account; each adds it and starts its sign-in, and the account is labelled with its email once
 * it signs in. In this browser: Anthropic's page opens in a tab on this Mac. By sign-in link: a link to open in any
 * browser, and the code Anthropic shows there pasted back, in `SignInLinkDialog`.
 */
function AddAccount({ primary = false, onLink }: { primary?: boolean; onLink: (id: string) => void }) {
  const add = useAddAccount();
  const login = useStartLogin();
  const start = (via: SignInVia) =>
    add.mutate(undefined, {
      onSuccess: ({ data }) =>
        login.mutate(
          { id: data.account.id, via },
          { onSuccess: () => via === SignInVia.Link && onLink(data.account.id) },
        ),
    });
  return (
    <div className="flex items-center gap-2">
      {add.isError && <span className="text-xs text-accent-700">Could not add the account.</span>}
      <Button
        disabled={add.isPending}
        title="Get a link to sign in from any browser, yours or someone else's, then paste back the code Anthropic shows"
        onClick={() => start(SignInVia.Link)}
      >
        + Add by sign-in link
      </Button>
      <Button
        variant={primary ? 'primary' : 'secondary'}
        disabled={add.isPending}
        title="Open Anthropic's sign-in in a browser tab on this Mac"
        onClick={() => start(SignInVia.Browser)}
      >
        + Add in this browser
      </Button>
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
      <div className="flex items-center gap-4 px-5 py-4">
        <div className="flex-1">
          <div className="font-semibold">Auto-switch accounts</div>
          <div className="text-xs text-neutral-700">
            When the active account reaches {setting.threshold}% of its usage window, the session moves to the next
            account with headroom. Context carries over.
          </div>
        </div>
        {setting.auto_switch && (
          <label className="flex items-center gap-1 font-mono text-xs">
            <input
              aria-label="Auto-switch threshold"
              title="At this share of the 5-hour window, Sessions move to the next account. 50 to 100."
              type="number"
              min={50}
              max={100}
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
              onBlur={commitThreshold}
              onKeyDown={(event) => event.key === 'Enter' && commitThreshold()}
              className="w-16 border border-divider bg-card px-2 py-1.25 text-right text-text"
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
      <div className="flex items-center gap-4 border-t border-line px-5 py-4">
        <div className="flex-1">
          <div className="font-semibold">Smart usage</div>
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

const DEFAULT_ICONS: Record<keyof SessionDefaults, ReactNode> = {
  model: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
    </>
  ),
  effort: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  access_mode: (
    <>
      <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
};

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

/** Greyed and out of reach, keyboard included, while CLIProxy manages the accounts. */
function Paused({ paused, children }: { paused: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.toggleAttribute('inert', paused);
  }, [paused]);
  return (
    <div
      ref={box}
      aria-disabled={paused || undefined} // The Section inside is its last child and drops its margin; the wrapper keeps the gap to the next one.
      className={`mb-8 last:mb-0 ${paused ? 'opacity-45 grayscale select-none' : ''}`}
    >
      {children}
    </div>
  );
}

const TABS = [
  { id: 'accounts', label: 'Accounts', icon: <PersonIcon /> },
  { id: 'usage', label: 'Usage', icon: <BarsIcon /> },
] as const;

function PersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  );
}

function BarsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}

/** Accounts & Usage: the Claude accounts with their Enable switch, and what each account's credit was spent on. */
export function AgentsTab() {
  const [address, setAddress] = useAddress('tab', 'account', 'range');
  const accounts = useAgentAccounts();
  const tab = address.tab === 'usage' ? 'usage' : 'accounts';
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const { hash } = useLocation();
  // A link to `#notifications` means the Accounts tab, where that section is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the address gains the hash, not on every tab change
  useEffect(() => {
    if (hash === '#notifications' && address.tab !== null)
      setAddress({ tab: null, account: null, range: null }, { replace: true });
  }, [hash]);
  const pick = (id: (typeof TABS)[number]['id']) =>
    setAddress({ tab: id === 'accounts' ? null : id, account: null, range: null });
  // Arrow keys move between the tabs, Home and End go to the first and last, and focus follows.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((one) => one.id === tab);
    const to =
      event.key === 'ArrowRight'
        ? (at + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + TABS.length) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
              : -1;
    const next = TABS[to];
    if (!next) return;
    event.preventDefault();
    pick(next.id);
    buttons.current[next.id]?.focus();
  };
  return (
    <div className="text-sm">
      <div
        role="tablist"
        aria-label="Account and usage"
        onKeyDown={onKeyDown}
        className="mb-6 flex w-max gap-1 rounded-xl bg-neutral-200 p-1"
      >
        {TABS.map((one) => (
          <button
            key={one.id}
            ref={(node) => {
              buttons.current[one.id] = node;
            }}
            type="button"
            role="tab"
            id={`agents-tab-${one.id}`}
            aria-selected={tab === one.id}
            aria-controls="agents-panel"
            tabIndex={tab === one.id ? 0 : -1}
            onClick={() => pick(one.id)}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border-0 px-5 py-2 text-[13px] transition-colors ${
              tab === one.id
                ? 'bg-card font-bold text-text shadow-md'
                : 'bg-transparent font-semibold text-neutral-700 hover:text-text'
            }`}
          >
            <span className={tab === one.id ? 'text-accent' : ''}>{one.icon}</span>
            {one.label}
            {one.id === 'accounts' && accounts.data && (
              <span className="rounded-full bg-neutral-300 px-1.75 py-px font-mono text-[10px] font-semibold text-neutral-800">
                {accounts.data.data.length}
              </span>
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="agents-panel" aria-labelledby={`agents-tab-${tab}`}>
        {tab === 'usage' ? (
          <AccountUsageView
            account={address.account}
            range={address.range}
            onChange={(next) => setAddress(next, { replace: true })}
            onOpenAccounts={() => setAddress({ tab: null, account: null, range: null })}
          />
        ) : (
          <AccountsPane />
        )}
      </div>
    </div>
  );
}

/** The Claude accounts, Auto-switch, Smart usage and the defaults for new Sessions. */
function AccountsPane() {
  const accounts = useAgentAccounts();
  const settings = useAgentSettings();
  const hub = useCliProxy();
  const patch = usePatchSettings();
  const activate = useActivateAccount();
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const { hash } = useLocation();
  const loaded = accounts.isSuccess && settings.isSuccess;
  // A link to `#notifications` lands on that section once the page has drawn it.
  useEffect(() => {
    if (hash !== '#notifications' || !loaded) return;
    const frame = requestAnimationFrame(() => document.getElementById('notifications')?.scrollIntoView());
    return () => cancelAnimationFrame(frame);
  }, [hash, loaded]);

  if (accounts.isPending || settings.isPending) return <Empty>Loading agents…</Empty>;
  if (accounts.isError || settings.isError) {
    return (
      <div className="flex items-center gap-3 px-6 py-5 text-[13px]">
        <span role="alert">Could not load the Claude accounts.</span>
        <Button
          className="px-3 py-1.25 text-xs"
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
  // CLIProxy picks the account and tracks the quota, so the accounts and their switching pause.
  const proxied = hub.data?.data.enabled ?? false;

  const accountList = (
    <ul aria-label="Claude Code accounts" className="m-0 list-none divide-y divide-line p-0">
      {ascending(list, (account) => account.label).map((account, index) => (
        <AccountRow
          key={account.id}
          number={index + 1}
          account={account}
          isPick={account.id === pick?.account_id}
          successor={successorOf(account, list, pick?.account_id)}
          proxied={proxied}
          onUse={() => activate.mutate(account.id)}
          onShowLink={() => setLinkFor(account.id)}
        />
      ))}
    </ul>
  );

  return (
    <div>
      {allDisabled(list) && !proxied && <AllDisabledBanner />}
      {hub.data && <CliProxyHub key={hub.data.data.address} hub={hub.data.data} />}
      {proxied && (
        <div
          role="status"
          className="mb-3 rounded-lg border border-accent-200 bg-accent-100 px-4 py-2.5 text-xs text-accent-900"
        >
          CLIProxy manages Claude accounts and quota now. Turn off Use CLIProxy to manage them here.
        </div>
      )}
      <Paused paused={proxied}>
        {list.length > 0 && !ready && !proxied && (
          <div className="mb-8 rounded-xl border border-accent-200 bg-accent-100 px-5 py-4 text-accent-900">
            <div className="font-semibold">Sign in to a Claude account</div>
            <div className="text-xs">
              The agent runs under a Claude account. Sign in below; the settings appear once one account is signed in.
            </div>
          </div>
        )}
        <Section
          title="Claude Code accounts"
          sub="The agent runs under one account at a time. Add in this browser opens Anthropic's sign-in here. Add by sign-in link gives a link to sign in from any browser, then takes the code Anthropic shows."
          aside={<AddAccount primary={!ready} onLink={setLinkFor} />}
        >
          {list.length === 0 ? (
            <div className="px-5 py-8 text-center text-xs text-neutral-700">
              No Claude account yet. Add one to run agents; the usage and session settings appear once it is signed in.
            </div>
          ) : (
            accountList
          )}
        </Section>
      </Paused>
      {linkFor !== null && (
        <SignInLinkDialog account={list.find((account) => account.id === linkFor)} onClose={() => setLinkFor(null)} />
      )}
      {ready && (
        <>
          <Paused paused={proxied}>
            <Section title="Account switching" sub="How the console moves sessions between your accounts.">
              <Switches
                key={setting.threshold}
                setting={setting}
                onChange={(next) => patch.mutate({ agent_accounts: next })}
              />
              {pick && (
                <div className="border-t border-line bg-accent-100 px-5 py-3 text-xs text-accent-900">
                  <strong className="font-mono">{pickLabel}</strong> is the smart pick: {pick.reason}. It is used
                  automatically; turn Smart usage off to stop that.
                </div>
              )}
              {(patch.isError || activate.isError) && (
                <div role="alert" className="border-t border-line px-5 py-3 text-xs text-accent-700">
                  {(patch.error ?? activate.error)?.message}
                </div>
              )}
            </Section>
          </Paused>
          <Section
            title="Defaults for new sessions"
            sub="Every agent the console starts begins with these: Workspace and Dev tools terminals, Monitor Verify and Fix, Agent Review, and the Setup agent. Change them for one session from its Model, Effort and Access chips."
          >
            <div className="divide-y divide-line">
              {DEFAULTS.map((row) => (
                <div key={row.key} className="flex items-center gap-4 px-5 py-4">
                  <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-accent-100 text-accent-700">
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      {DEFAULT_ICONS[row.key]}
                    </svg>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{row.label}</div>
                    <div className="text-xs text-neutral-700">{row.description}</div>
                  </div>
                  <Dropdown
                    label={row.label}
                    value={defaults[row.key]}
                    options={row.options as { value: string; label: string; description: string }[]}
                    onChange={(value) =>
                      patch.mutate({ session_defaults: { ...defaults, [row.key]: value } as SessionDefaults })
                    }
                    className="w-52"
                  />
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
      <NotificationsSection />
    </div>
  );
}

/** One row of Notifications: what it does, and the control that sets it. */
function NotifyRow({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        <div className="text-xs text-neutral-700">{text}</div>
      </div>
      {children}
    </div>
  );
}

/**
 * What this browser does when the agent is done: the chime and how loud it is, and the desktop alerts. Every choice is
 * kept per browser, like the theme.
 */
function NotificationsSection() {
  const [on, setOn] = useStored(CHIME_KEY, chimeSchema, true);
  const [volume, setVolume] = useStored(VOLUME_KEY, volumeSchema, DEFAULT_VOLUME);
  const alerts = useDesktopAlerts();
  const hear = () => {
    unlockChime();
    playChime('done', true);
  };
  return (
    <div id="notifications" className="scroll-mt-6">
      <Section title="Notifications" sub="What this browser does when the agent is done, or needs you.">
        <div className="divide-y divide-line">
          <NotifyRow
            title="Sound when the agent finishes"
            text="A soft two-note chime when a run you started ends: rising when it finished, falling when it failed. Monitor and pull request jobs stay quiet."
          >
            <Button className="px-3 py-1.25 text-xs" title="Hear the chime" onClick={hear}>
              Play
            </Button>
            <Toggle label="Sound when the agent finishes" checked={on} onChange={setOn} />
          </NotifyRow>
          <NotifyRow title="Volume" text="How loud the chime is. Release the slider to hear it.">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={volume}
              disabled={!on}
              aria-label="Volume"
              title={on ? `${volume}%` : 'Turn the sound on to set the volume'}
              onChange={(event) => setVolume(Number(event.target.value))}
              onPointerUp={hear}
              onKeyUp={hear}
              className="w-44 accent-accent disabled:cursor-default disabled:opacity-40"
            />
            <span className={`w-10 text-right font-mono text-xs ${on ? '' : 'opacity-40'}`}>{volume}%</span>
          </NotifyRow>
          <NotifyRow
            title="Alert when a run needs me"
            text="A desktop alert while this console is open in a tab you are not looking at."
          >
            <Toggle label="Alert when a run needs me" checked={alerts.needs} onChange={alerts.setNeeds} />
          </NotifyRow>
          <NotifyRow
            title="Alert when a run ends"
            text="A desktop alert when a run finishes, fails or stops, in a tab you are not looking at."
          >
            <Toggle label="Alert when a run ends" checked={alerts.ends} onChange={alerts.setEnds} />
          </NotifyRow>
          <NotifyRow
            title="Alert when a connection or integration breaks"
            text="A desktop alert when a Connection, Connector or MCP server stops working, and when it recovers."
          >
            <Toggle
              label="Alert when a connection or integration breaks"
              checked={alerts.health}
              onChange={alerts.setHealth}
            />
          </NotifyRow>
        </div>
        {alerts.refused && (
          <p role="alert" className="m-0 border-t border-line px-5 py-3 text-xs text-accent-700">
            The browser did not allow alerts. Allow notifications for this site in the browser, then turn this on again.
          </p>
        )}
      </Section>
    </div>
  );
}
