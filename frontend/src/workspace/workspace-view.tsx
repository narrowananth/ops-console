import { useState } from 'react';
import { Empty } from '../components/ui/empty';
import { PullRequestView } from './pull-request-view';
import { PullRequestsPane } from './pull-requests-pane';
import { SessionView } from './session-view';
import { SessionsPane } from './sessions-pane';

type Tab = 'sessions' | 'pulls';

export function WorkspaceView() {
  const [tab, setTab] = useState<Tab>('sessions');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pull, setPull] = useState<{ repoId: string; number: number } | null>(null);

  return (
    <>
      <aside className="flex w-80 flex-none flex-col overflow-y-auto border-r-2 border-divider">
        <div role="tablist" aria-label="Workspace" className="flex border-b-2 border-divider">
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
              className={`-mb-0.5 flex-1 cursor-pointer border-0 border-b-3 bg-transparent px-3.5 py-2.5 text-left text-[13px] text-text hover:bg-neutral-200 ${tab === id ? 'border-b-accent font-extrabold' : 'border-b-transparent'}`}
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
