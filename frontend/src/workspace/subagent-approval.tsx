import type { Session } from '@ops-console/shared';
import { Spinner } from '../components/ui/button';
import { usePendingApprovals } from '../lib/queries';

/** The Approval card of the composer's panel, scrolled into view and focused. */
function openApproval(id: string) {
  const card = document.querySelector<HTMLElement>(`[data-approval-id="${id}"]`);
  card?.scrollIntoView({ block: 'center' });
  card?.focus();
}

/** Above the waiting line: one line per pending Approval a subagent's tool call asked for. */
export function SubagentApprovals({ session }: { session: Session }) {
  const approvals = usePendingApprovals();
  const asked = (approvals.data ?? []).filter(
    (approval) => approval.session_id === session.id && approval.subagent_id !== null,
  );
  return asked.map((approval) => (
    <div key={approval.id} className="flex w-full items-center gap-3 px-6 py-2 text-sm text-neutral-700">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="flex-none text-accent-700">
        <path
          d="M8 1.5 14 4v4c0 3.2-2.4 5.6-6 6.5C4.4 13.6 2 11.2 2 8V4l6-2.5ZM8 5v3.5M8 10.8v.01"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="flex-none text-text">Subagent needs approval</span>
      <span className="min-w-0 flex-1 truncate text-neutral-600">
        {session.subagents.find((one) => one.id === approval.subagent_id)?.description ?? 'A subagent'}
      </span>
      <button
        type="button"
        onClick={() => openApproval(approval.id)}
        className="flex-none cursor-pointer rounded-lg border border-divider bg-card px-2.5 py-1 text-xs font-semibold text-text hover:bg-neutral-200"
      >
        Open approval
      </button>
    </div>
  ));
}

/** Above the composer while a Session's messages load after a switch. */
export function SyncingMessages() {
  return (
    <div role="status" className="flex w-full items-center gap-3 px-6 py-2 text-sm text-neutral-700">
      <Spinner />
      Syncing messages…
    </div>
  );
}
