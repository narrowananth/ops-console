import { type AgentRun, RunHealth, RunOutcome, SubagentStatus } from '@ops-console/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { StopIcon } from '../agents/stop-run';
import { PauseIcon, PlayIcon, placeOf, RetryIcon } from '../app/running-tasks';
import { Spinner } from '../components/ui/button';
import { Elapsed } from '../components/ui/elapsed';
import { useRunControls, useStopSession } from '../lib/queries';
import { RunDetailPanel } from './run-detail';
import { HEALTH, money, PHASE, tokens } from './run-look';

function HealthIcon({ health, running }: { health: RunHealth; running: boolean }) {
  const common = { className: 'size-4.5', fill: 'none', stroke: 'currentColor', strokeWidth: 2, viewBox: '0 0 24 24' };
  switch (health) {
    case RunHealth.Slow:
      return (
        <svg aria-hidden {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" />
        </svg>
      );
    case RunHealth.NeedsYou:
      return (
        <svg aria-hidden {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 4-6 8-6s8 2 8 6" strokeLinecap="round" />
        </svg>
      );
    case RunHealth.Failed:
      return (
        <svg aria-hidden {...common} strokeLinejoin="round" strokeLinecap="round">
          <path d="M12 3l10 18H2z" />
          <path d="M12 10v5M12 18v.5" />
        </svg>
      );
    case RunHealth.Stopped:
      return (
        <svg aria-hidden {...common}>
          <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return (
        <svg aria-hidden {...common} className={`size-4.5 ${running ? 'animate-spin' : ''}`} strokeLinecap="round">
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
      );
  }
}

/** A round control on a run: pause, stop, play, retry, dismiss. */
export function RoundButton({
  title,
  onClick,
  disabled = false,
  pending = false,
  tone = 'plain',
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  tone?: 'plain' | 'stop' | 'play';
  children: ReactNode;
}) {
  const tones = {
    plain: 'border-divider bg-card text-text hover:bg-neutral-200',
    stop: 'border-accent-300 bg-accent-100 text-accent-700 hover:bg-accent-200',
    play: 'border-ok/40 bg-ok/10 text-ok hover:bg-ok/20',
  };
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled || pending}
      onClick={onClick}
      className={`flex size-7.5 flex-none cursor-pointer items-center justify-center rounded-full border text-xs shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
    >
      {pending ? <Spinner /> : children}
    </button>
  );
}

/** The time a run spent in each phase, as one strip. */
export function PhaseStrip({ run }: { run: AgentRun }) {
  const total = run.split.reduce((sum, part) => sum + part.ms, 0);
  if (total <= 0) return null;
  return (
    <div className="mt-2 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-neutral-200" aria-hidden>
      {run.split
        .filter((part) => part.ms > 0)
        .map((part) => (
          <span
            key={part.phase}
            title={`${PHASE[part.phase].label}: ${Math.round((part.ms / total) * 100)}%`}
            className="block h-full rounded-full"
            style={{ width: `${(part.ms / total) * 100}%`, background: PHASE[part.phase].color }}
          />
        ))}
    </div>
  );
}

/** One run as a card: its health, why, where its time went, its controls, and a fold with everything else. */
export function RunCard({
  run,
  repoName,
  open,
  onToggle,
}: {
  run: AgentRun;
  repoName: (id: string | null) => string;
  open: boolean;
  onToggle: () => void;
}) {
  const { session } = run;
  const look = HEALTH[run.health];
  const place = placeOf(session, repoName);
  const controls = useRunControls(session.id);
  const stop = useStopSession(session.id);
  const failed = [controls.pause, controls.resume, controls.dismiss, stop].find((one) => one.isError);
  const going = run.subagents.filter((one) => one.status === SubagentStatus.Working).length;
  const play = run.outcome === RunOutcome.Paused || run.outcome === RunOutcome.Stopped;
  const usage =
    run.cost_usd !== null ? `${money(run.cost_usd)}${run.tokens ? ` · ${tokens(run.tokens)} tokens` : ''}` : null;
  return (
    <li className={`list-none rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md ${look.card}`}>
      <div className="flex items-center gap-3 px-3 py-3">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} details of ${place.what}`}
          title="Where the time went, the steps, and why it is slow or failed"
          onClick={onToggle}
          className="flex size-6 flex-none cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-neutral-700 hover:text-text"
        >
          <span aria-hidden className={`inline-block text-base transition-transform ${open ? 'rotate-90' : ''}`}>
            ›
          </span>
        </button>
        <span title={look.tip} className={`flex size-10 flex-none items-center justify-center rounded-xl ${look.icon}`}>
          <HealthIcon health={run.health} running={run.running} />
        </span>
        <div className="min-w-0 flex-1">
          <Link
            to={place.to}
            title={place.tip}
            className="block truncate text-[13px] font-semibold text-text no-underline hover:underline"
          >
            {place.what}
          </Link>
          <span className="block truncate text-[11px] text-neutral-700">
            {place.where}
            {session.branch ? ` · ${session.branch}` : ''}
            {run.subagents.length > 0 &&
              ` · ${run.subagents.length} ${run.subagents.length === 1 ? 'subagent' : 'subagents'}${going > 0 ? ` (${going} working)` : ''}`}
            {usage && ` · ${usage}`}
          </span>
          <span className={`mt-0.5 block text-[12px] ${look.reason}`}>{run.health_reason}</span>
          {session.queued_message !== null && (
            <span className="mt-0.5 block truncate text-[11px] text-info">1 queued: “{session.queued_message}”</span>
          )}
          <PhaseStrip run={run} />
        </div>
        <div className="flex flex-none flex-col items-end gap-1.5">
          <span title={look.tip} className={`rounded-full px-2.5 py-px font-mono text-[11px] ${look.chip}`}>
            {look.label}
          </span>
          <Elapsed from={run.started_at} to={run.finished_at} running={run.running} took={!run.running} />
          <span className="flex gap-1.5">
            {run.running ? (
              <>
                <RoundButton
                  title={
                    run.can_resume
                      ? 'Pause: ends the turn here. Play carries on from the conversation.'
                      : 'A pull request review takes no messages, so it cannot pause. Stop it instead.'
                  }
                  disabled={!run.can_resume}
                  pending={controls.pause.isPending}
                  onClick={() => controls.pause.mutate()}
                >
                  <PauseIcon />
                </RoundButton>
                <RoundButton
                  title="Stop the run where it is"
                  tone="stop"
                  pending={stop.isPending}
                  onClick={() => stop.mutate()}
                >
                  <StopIcon />
                </RoundButton>
              </>
            ) : (
              <>
                {run.can_resume && (
                  <RoundButton
                    title={play ? 'Play: carry on from where it stopped' : 'Retry: try the run again'}
                    tone={play ? 'play' : 'plain'}
                    pending={controls.resume.isPending}
                    onClick={() => controls.resume.mutate()}
                  >
                    {play ? <PlayIcon /> : <RetryIcon />}
                  </RoundButton>
                )}
                <RoundButton
                  title="Dismiss: take this run off the page"
                  pending={controls.dismiss.isPending}
                  onClick={() => controls.dismiss.mutate()}
                >
                  ✕
                </RoundButton>
              </>
            )}
          </span>
        </div>
      </div>
      {failed?.error && (
        <p role="alert" className="m-0 px-4 pb-2 text-[11px] text-accent-700">
          {failed.error.message}
        </p>
      )}
      {open && <RunDetailPanel run={run} />}
    </li>
  );
}
