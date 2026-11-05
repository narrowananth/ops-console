import { SessionState } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RunTray } from '../agent-runs/run-tray';
import { useAgentRuns } from '../lib/queries';

const NEEDS_YOU: SessionState[] = [SessionState.WaitingInput, SessionState.WaitingApproval];

/**
 * The sidebar's tray of every agent run in any Session: the ones going now, with their subagents, and the ones that
 * stopped, were paused or ran out of usage, which stay until dismissed (`RunTray`).
 */
export function RunningTasks({ collapsed }: { collapsed: boolean }) {
  const runs = useAgentRuns().data ?? [];
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const going = runs.filter((run) => run.running);
  const ended = runs.length - going.length;
  const waiting = going.filter((run) => NEEDS_YOU.includes(run.session.state)).length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: moving to another page closes the list
  useEffect(() => setOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label =
    runs.length === 0
      ? 'No agent running'
      : [
          going.length > 0 ? `${going.length} agent ${going.length === 1 ? 'run' : 'runs'} going` : 'No agent running',
          waiting > 0 ? `${waiting} waiting on you` : null,
          ended > 0 ? `${ended} ended` : null,
        ]
          .filter(Boolean)
          .join(', ');
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label="Running agents"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(!open)}
        className={`flex h-8.5 w-full cursor-pointer items-center gap-2 border px-2.5 text-xs transition-colors ${
          waiting > 0
            ? 'border-accent-300 bg-accent-100 text-accent-900'
            : 'border-line bg-card text-text hover:bg-neutral-200'
        } ${collapsed ? 'justify-center' : ''}`}
      >
        <span
          aria-hidden
          className={`size-2 flex-none rounded-full ${going.length > 0 ? 'animate-pulse bg-accent' : ended > 0 ? 'bg-accent-300' : 'bg-neutral-400'}`}
        />
        {!collapsed && <span className="min-w-0 flex-1 truncate text-left">Running</span>}
        <span className="font-mono font-semibold">{going.length}</span>
        {!collapsed && ended > 0 && <span className="font-mono text-neutral-700">+{ended}</span>}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Agent runs"
          className="absolute bottom-0 left-full z-50 ml-2 flex max-h-[85vh] w-168 max-w-[calc(100vw-20rem)] flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-lg"
        >
          <RunTray />
        </div>
      )}
    </div>
  );
}
