import { Empty } from '../components/ui/empty';
import { useAddress } from '../lib/remember';
import { PullRequestView } from './pull-request-view';
import { PullRequestsPane } from './pull-requests-pane';
import { SessionView } from './session-view';
import { SessionsPane } from './sessions-pane';

type Tab = 'sessions' | 'pulls';

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

  return (
    <>
      <aside className="flex w-80 flex-none flex-col overflow-y-auto border-r border-line">
        <div
          role="tablist"
          aria-label="Workspace"
          className="mx-3 mt-3.5 mb-2 flex gap-0.5 rounded-lg bg-neutral-200 p-1"
        >
          {(
            [
              ['sessions', 'Sessions'],
              ['pulls', 'Pull requests'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              title={
                id === 'sessions'
                  ? 'Your conversations with the agent, grouped by Repo'
                  : 'Open pull requests on your Git hosts: review, comment, and let the agent review or address comments'
              }
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex-1 cursor-pointer rounded-md border-0 px-3.5 py-1.5 text-center text-[13px] transition-colors ${tab === id ? 'bg-card font-semibold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'sessions' ? (
          <SessionsPane selected={sessionId} onSelect={setSessionId} />
        ) : (
          <PullRequestsPane selected={pull} onSelect={setPull} />
        )}
      </aside>
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
