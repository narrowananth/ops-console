import { type Approval, ApprovalKind, ApprovalStatus } from '@ops-console/shared';
import { Button } from '../components/ui/button';
import { CodeBlock } from '../components/ui/code-block';
import { Empty } from '../components/ui/empty';
import { useDecideApproval, usePendingApprovals } from '../lib/queries';

const KIND_LABEL: Record<ApprovalKind, string> = {
  [ApprovalKind.ProdWrite]: 'Production write',
  [ApprovalKind.Command]: 'Action',
  [ApprovalKind.Edit]: 'File edit',
};

const ICON_PATH: Record<ApprovalKind, string> = {
  [ApprovalKind.ProdWrite]: 'M8 1.5 14 4v4c0 3.2-2.4 5.6-6 6.5C4.4 13.6 2 11.2 2 8V4l6-2.5ZM8 5v3.5M8 10.8v.01',
  [ApprovalKind.Command]: 'M3 4.5l3.5 3.5L3 11.5M8 12h5',
  [ApprovalKind.Edit]: 'M10.5 2.5l3 3L6 13l-3.5.5L3 10l7.5-7.5Z',
};

function KindIcon({ kind }: { kind: ApprovalKind }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path
        d={ICON_PATH[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: Approval;
  busy: boolean;
  onDecide: (d: ApprovalStatus.Approved | ApprovalStatus.Denied) => void;
}) {
  const prod = approval.is_prod || approval.kind === ApprovalKind.ProdWrite;
  return (
    <li
      aria-label={`Approval needed: ${approval.summary}`}
      className={`overflow-hidden rounded-xl border bg-card shadow-sm ${prod ? 'border-accent-300' : 'border-divider'}`}
    >
      <div className="flex gap-3 px-4 pt-3.5 pb-3">
        <span
          aria-hidden
          className={`mt-0.5 flex size-8 flex-none items-center justify-center rounded-lg ${prod ? 'bg-accent-100 text-accent-600' : 'bg-neutral-200 text-neutral-800'}`}
        >
          <KindIcon kind={approval.kind} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-neutral-700 uppercase">
            <span>Approval needed</span>
            <span aria-hidden className="text-neutral-500">
              ·
            </span>
            <span className="font-normal normal-case tracking-normal">{KIND_LABEL[approval.kind]}</span>
            {prod && (
              <span
                title="This touches production data. It always needs your Approval, whatever the Access mode."
                className="rounded-full bg-accent px-2 py-px text-xs font-semibold tracking-normal text-white"
              >
                PROD
              </span>
            )}
          </div>
          <p className="m-0 text-sm leading-relaxed font-medium break-words text-text">{approval.summary}</p>
          {approval.command && (
            <CodeBlock
              text={approval.command}
              tone="light"
              className="m-0 max-h-40 overflow-auto rounded-lg border border-line bg-neutral-200 py-2 pl-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-neutral-900"
            />
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-line bg-surface/60 px-4 py-2.5">
        <Button
          variant="primary"
          className="px-3.5 py-1.5 text-[13px]"
          disabled={busy}
          title="Let the agent run this once"
          onClick={() => onDecide(ApprovalStatus.Approved)}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
            <path
              d="m3 8.5 3.2 3L13 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Approve
        </Button>
        <Button
          className="px-3.5 py-1.5 text-[13px]"
          disabled={busy}
          title="Refuse it. The agent is told no."
          onClick={() => onDecide(ApprovalStatus.Denied)}
        >
          Deny
        </Button>
        <span className="ml-auto text-xs text-neutral-700">Approving lets the agent run this once.</span>
      </div>
    </li>
  );
}

/** Pending Approvals, with the command and a PROD badge; `sessionId` narrows them to one Session. */
export function ApprovalPrompts({ sessionId }: { sessionId?: string }) {
  const approvals = usePendingApprovals();
  const decide = useDecideApproval();
  if (approvals.isPending) return <Empty>Loading approvals…</Empty>;
  if (approvals.isError) return <Empty>Could not load approvals.</Empty>;
  const pending = approvals.data.filter((approval) => sessionId === undefined || approval.session_id === sessionId);
  if (pending.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {pending.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          busy={decide.isPending}
          onDecide={(decision) => decide.mutate({ id: approval.id, decision })}
        />
      ))}
    </ul>
  );
}
