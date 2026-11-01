import { type JobPlaybook, PlaybookStepStatus, type PlaybookTrigger } from '@ops-console/shared';
import { Link } from 'react-router-dom';
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

const MARK: Record<PlaybookStepStatus, { mark: string; tone: string }> = {
  [PlaybookStepStatus.Pending]: { mark: '·', tone: 'text-neutral-500' },
  [PlaybookStepStatus.Running]: { mark: '◐', tone: 'text-accent' },
  [PlaybookStepStatus.Done]: { mark: '✓', tone: 'text-ok' },
  [PlaybookStepStatus.Skipped]: { mark: '○', tone: 'text-neutral-500' },
  [PlaybookStepStatus.Failed]: { mark: '✕', tone: 'text-accent-700' },
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

/** A job's copy of its Playbook's steps, each with its status and the agent's summary. */
export function JobSteps({ playbook, closing }: { playbook: JobPlaybook; closing?: string }) {
  return (
    <ol aria-label="Playbook steps" className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
      {playbook.steps.map((step, index) => {
        const { mark, tone } = MARK[step.status];
        const quiet = step.status === PlaybookStepStatus.Pending;
        return (
          // A job's copy never changes order: the position is its identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          <li key={index} className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2 gap-y-0.5">
            <span aria-hidden className={`text-center font-mono ${tone}`}>
              {mark}
            </span>
            <span
              className={`flex flex-wrap items-center gap-1.5 ${quiet ? 'text-neutral-700' : step.status === PlaybookStepStatus.Running ? 'font-bold' : ''}`}
            >
              {index + 1} · {step.title}
              {step.writes && <ScratchTag />}
              <span
                className={
                  step.status === PlaybookStepStatus.Skipped || step.status === PlaybookStepStatus.Failed
                    ? 'text-neutral-700'
                    : 'sr-only'
                }
              >
                {step.status}
              </span>
            </span>
            {step.summary && <span className="col-start-2 text-neutral-700">{step.summary}</span>}
          </li>
        );
      })}
      {closing && (
        <li className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2 font-bold">
          <span aria-hidden className="text-center font-mono text-accent">
            ◐
          </span>
          <span>{closing}</span>
        </li>
      )}
    </ol>
  );
}
