import { type AgentRun, RunHealth, RunOutcome } from '@ops-console/shared';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { StopIcon } from '../agents/stop-run';
import { Spinner } from '../components/ui/button';
import { useRunControls, useStopSession } from '../lib/queries';
import { PauseIcon, PlayIcon, RetryIcon } from './run-look';

/** The icon of a run's health: a ring that turns, a clock, a person, a warning, a stop square. */
export function HealthIcon({ health, running }: { health: RunHealth; running: boolean }) {
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

/** A control on a run: pause, stop, play, retry, dismiss. Round on the page, rounded square in the tray. */
export function RoundButton({
  title,
  onClick,
  disabled = false,
  pending = false,
  tone = 'plain',
  square = false,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  tone?: 'plain' | 'stop' | 'play';
  square?: boolean;
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
      className={`flex flex-none cursor-pointer items-center justify-center border text-xs shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        square ? 'size-6.5 rounded-lg' : 'size-7.5 rounded-full'
      } ${tones[tone]}`}
    >
      {pending ? <Spinner /> : children}
    </button>
  );
}

/**
 * What the operator can do with a run: Pause and Stop while it goes; Play (it was stopped or paused) or Retry (it
 * failed), and Dismiss, once it ended. A control the run cannot take shows dimmed with the reason on hover.
 */
export function RunButtons({ run, square = false }: { run: AgentRun; square?: boolean }) {
  const id = run.session.id;
  const controls = useRunControls(id);
  const stop = useStopSession(id);
  const failed = [controls.pause, controls.resume, controls.dismiss, stop].find((one) => one.isError);
  const play = run.outcome === RunOutcome.Paused || run.outcome === RunOutcome.Stopped;
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex gap-1.5">
        {run.running ? (
          <>
            <RoundButton
              square={square}
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
              square={square}
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
            {run.can_retry && (
              <RoundButton
                square={square}
                title={play ? 'Play: carry on from where it stopped' : 'Retry: try the run again'}
                tone={play ? 'play' : 'plain'}
                pending={controls.resume.isPending}
                onClick={() => controls.resume.mutate()}
              >
                {play ? <PlayIcon /> : <RetryIcon />}
              </RoundButton>
            )}
            <RoundButton
              square={square}
              title="Dismiss: take this run off the page"
              pending={controls.dismiss.isPending}
              onClick={() => controls.dismiss.mutate()}
            >
              ✕
            </RoundButton>
          </>
        )}
      </span>
      {failed?.error && (
        <span role="alert" className="max-w-60 text-right text-[11px] text-accent-700">
          {failed.error.message}
        </span>
      )}
    </span>
  );
}

const PILL =
  'inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-semibold no-underline shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/** A button of the Agent runs page: a pill, dark when it is the one that deals with what the box says, red to stop. */
export function Pill({
  dark = false,
  danger = false,
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { dark?: boolean; danger?: boolean }) {
  const tone = dark
    ? 'border-text bg-text text-card hover:opacity-85'
    : danger
      ? 'border-accent-300 bg-accent-100 text-accent-700 hover:bg-accent-200'
      : 'border-divider bg-card text-text hover:bg-neutral-200';
  return <button type={type} className={`${PILL} ${tone} ${className}`} {...props} />;
}

/** A link that looks like a `Pill`. */
export function PillLink({ className = '', ...props }: LinkProps) {
  return <Link className={`${PILL} border-divider bg-card text-text hover:bg-neutral-200 ${className}`} {...props} />;
}
