import { ApprovalStatus } from '@ops-console/shared';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { useDecideApproval, usePendingApprovals } from '../lib/queries';

/** Pending Approvals, with the command and a PROD badge; `sessionId` narrows them to one Session. */
export function ApprovalPrompts({ sessionId }: { sessionId?: string }) {
  const approvals = usePendingApprovals();
  const decide = useDecideApproval();
  if (approvals.isPending) return <Empty>Loading approvals…</Empty>;
  if (approvals.isError) return <Empty>Could not load approvals.</Empty>;
  const pending = approvals.data.filter((approval) => sessionId === undefined || approval.session_id === sessionId);
  if (pending.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {pending.map((approval) => (
        <li key={approval.id} className="flex flex-col gap-2 border-2 border-text bg-surface px-3 py-2.5">
          <div className="flex items-center gap-2 text-[13px] font-extrabold">
            {approval.is_prod && <span className="bg-accent px-1.5 py-px text-[10px] text-bg">PROD</span>}
            <span>{approval.summary}</span>
          </div>
          {approval.command && <code className="font-mono text-xs text-neutral-800">{approval.command}</code>}
          <div className="flex gap-2">
            <Button
              variant="primary"
              className="px-2.5 py-1 text-xs"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: approval.id, decision: ApprovalStatus.Approved })}
            >
              Approve
            </Button>
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: approval.id, decision: ApprovalStatus.Denied })}
            >
              Deny
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
