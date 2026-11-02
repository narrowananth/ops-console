import { AgentReviewStatus, type ReplyCheck } from '@ops-console/shared';
import { StatusPill } from '../components/ui/pathway';
import { useRetryReplyCheck } from '../lib/queries';
import { JobFailure, JobPath, PlaybookLink, runState } from '../playbooks/job-steps';

/** A running or failed Reply check under its thread. A ready one shows nothing: its verdict is the agent's reply. */
export function ReplyCheckStrip({ check }: { check: ReplyCheck }) {
  const retry = useRetryReplyCheck(check.repo_id, check.pr_number);
  if (check.status === AgentReviewStatus.Ready) return null;
  const failed = check.status === AgentReviewStatus.Failed;
  return (
    <section aria-label="Reply check" className="flex flex-col gap-2.5 border-t border-line bg-surface px-3 py-2.5">
      <header className="flex items-center gap-2 text-xs">
        <strong>{failed ? 'Reply check failed' : 'Checking the reply'}</strong>
        {check.playbook && <PlaybookLink playbook={check.playbook} />}
        <span className="ml-auto">
          <StatusPill state={runState(check.status)}>{check.status}</StatusPill>
        </span>
      </header>
      <JobPath
        playbook={check.playbook}
        status={check.status}
        reading={{ todo: 'Read the thread and the code', doing: 'Reading the thread and the code' }}
        closing={{ todo: 'Give the verdict and the reply', doing: 'Giving the verdict and the reply' }}
      />
      {failed && (
        <JobFailure
          error={check.error}
          playbook={check.playbook}
          canRetry={check.can_retry}
          retry={{ isPending: retry.isPending, error: retry.error, mutate: () => retry.mutate(check.id) }}
        />
      )}
    </section>
  );
}
