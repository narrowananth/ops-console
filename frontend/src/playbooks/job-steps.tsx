import { type JobPlaybook, PlaybookStepStatus, type PlaybookTrigger } from '@ops-console/shared';
import { Link } from 'react-router-dom';
import { Button, Spinner } from '../components/ui/button';
import { Pathway, PathwayProgress, type PathwayState, type PathwayStep } from '../components/ui/pathway';
import { usePlaybooks } from '../lib/queries';
import { holderOf } from './labels';

/** The tag on a step that writes files or runs commands. */
export function ScratchTag() {
  return (
    <span className="flex-none rounded-full border border-warn/50 px-1.75 text-[10px] font-normal whitespace-nowrap text-warn">
      scratch copy
    </span>
  );
}

/** The operator's Playbook a Trigger holds now; none while it runs its built-in. */
export function useTriggerPlaybook(trigger: PlaybookTrigger) {
  return holderOf(usePlaybooks().data?.items ?? [], trigger);
}

const pill =
  'rounded-full border border-line bg-card px-2.5 py-0.5 text-[11px] whitespace-nowrap text-text no-underline hover:border-accent-300 hover:bg-accent-100 hover:text-accent-900';

/** A Playbook's name, opening it on the Playbooks page; a built-in or deleted one is plain text. */
export function PlaybookLink({
  playbook,
  label,
  title,
}: {
  playbook: { id: string | null; name: string };
  label?: string;
  title?: string;
}) {
  const text = label ?? playbook.name;
  if (playbook.id === null) return <span className={pill}>{text}</span>;
  return (
    <Link to={`/playbooks?playbook=${encodeURIComponent(playbook.id)}`} title={title} className={pill}>
      {text}
    </Link>
  );
}

const STATE: Record<PlaybookStepStatus, PathwayState> = {
  [PlaybookStepStatus.Pending]: 'pending',
  [PlaybookStepStatus.Running]: 'running',
  [PlaybookStepStatus.Done]: 'done',
  [PlaybookStepStatus.Skipped]: 'skipped',
  [PlaybookStepStatus.Failed]: 'failed',
};

/** "5 done, 1 skipped". */
export function stepTally(playbook: JobPlaybook): string {
  const counts = new Map<PlaybookStepStatus, number>();
  for (const step of playbook.steps) counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
  return [...counts].map(([status, count]) => `${count} ${status}`).join(', ');
}

/** 1-based number of the step that failed, if one did. */
export function failedStep(playbook: JobPlaybook | null): number | null {
  const index = playbook?.steps.findIndex((step) => step.status === PlaybookStepStatus.Failed) ?? -1;
  return index === -1 ? null : index + 1;
}

/** Every step has run and none failed: the console's own closing turn is next. */
export const stepsFinished = (playbook: JobPlaybook) =>
  playbook.steps.every((step) => step.status === PlaybookStepStatus.Done || step.status === PlaybookStepStatus.Skipped);

/** A job's copy of its Playbook's steps as a path, each with its status and the agent's summary. */
export function JobSteps({ playbook, closing }: { playbook: JobPlaybook; closing?: string }) {
  const steps = playbookPath(playbook);
  if (closing) steps.push({ key: 'closing', title: closing, state: 'running' });
  return <Pathway label="Playbook steps" steps={steps} />;
}

const playbookPath = (playbook: JobPlaybook): PathwayStep[] =>
  playbook.steps.map((step, index) => ({
    // A job's copy never changes order: the position is its identity.
    key: String(index),
    title: step.title,
    state: STATE[step.status],
    aside: step.writes ? <ScratchTag /> : undefined,
    children: step.summary ? <span>{step.summary}</span> : undefined,
  }));

/** A Verification's or an Agent Review's status as a path state; both say `running`, `ready` or `failed`. */
export const runState = (status: string): PathwayState =>
  status === 'ready' ? 'done' : status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'pending';

/** What a stage is called before and while it runs: "Write the Report", "Writing the Report". */
export type StageWords = { todo: string; doing: string };

/**
 * A whole job as a path under a progress bar: its Playbook's steps, or `reading` alone when it has none, then the
 * console's own closing turn. A job with steps left runs them first; the closing turn turns once they are through.
 */
export function JobPath({
  playbook,
  status,
  reading,
  closing,
}: {
  playbook: JobPlaybook | null;
  status: string;
  reading: StageWords;
  closing: StageWords;
}) {
  const state = runState(status);
  const own = playbook && playbook.steps.length > 0;
  const steps: PathwayStep[] = own
    ? playbookPath(playbook)
    : [{ key: 'reading', title: state === 'running' ? reading.doing : reading.todo, state }];
  const through = own ? stepsFinished(playbook) : state === 'done';
  const last: PathwayState =
    state === 'done'
      ? 'done'
      : !through
        ? 'pending'
        : state === 'failed' && steps.every((step) => step.state !== 'failed')
          ? 'failed'
          : state === 'running'
            ? 'running'
            : 'pending';
  steps.push({ key: 'closing', title: last === 'running' ? closing.doing : closing.todo, state: last });
  return (
    <div className="flex flex-col gap-3">
      {state !== 'done' && <PathwayProgress steps={steps} />}
      <Pathway label={own ? 'Playbook steps' : 'Progress'} steps={steps} />
    </div>
  );
}

/**
 * Why a job failed, and Retry when it can: "Retry from step N" after a failed step, else plain Retry, which redoes
 * only what the console left undone after the steps.
 */
export function JobFailure({
  error,
  playbook,
  canRetry,
  retry,
}: {
  error: string | null;
  playbook: JobPlaybook | null;
  canRetry: boolean;
  retry: { isPending: boolean; error: Error | null; mutate: () => void };
}) {
  const step = failedStep(playbook);
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-accent-200 bg-accent-100/60 px-3 py-2 text-xs">
      {error && (
        <span role="alert" className="text-accent-900">
          {error}
        </span>
      )}
      {canRetry && (
        <Button className="px-2.5 py-1 text-xs" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending && <Spinner />}
          {step === null ? 'Retry' : `Retry from step ${step}`}
        </Button>
      )}
      {retry.error && (
        <span role="alert" className="text-accent-700">
          {retry.error.message}
        </span>
      )}
    </div>
  );
}
