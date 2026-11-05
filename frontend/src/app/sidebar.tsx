import { AlertStatus, type ClaudeAccount, CliProxyStatus, HealthStatus } from '@ops-console/shared';
import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  useAgentAccounts,
  useAlerts,
  useCliProxy,
  useConnections,
  useConnectors,
  useMcpServers,
  useRepos,
} from '../lib/queries';
import { shown } from '../monitor/scan-scope';
import { lastAddress } from './last-address';
import { RunningTasks } from './running-tasks';
import { useUi } from './ui-store';
import { UpdateCard, VersionLine } from './updates';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Ops Console logo"
      className="block flex-none rounded-[22%]"
    >
      <rect width="32" height="32" className="fill-accent" />
      <path d="M8 9.5l7 6.5-7 6.5" fill="none" className="stroke-white" strokeWidth="3.2" strokeLinecap="square" />
      <rect x="17" y="20" width="8" height="3.2" className="fill-white" />
      <rect x="25" y="4" width="3" height="3" className="fill-white" />
    </svg>
  );
}

const icon = (path: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    {path}
  </svg>
);

const ICONS = {
  monitor: icon(<path d="M3 12h4l3-8 4 16 3-8h4" />),
  workspace: icon(
    <>
      <rect x="3" y="4" width="18" height="16" />
      <path d="M3 9h18M9 9v11" />
    </>,
  ),
  devtools: icon(
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>,
  ),
  integrations: icon(<path d="M9 7V3M15 7V3M7 7h10v5a5 5 0 0 1-10 0zM12 17v4" />),
  connections: icon(<path d="M4 7h16M4 12h16M4 17h10" />),
  repos: icon(
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 8v8M18 10c0 4-6 3-10 7" />
    </>,
  ),
  setup: icon(<path d="M4 17l6-5-6-5M12 19h8" />),
  permissions: icon(
    <>
      <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </>,
  ),
  agents: icon(
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </>,
  ),
  playbooks: icon(
    <>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M9 10h6M9 14h6M9 18h3" />
    </>,
  ),
  skills: icon(<path d="M12 3l2.4 5.6L20 10l-4.2 3.8L17 20l-5-3-5 3 1.2-6.2L4 10l5.6-1.4z" />),
};

/** Where every view lives, in sidebar order. */
export const PAGES = [
  { group: 'Operate', path: '/monitor', label: 'Monitor', icon: ICONS.monitor },
  { group: 'Operate', path: '/workspace', label: 'Workspace', icon: ICONS.workspace },
  { group: 'Operate', path: '/devtools', label: 'Dev tools', icon: ICONS.devtools },
  { group: 'Connect', path: '/integrations', label: 'Integrations', icon: ICONS.integrations },
  { group: 'Connect', path: '/connections', label: 'Connections', icon: ICONS.connections },
  { group: 'Connect', path: '/repos', label: 'Repos', icon: ICONS.repos },
  { group: 'Connect', path: '/setup', label: 'Setup agent', icon: ICONS.setup },
  { group: 'Connect', path: '/permissions', label: 'Permissions', icon: ICONS.permissions },
  { group: 'Claude', path: '/agents', label: 'Agents & accounts', icon: ICONS.agents },
  { group: 'Claude', path: '/playbooks', label: 'Playbooks', icon: ICONS.playbooks },
  { group: 'Claude', path: '/skills', label: 'Skills', icon: ICONS.skills },
] as const;

const NEEDS_ATTENTION: HealthStatus[] = [HealthStatus.Auth, HealthStatus.Fail];

/** The badge after a sidebar item: what is waiting there. */
function useBadges(): Record<string, { text: string; tip: string; tone: 'alert' | 'attention' | 'count' } | undefined> {
  const alerts = useAlerts().data ?? [];
  const connectors = useConnectors().data?.data ?? [];
  const servers = useMcpServers().data?.data ?? [];
  const connections = useConnections().data?.data;
  const repos = useRepos().data?.data;
  const open = alerts.filter(
    (alert) => alert.status !== AlertStatus.Resolved && alert.status !== AlertStatus.Dismissed && shown(alert),
  ).length;
  const attention =
    connectors.filter((connector) => NEEDS_ATTENTION.includes(connector.status)).length +
    servers.filter((server) => server.used_by === null && NEEDS_ATTENTION.includes(server.status)).length;
  return {
    '/monitor':
      open > 0 ? { text: String(open), tip: `${open} Alerts not yet resolved or dismissed`, tone: 'alert' } : undefined,
    '/integrations':
      attention > 0
        ? { text: String(attention), tip: `${attention} need you: sign in again or reconnect`, tone: 'attention' }
        : undefined,
    '/connections': connections?.length
      ? { text: String(connections.length), tip: `${connections.length} Connections`, tone: 'count' }
      : undefined,
    '/repos': repos?.length
      ? { text: String(repos.length), tip: `${repos.length} imported Repos`, tone: 'count' }
      : undefined,
  };
}

const BADGE = {
  alert: 'rounded-full bg-accent px-1.75 text-white',
  attention: 'rounded-full bg-accent-100 px-1.75 text-accent-700',
  count: 'text-neutral-700',
};

/** The left sidebar: every view, the active Claude account's usage, the theme and collapse buttons. */
export function Sidebar() {
  const { theme, toggleTheme, collapsed, toggleCollapsed } = useUi();
  const badges = useBadges();
  const groups = [...new Set(PAGES.map((page) => page.group))];
  // Each link goes back to its page's last address; moving re-reads them.
  useLocation();
  return (
    <aside
      className={`flex min-h-0 flex-none font-brand flex-col border-r border-line bg-surface transition-[width] duration-200 ${
        collapsed ? 'w-17' : 'w-62'
      }`}
    >
      <div className={`flex h-17 flex-none items-center gap-2.5 ${collapsed ? 'justify-center' : 'px-5'}`}>
        <Logo />
        {!collapsed && <div className="font-brand text-[17px] font-extrabold tracking-[-0.02em]">Ops Console</div>}
      </div>
      <nav aria-label="Ops Console" className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        {groups.map((group) => (
          <div key={group}>
            <div
              className={`px-2.5 pt-4.5 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-neutral-700 uppercase ${
                collapsed ? 'text-center' : ''
              }`}
            >
              {collapsed ? '·' : group}
            </div>
            {PAGES.filter((page) => page.group === group).map((page) => {
              const badge = badges[page.path];
              return (
                <NavLink
                  key={page.path}
                  to={lastAddress(page.path)}
                  title={collapsed ? page.label : undefined}
                  aria-label={page.label}
                  className={({ isActive }) =>
                    `group my-px flex items-center gap-2.75 rounded-md py-2.25 text-sm text-text no-underline transition-[background-color,box-shadow] duration-150 hover:text-text ${
                      collapsed ? 'justify-center px-0' : 'px-3'
                    } ${isActive ? 'bg-card font-extrabold shadow-sm' : 'hover:bg-text/6'}`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className={isActive ? 'text-accent' : 'opacity-70'}>{page.icon}</span>
                      {!collapsed && <span className="min-w-0 flex-1 truncate">{page.label}</span>}
                      {!collapsed && badge && (
                        <span
                          title={badge.tip}
                          className={`min-w-5 text-center font-mono text-[11px] font-semibold ${BADGE[badge.tone]}`}
                        >
                          {badge.text}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="flex flex-none flex-col gap-3 p-3.5">
        <RunningTasks collapsed={collapsed} />
        {!collapsed && <UpdateCard />}
        {!collapsed && <ActiveAccount />}
        <div className={`flex gap-2 ${collapsed ? 'flex-col' : ''}`}>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className={footButton}
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
              {theme === 'dark' ? (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </>
              ) : (
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
              )}
            </svg>
            {!collapsed && (theme === 'dark' ? 'Light' : 'Dark')}
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={footButton}
          >
            {collapsed ? '⟩' : '⟨ Collapse'}
          </button>
        </div>
        <VersionLine collapsed={collapsed} />
      </div>
    </aside>
  );
}

const footButton =
  'inline-flex h-8.5 flex-1 cursor-pointer items-center justify-center gap-1.5 border border-line bg-card px-2.5 text-xs text-text transition-colors hover:bg-neutral-200';

/** The account Sessions run on now, with its 5-hour and weekly usage; opens Agents & accounts. */
function ActiveAccount() {
  const accounts = useAgentAccounts().data?.data ?? [];
  const hub = useCliProxy().data?.data;
  if (hub?.enabled) {
    const connected = hub.status === CliProxyStatus.Connected;
    return (
      <NavLink
        to="/agents"
        aria-label="Claude account hub"
        title="CLIProxy signs the agent in to Claude and tracks the quota. Opens Agents & accounts."
        className="flex items-center justify-between gap-2 rounded-lg border border-line bg-card px-3.5 py-3 text-xs text-text no-underline shadow-sm hover:text-text"
      >
        <span className="font-mono font-semibold">CLIProxy</span>
        <span className={`flex items-center gap-1.5 ${connected ? 'text-ok' : 'text-accent-700'}`}>
          <span aria-hidden className={`size-1.5 rounded-full ${connected ? 'bg-ok' : 'bg-accent'}`} />
          {connected ? 'connected' : hub.status.replace('_', ' ')}
        </span>
      </NavLink>
    );
  }
  const active = accounts.find((account) => account.is_active) ?? accounts.find((account) => account.signed_in);
  if (!active) return null;
  return (
    <NavLink
      to="/agents"
      aria-label="Active Claude account"
      title="The Claude account the agent runs under, and how much of its usage is used. Opens Agents & accounts."
      className="block rounded-lg border border-line bg-card px-3.5 py-3 text-xs text-text no-underline shadow-sm hover:text-text"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs font-semibold">{active.email ?? active.label}</span>
        <span className="rounded-full bg-ok/12 px-2 py-px text-[9.5px] font-extrabold tracking-[0.06em] text-ok">
          ACTIVE
        </span>
      </div>
      <Usage label="5-hour" pct={active.five_hour_pct} />
      <Usage label="Weekly" pct={active.weekly_pct} />
    </NavLink>
  );
}

function Usage({ label, pct }: { label: string; pct: ClaudeAccount['five_hour_pct'] }) {
  return (
    <div className="mt-1.5 grid grid-cols-[52px_1fr_34px] items-center gap-2 text-[11px] text-neutral-700">
      <span>{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-neutral-300">
        <span className="block h-full rounded-full bg-text" style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span className="text-right font-mono">{pct === null ? '–' : `${Math.round(pct)}%`}</span>
    </div>
  );
}
