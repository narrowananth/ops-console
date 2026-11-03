import type { ReactNode } from 'react';

export type PathwayState = 'done' | 'running' | 'failed' | 'pending' | 'skipped';

export type PathwayStep = {
  key: string;
  title: ReactNode;
  state: PathwayState;
  /** Shown after the title, such as a tag. */
  aside?: ReactNode;
  /** Shown under the title: a summary, a link, an error. */
  children?: ReactNode;
};

const WORD: Record<PathwayState, string> = {
  done: 'done',
  running: 'in progress',
  failed: 'failed',
  pending: 'to do',
  skipped: 'skipped',
};

/**
 * A job's stages as a path: one node per step joined by a line, done ones ticked and the line behind them filled,
 * the running one turning, a failed one crossed. Each step can carry its own details under its title.
 */
export function Pathway({
  label,
  steps,
  compact = false,
}: {
  label: string;
  steps: PathwayStep[];
  /** Small nodes and tight rows, for a run's many tool steps. */
  compact?: boolean;
}) {
  return (
    <ol aria-label={label} className="m-0 flex list-none flex-col p-0">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const passed = step.state === 'done' || step.state === 'skipped';
        return (
          <li
            key={step.key}
            aria-current={step.state === 'running' ? 'step' : undefined}
            className={`grid gap-x-3 ${compact ? 'grid-cols-[16px_minmax(0,1fr)]' : 'grid-cols-[28px_minmax(0,1fr)]'}`}
          >
            <div className="flex flex-col items-center">
              {compact ? <Dot state={step.state} /> : <Node state={step.state} number={index + 1} />}
              {!last && (
                <span
                  aria-hidden
                  className={`w-0.5 flex-1 rounded-full ${compact ? 'my-0.5 min-h-1.5' : 'my-1 min-h-3'} ${
                    passed ? 'bg-ok/50' : 'bg-divider'
                  }`}
                />
              )}
            </div>
            <div
              className={`flex min-w-0 flex-col gap-1 ${compact ? (last ? '' : 'pb-1.5') : `pt-1 ${last ? '' : 'pb-4'}`}`}
            >
              <div
                className={`flex flex-wrap items-center gap-2 ${compact ? 'min-h-4 font-mono text-xs' : 'min-h-5 text-[13px]'}`}
              >
                <span
                  className={
                    step.state === 'running'
                      ? 'font-semibold text-text'
                      : step.state === 'failed'
                        ? 'font-semibold text-accent-700'
                        : step.state === 'pending'
                          ? 'text-neutral-700'
                          : 'text-text'
                  }
                >
                  {step.title}
                </span>
                {step.aside}
                {compact ? <span className="sr-only">{WORD[step.state]}</span> : <StateTag state={step.state} />}
              </div>
              {step.children && <div className="flex flex-col gap-1.5 text-xs text-neutral-700">{step.children}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StateTag({ state }: { state: PathwayState }) {
  if (state === 'running') {
    return (
      <span className="rounded-full bg-accent-100 px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-accent-700 uppercase">
        In progress
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="rounded-full bg-accent-700 px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-white uppercase">
        Failed
      </span>
    );
  }
  if (state === 'skipped') {
    return (
      <span className="rounded-full border border-dashed border-neutral-400 px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-neutral-600 uppercase">
        Skipped
      </span>
    );
  }
  return <span className="sr-only">{WORD[state]}</span>;
}

/** The compact node: a small tick, cross or turning ring. */
function Dot({ state }: { state: PathwayState }) {
  const base = 'relative mt-0.5 flex size-3.5 flex-none items-center justify-center rounded-full';
  if (state === 'done') return <span aria-hidden className={`${base} bg-ok/80`} />;
  if (state === 'failed') return <span aria-hidden className={`${base} bg-accent-700`} />;
  if (state === 'running') {
    return (
      <span aria-hidden className={base}>
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </span>
    );
  }
  return <span aria-hidden className={`${base} border border-divider bg-card`} />;
}

function Node({ state, number }: { state: PathwayState; number: number }) {
  const base = 'relative flex size-7 flex-none items-center justify-center rounded-full';
  if (state === 'done') {
    return (
      <span aria-hidden className={`${base} bg-ok text-white`}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path
            d="M2.5 6.2 5 8.5l4.5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span aria-hidden className={`${base} bg-accent-700 text-white`}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (state === 'running') {
    return (
      <span aria-hidden className={`${base} bg-accent-100`}>
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-accent border-t-transparent border-r-transparent" />
        <span className="size-2 animate-pulse rounded-full bg-accent" />
      </span>
    );
  }
  if (state === 'skipped') {
    return (
      <span aria-hidden className={`${base} border border-dashed border-neutral-400 text-xs text-neutral-500`}>
        –
      </span>
    );
  }
  return (
    <span aria-hidden className={`${base} border border-divider bg-card text-xs font-semibold text-neutral-600`}>
      {number}
    </span>
  );
}

/** "3 of 5" and a bar that fills as steps pass; accent while running, red once failed. */
export function PathwayProgress({ steps }: { steps: PathwayStep[] }) {
  const passed = steps.filter((step) => step.state === 'done' || step.state === 'skipped').length;
  const failed = steps.some((step) => step.state === 'failed');
  const running = steps.some((step) => step.state === 'running');
  const share = steps.length === 0 ? 0 : (passed / steps.length) * 100;
  return (
    <div className="flex items-center gap-2.5">
      <div
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={passed}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            failed ? 'bg-accent-700' : running ? 'bg-accent' : 'bg-ok'
          }`}
          style={{ width: `${Math.max(share, running || failed ? 4 : 0)}%` }}
        />
      </div>
      <span className="font-mono text-xs whitespace-nowrap text-neutral-700">
        {passed} of {steps.length}
      </span>
    </div>
  );
}

const PILL: Record<PathwayState, string> = {
  running: 'bg-accent-100 text-accent-700',
  done: 'bg-ok/15 text-ok',
  failed: 'bg-accent-700 text-white',
  skipped: 'bg-neutral-200 text-neutral-700',
  pending: 'bg-neutral-200 text-neutral-700',
};

/** A job's status in its card's header, tinted like its path: running, done, failed, or quiet. */
export function StatusPill({ state, children }: { state: PathwayState; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${PILL[state]}`}>
      {state === 'running' && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" />}
      {children}
    </span>
  );
}
