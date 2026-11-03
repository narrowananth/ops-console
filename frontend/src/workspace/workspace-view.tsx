import { SessionState } from '@ops-console/shared';
import { z } from 'zod';
import { Empty } from '../components/ui/empty';
import { PanelRail, PanelToggle, RAIL_BUTTON } from '../components/ui/side-panel';
import { useRepoSessions } from '../lib/queries';
import { useAddress, useStored } from '../lib/remember';
import { PullRequestView } from './pull-request-view';
import { PullRequestsPane } from './pull-requests-pane';
import { SessionView } from './session-view';
import { SessionsPane } from './sessions-pane';

type Tab = 'sessions' | 'pulls';

const TABS = [
  ['sessions', 'Sessions'],
  ['pulls', 'Pull requests'],
] as const;

const TAB_TIP: Record<Tab, string> = {
  sessions: 'Your conversations with the agent, grouped by Repo',
  pulls: 'Open pull requests on your Git hosts: review, comment, and let the agent review or address comments',
};

const NEEDS_YOU: SessionState[] = [SessionState.WaitingInput, SessionState.WaitingApproval];

/** `<repo id>/<number>` from the address. */
function parsePull(value: string | null): { repoId: string; number: number } | null {
  const at = value?.lastIndexOf('/') ?? -1;
  if (value === null || at < 1) return null;
  const number = Number(value.slice(at + 1));
  return Number.isInteger(number) && number > 0 ? { repoId: value.slice(0, at), number } : null;
}

export function WorkspaceView() {
  // The tab, Session and pull request live in the address, so a reload, Back, or a link from the Monitor opens them.
  const [address, setAddress] = useAddress('tab', 'session', 'pr');
  const tab: Tab = address.tab === 'pulls' ? 'pulls' : 'sessions';
  const setTab = (next: Tab) => setAddress({ tab: next === 'sessions' ? null : next });
  const sessionId = address.session;
  const setSessionId = (id: string | null) => setAddress({ session: id });
  const pull = parsePull(address.pr);
  const setPull = (next: { repoId: string; number: number } | null) =>
    setAddress({ pr: next ? `${next.repoId}/${next.number}` : null });

  const [collapsed, setCollapsed] = useStored('workspace.pane-collapsed', z.boolean(), false);

  return (
    <>
      {collapsed ? (
        <PaneRail
          tab={tab}
          onOpen={(next) => {
            if (next) setTab(next);
            setCollapsed(false);
          }}
        />
      ) : (
        <aside className="flex w-80 flex-none flex-col overflow-y-auto border-r border-line">
          <div className="mx-3 mt-3.5 mb-2 flex items-center gap-1.5">
            <div role="tablist" aria-label="Workspace" className="flex flex-1 gap-0.5 rounded-lg bg-neutral-200 p-1">
              {TABS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  title={TAB_TIP[id]}
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={`flex-1 cursor-pointer rounded-md border-0 px-3.5 py-1.5 text-center text-[13px] transition-colors ${tab === id ? 'bg-card font-semibold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <PanelToggle open onToggle={() => setCollapsed(true)} />
          </div>
          {tab === 'sessions' ? (
            <SessionsPane selected={sessionId} onSelect={setSessionId} />
          ) : (
            <PullRequestsPane selected={pull} onSelect={setPull} />
          )}
        </aside>
      )}
      <section className="min-w-0 flex-1 overflow-y-auto">
        {tab === 'sessions' ? (
          sessionId ? (
            <SessionView
              key={sessionId}
              id={sessionId}
              onGone={() => setAddress({ session: null }, { replace: true })}
            />
          ) : (
            <Empty>Pick a Session, or start one on a branch.</Empty>
          )
        ) : pull ? (
          <PullRequestView key={`${pull.repoId}#${pull.number}`} repoId={pull.repoId} number={pull.number} />
        ) : (
          <Empty>Pick a pull request.</Empty>
        )}
      </section>
    </>
  );
}

/**
 * The side panel folded to a strip: the arrow opens it again, and each tab's icon opens it on that tab. Sessions
 * waiting on the operator show as a count.
 */
function PaneRail({ tab, onOpen }: { tab: Tab; onOpen: (tab: Tab | null) => void }) {
  const sessions = useRepoSessions();
  const waiting = (sessions.data ?? []).filter((session) => NEEDS_YOU.includes(session.state)).length;
  return (
    <PanelRail label="Workspace panel">
      <PanelToggle open={false} onToggle={() => onOpen(null)} />
      <span aria-hidden className="my-1 h-px w-6 bg-line" />
      {TABS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-label={id === 'sessions' && waiting > 0 ? `${label}, ${waiting} waiting on you` : label}
          aria-current={tab === id ? 'page' : undefined}
          title={id === 'sessions' && waiting > 0 ? `${label}: ${waiting} waiting on you` : label}
          onClick={() => onOpen(id)}
          className={`relative ${RAIL_BUTTON} ${tab === id ? 'bg-card text-text shadow-sm' : ''}`}
        >
          {id === 'sessions' ? <SessionsIcon /> : <PullRequestIcon />}
          {id === 'sessions' && waiting > 0 && (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-accent px-1 text-center font-mono text-[9px] leading-3.5 font-semibold text-white"
            >
              {waiting}
            </span>
          )}
        </button>
      ))}
    </PanelRail>
  );
}

function SessionsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
    </svg>
  );
}

function PullRequestIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6" />
    </svg>
  );
}
