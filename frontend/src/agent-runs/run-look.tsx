import {
  AccessMode,
  type AgentRun,
  type Failure,
  FailureKind,
  Model,
  PHASE_ORDER,
  RunHealth,
  RunOutcome,
  RunPhase,
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

/** Where a run's time goes. The colors are fixed so a bar reads the same on every card, lane and theme. */
export const PHASE: Record<RunPhase, { label: string; color: string }> = {
  [RunPhase.Thinking]: { label: 'Thinking', color: '#a89be0' },
  [RunPhase.Reading]: { label: 'Reading', color: '#78b8ea' },
  [RunPhase.Editing]: { label: 'Editing', color: '#55b985' },
  [RunPhase.Commands]: { label: 'Commands and tools', color: '#f0a52e' },
  [RunPhase.Subagents]: { label: 'Subagents', color: '#2fb5a8' },
  [RunPhase.WaitingYou]: { label: 'Waiting on you', color: '#4e86e6' },
  [RunPhase.WaitingLimit]: { label: 'Waiting on limit', color: '#e5484d' },
};

/** The phases in the order a legend lists them. */
export const PHASES = PHASE_ORDER;

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

/** Tokens as `812`, `31k` or `1.2M`. */
export function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

/** Dollars: cents under $100, whole dollars above, and "<$0.01" for a trace. */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

/** `1.2M tok · $0.84`: the one way tokens and cost read together, on the page, the tray and the header. */
export const usageLine = (tokenCount: number | null, costUsd: number | null): string =>
  [tokenCount ? `${tokens(tokenCount)} tok` : null, costUsd !== null ? money(costUsd) : null]
    .filter(Boolean)
    .join(' · ');

/** The usage cell of a run, never cut short; null when the run has no usage. */
export const usageText = (run: AgentRun): string | null =>
  run.cost_usd === null && !run.tokens ? null : usageLine(run.tokens, run.cost_usd);

const count = (n: number) => n.toLocaleString('en-US');

/** The tooltip of the usage cell: each token kind, main agent against subagents, and the SDK's own figure. */
export function usageTip(run: AgentRun): string {
  const usage = run.usage;
  if (!usage) return 'The console kept no token counts for this run.';
  const kinds = (t: { input: number; output: number; cache_read: number; cache_write: number }) =>
    `input ${count(t.input)} · output ${count(t.output)} · cache read ${count(t.cache_read)} · cache write ${count(t.cache_write)}`;
  const lines = [
    `Run: ${kinds(usage.total.tokens)} = ${money(usage.total.cost_usd)}`,
    `Main agent: ${kinds(usage.main.tokens)} = ${money(usage.main.cost_usd)}`,
    `Subagents: ${kinds(usage.subagents.tokens)} = ${money(usage.subagents.cost_usd)}`,
  ];
  if (usage.models.length > 0) lines.push(`Models: ${usage.models.join(', ')}`);
  if (usage.reported_cost_usd !== null && Math.abs(usage.reported_cost_usd - usage.total.cost_usd) >= 0.01) {
    lines.push(`The SDK reported ${money(usage.reported_cost_usd)}. The console prices the counts itself.`);
  }
  return lines.join('\n');
}

/** A span for a legend: `0s` for none, `<1s` for a trace, then `42s`, `4m 05s`. */
export function legendMs(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return '<1s';
  return durationOf(ms);
}

function durationOf(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** The status word on a run's pill: the outcome for an ended run, the health for one going. */
export function statusLabel(run: AgentRun): string {
  if (run.running) return run.health === RunHealth.OnTrack ? 'working' : HEALTH[run.health].label;
  if (run.outcome === RunOutcome.RateLimited) return 'limit reached';
  if (run.outcome === RunOutcome.SignedOut) return 'signed out';
  if (run.outcome === RunOutcome.Interrupted) return 'interrupted';
  return HEALTH[run.health].label;
}

export const clock = (iso: string | number) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** A time with seconds, for axes and tooltips of runs that last seconds. */
export const clockSeconds = (iso: string | number) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

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

/** A run Play can carry on: the operator paused or stopped it, and its Session takes messages or has a way to run again. */
export const canPlay = (run: AgentRun) =>
  !run.running && run.can_retry && (run.outcome === RunOutcome.Paused || run.outcome === RunOutcome.Stopped);
