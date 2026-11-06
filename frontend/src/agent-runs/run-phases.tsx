import type { RunDetail } from '@ops-console/shared';

const STOP_TONE = {
  limit: { ring: 'border-warn bg-card text-warn', text: 'text-warn' },
  failed: { ring: 'border-accent bg-card text-accent-700', text: 'text-accent-700' },
  stopped: { ring: 'border-neutral-500 bg-card text-neutral-700', text: 'text-neutral-700' },
} as const;

/**
 * The run's own order of work, read from what it did. A phase with evidence is a green check, one the run went past
 * with none is a dashed circle, and the phase an ended run stopped in carries the reason.
 */
export function Stepper({ stages }: { stages: RunDetail['stages'] }) {
  return (
    <ol
      aria-label="Where the run is"
      className="m-0 mb-5 flex list-none p-0"
      title="Read from what the run did. A dashed circle is a phase the run went past with nothing to show for it."
    >
      {stages.map((one, index) => {
        const stopped = one.stopped ? STOP_TONE[one.stopped.tone] : null;
        const previous = stages[index - 1];
        const lit = previous && (previous.state === 'done' || previous.state === 'skipped') && one.state !== 'todo';
        return (
          <li
            key={one.id}
            aria-current={one.state === 'now' ? 'step' : undefined}
            className={`relative flex flex-1 flex-col items-center gap-1.5 text-center text-[11px] ${one.state === 'todo' || one.state === 'skipped' ? 'text-neutral-700' : 'text-text'} ${one.state === 'now' ? 'font-bold' : ''}`}
          >
            {index > 0 && (
              <span aria-hidden className={`absolute top-3.5 right-1/2 h-0.5 w-full ${lit ? 'bg-ok' : 'bg-line'}`} />
            )}
            <span
              className={`relative z-10 flex size-7 items-center justify-center rounded-full border-2 text-[11px] ${
                stopped
                  ? `${stopped.ring} shadow-[0_0_0_4px] shadow-current/10`
                  : one.state === 'done'
                    ? 'border-ok bg-ok text-white'
                    : one.state === 'now'
                      ? 'border-warn bg-card text-warn shadow-[0_0_0_4px] shadow-warn/15'
                      : one.state === 'skipped'
                        ? 'border-dashed border-neutral-400 bg-card text-neutral-500'
                        : 'border-neutral-300 bg-card'
              }`}
            >
              {stopped ? '■' : one.state === 'done' ? '✓' : one.state === 'skipped' ? '–' : index + 1}
            </span>
            <span>
              {one.label}
              {one.state === 'skipped' && <span className="block text-[10px] font-normal">skipped</span>}
            </span>
            {one.stopped && stopped && (
              <span className={`text-[10.5px] font-semibold ${stopped.text}`}>{one.stopped.label}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
