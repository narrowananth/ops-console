import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Empty } from '../components/ui/empty';
import { PullRequestView } from './pull-request-view';
import { PullRequestsPane } from './pull-requests-pane';
import { SessionView } from './session-view';
import { SessionsPane } from './sessions-pane';

type Tab = 'sessions' | 'pulls';

export function WorkspaceView() {
  const [tab, setTab] = useState<Tab>('sessions');
  const [params, setParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(params.get('session'));
  // A link from the Monitor names the Session to open; the address keeps no state after that.
  useEffect(() => {
    const linked = params.get('session');
    if (linked === null) return;
    setTab('sessions');
    setSessionId(linked);
    setParams({}, { replace: true });
  }, [params, setParams]);
  const [pull, setPull] = useState<{ repoId: string; number: number } | null>(null);

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
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex-1 cursor-pointer rounded-md border-0 px-3.5 py-1.5 text-center text-[13px] transition-colors ${tab === id ? 'bg-card font-bold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
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
            <SessionView key={sessionId} id={sessionId} onGone={() => setSessionId(null)} />
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
