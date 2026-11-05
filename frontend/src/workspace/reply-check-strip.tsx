import { AgentReviewStatus, type ReplyCheck } from '@ops-console/shared';
import { StopRun } from '../agents/stop-run';
import { Elapsed } from '../components/ui/elapsed';
import { StatusPill } from '../components/ui/pathway';
import { useRetryReplyCheck, useSkipRunningStep } from '../lib/queries';
import { JobFailure, JobPath, PlaybookLink, runState, SkillsOffered } from '../playbooks/job-steps';

/** A running or failed Reply check under its thread. A ready one shows nothing: its verdict is the agent's reply. */
export function ReplyCheckStrip({ check, sessionId }: { check: ReplyCheck; sessionId: string | null }) {
  const skipStep = useSkipRunningStep('reply_check', check.id);
  const retry = useRetryReplyCheck(check.repo_id, check.pr_number);
  if (check.status === AgentReviewStatus.Ready) return null;
  const failed = check.status === AgentReviewStatus.Failed;
  return (
    <section aria-label="Reply check" className="flex flex-col gap-2.5 border-t border-line bg-surface px-3 py-2.5">
      <header className="flex items-center gap-2 text-xs">
        <strong
          title={
            failed
              ? 'The Reply check stopped before it replied. The reason is below.'
              : 'The agent is checking whether the code at the newest commit does what this thread asked'
          }
        >
          {failed ? 'Reply check failed' : 'Checking the reply'}
        </strong>
        {check.playbook && <PlaybookLink playbook={check.playbook} />}
        {check.playbook && <SkillsOffered playbook={check.playbook} />}
        <span className="ml-auto flex items-center gap-2">
          {check.status === AgentReviewStatus.Running && sessionId && (
            <StopRun sessionId={sessionId} title="Stop the Reply check; it fails and can retry from its step" />
          )}
          <Elapsed
            from={check.started_at}
            to={check.finished_at}
            running={check.status === AgentReviewStatus.Running}
            took
          />
          <StatusPill state={runState(check.status)}>{check.status}</StatusPill>
        </span>
      </header>
      <JobPath
        playbook={check.playbook}
        status={check.status}
        skip={{ isPending: skipStep.isPending, error: skipStep.error, mutate: () => skipStep.mutate() }}
        answered={check.verdict !== null}
        reading={{ todo: 'Read the thread and the code', doing: 'Reading the thread and the code' }}
        closing={{ todo: 'Give the verdict and the reply', doing: 'Giving the verdict and the reply' }}
      />
      {failed && (
        <JobFailure
          error={check.error}
          playbook={check.playbook}
          canRetry={check.can_retry}
          retry={{
            isPending: retry.isPending,
            error: retry.error,
            mutate: (skip) => retry.mutate({ id: check.id, skip }),
          }}
        />
      )}
    </section>
  );
}
