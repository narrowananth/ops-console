import {
  AccessMode,
  type Failure,
  FailureKind,
  Model,
  RunHealth,
  RunPhase,
  RunStage,
  type Session,
  SessionKind,
} from '@ops-console/shared';
import { pullRequestPath, sessionPath } from '../workspace/links';

/** How each health reads on the Agent runs page: its words, and the colors every part of a card takes. */
export const HEALTH: Record<
  RunHealth,
  { label: string; chip: string; icon: string; edge: string; dot: string; reason: string; card: string; tip: string }
> = {
  [RunHealth.OnTrack]: {
    label: 'on track',
    chip: 'bg-ok/12 text-ok',
    icon: 'bg-ok/12 text-ok',
    edge: 'bg-ok',
    dot: 'bg-ok',
    reason: 'text-ok',
    card: 'border-line',
    tip: 'Going as usual: no step has run unusually long and nothing waits on you.',
  },
  [RunHealth.Slow]: {
    label: 'slow',
    chip: 'bg-warn/14 text-warn',
    icon: 'bg-warn/14 text-warn',
    edge: 'bg-warn',
    dot: 'bg-warn',
    reason: 'text-warn',
    card: 'border-warn/35 bg-warn/[0.06]',
    tip: 'A step has run much longer than the same step usually takes.',
  },
  [RunHealth.NeedsYou]: {
    label: 'needs you',
    chip: 'bg-info/14 text-info',
    icon: 'bg-info/14 text-info',
    edge: 'bg-info',
    dot: 'bg-info',
    reason: 'text-info',
    card: 'border-info/35 bg-info/[0.06]',
    tip: 'The agent waits for your yes or no, or for an answer.',
  },
  [RunHealth.Failed]: {
    label: 'failed',
    chip: 'bg-accent-100 text-accent-700',
    icon: 'bg-accent-100 text-accent-700',
    edge: 'bg-accent',
    dot: 'bg-accent',
    reason: 'text-accent-700',
    card: 'border-accent-300 bg-accent-100/50',
    tip: 'The run ended with an error. Open it to see why.',
  },
  [RunHealth.Stopped]: {
    label: 'stopped',
    chip: 'bg-neutral-200 text-neutral-700',
    icon: 'bg-neutral-200 text-neutral-700',
    edge: 'bg-neutral-400',
    dot: 'bg-neutral-400',
    reason: 'text-neutral-700',
    card: 'border-line',
    tip: 'You stopped or paused the run. Play carries on.',
  },
};

/** Where a run's time goes. The colors are fixed so a strip reads the same on every card and theme. */
export const PHASE: Record<RunPhase, { label: string; color: string }> = {
  [RunPhase.Thinking]: { label: 'Thinking', color: '#a89be0' },
  [RunPhase.Reading]: { label: 'Reading', color: '#78b8ea' },
  [RunPhase.Editing]: { label: 'Editing', color: '#55b985' },
  [RunPhase.Commands]: { label: 'Commands and tools', color: '#f0a52e' },
  [RunPhase.WaitingYou]: { label: 'Waiting on you', color: '#4e86e6' },
};

export const STAGE_LABEL: Record<RunStage, string> = {
  [RunStage.ReadTask]: 'Read task',
  [RunStage.Explore]: 'Explore',
  [RunStage.Edit]: 'Edit',
  [RunStage.RunTests]: 'Run tests',
  [RunStage.Fix]: 'Fix',
  [RunStage.Commit]: 'Commit + hooks',
  [RunStage.OpenPr]: 'Open PR',
};

export const FAILURE_LABEL: Record<FailureKind, string> = {
  [FailureKind.NetworkBlocked]: 'Network blocked',
  [FailureKind.WriteBlocked]: 'Write blocked',
  [FailureKind.RateLimited]: 'Usage limit',
  [FailureKind.SignedOut]: 'Signed out',
  [FailureKind.HookFailed]: 'Commit hook failed',
  [FailureKind.Interrupted]: 'Console restarted',
  [FailureKind.Unknown]: 'Error',
};

export const failureTone = (failure: Failure) =>
  failure.kind === FailureKind.RateLimited || failure.kind === FailureKind.SignedOut
    ? { box: 'border-warn/35 bg-warn/[0.06]', label: 'text-warn' }
    : { box: 'border-accent-300 bg-accent-100/50', label: 'text-accent-700' };

/** Tokens as `31k` or `1.2M`. */
export function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

export const money = (usd: number) => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)}`;

export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Where a run's work shows, and what to call it there. */
export function placeOf(
  session: Session,
  repoName: (id: string | null) => string,
): { to: string; where: string; what: string; tip: string } {
  switch (session.kind) {
    case SessionKind.PrReview:
      return {
        to: session.repo_id && session.pr_number ? pullRequestPath(session.repo_id, session.pr_number) : '/workspace',
        where: repoName(session.repo_id),
        what: `Pull request #${session.pr_number}`,
        tip: 'Open the pull request this run works on',
      };
    case SessionKind.Devtools:
      return { to: '/devtools', where: 'Dev tools', what: session.title, tip: 'Open this Session in Dev tools' };
    case SessionKind.Anonymous:
      return { to: sessionPath(session.id), where: 'No Repo', what: session.title, tip: 'Open this Session' };
    default:
      return {
        to: sessionPath(session.id),
        where: repoName(session.repo_id),
        what: session.title,
        tip: 'Open this Session',
      };
  }
}

/** A run's title as the lists show it: a Session says so, a pull request already does. */
export const titleOf = (session: Session, what: string) =>
  session.kind === SessionKind.PrReview ? what : `Session · ${what}`;

export const ACCESS_NAME: Record<AccessMode, string> = {
  [AccessMode.Supervised]: 'Supervised',
  [AccessMode.AcceptEdits]: 'Auto edit',
  [AccessMode.Auto]: 'Auto',
  [AccessMode.Full]: 'Full',
};

export const MODEL_NAME: Record<Model, string> = {
  [Model.Opus]: 'Opus',
  [Model.Sonnet]: 'Sonnet',
  [Model.Haiku]: 'Haiku',
  [Model.Fable]: 'Fable',
};

export const KIND_NAME: Record<SessionKind, string> = {
  [SessionKind.Repo]: 'Session',
  [SessionKind.Anonymous]: 'Session',
  [SessionKind.Devtools]: 'Dev tools',
  [SessionKind.PrReview]: 'Pull request review',
};

export function PauseIcon() {
  return (
    <span aria-hidden className="inline-flex flex-none gap-0.5">
      <span className="h-2.5 w-0.75 bg-current" />
      <span className="h-2.5 w-0.75 bg-current" />
    </span>
  );
}

export function PlayIcon() {
  return (
    <span
      aria-hidden
      className="inline-block size-0 flex-none border-y-[5px] border-l-[8px] border-y-transparent border-l-current"
    />
  );
}

export function RetryIcon() {
  return <span aria-hidden>↻</span>;
}
