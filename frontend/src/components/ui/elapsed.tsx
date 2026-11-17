import { useSyncExternalStore } from 'react';

/** `42s`, `4m 05s`, `1h 02m`: how long, to the second under an hour. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** A clock every live counter of one step shares, so two of them never disagree by a tick. */
type Clock = { now: number; timer: ReturnType<typeof setInterval> | undefined; listeners: Set<() => void> };
const clocks = new Map<number, Clock>();

function clockOf(step: number): Clock {
  const clock = clocks.get(step) ?? { now: Date.now(), timer: undefined, listeners: new Set() };
  clocks.set(step, clock);
  return clock;
}

function subscribeTo(step: number): (listener: () => void) => () => void {
  return (listener) => {
    const clock = clockOf(step);
    if (clock.listeners.size === 0) {
      clock.now = Date.now();
      clock.timer = setInterval(() => {
        clock.now = Date.now();
        for (const one of clock.listeners) one();
      }, step);
    }
    clock.listeners.add(listener);
    return () => {
      clock.listeners.delete(listener);
      if (clock.listeners.size === 0 && clock.timer !== undefined) {
        clearInterval(clock.timer);
        clock.timer = undefined;
      }
    };
  };
}

const quiet = () => () => {};
const subscribers = new Map<number, ReturnType<typeof subscribeTo>>();

/** The time now, `step` ms at a time (a second by default) and the same for every caller of that step, while `live`. */
export function useNow(live: boolean, step = 1000): number {
  const subscribe = subscribers.get(step) ?? subscribeTo(step);
  subscribers.set(step, subscribe);
  const shared = useSyncExternalStore(live ? subscribe : quiet, () => clockOf(step).now);
  // Not live: the moment of this render, which nothing counts on.
  return live ? shared : Date.now();
}

/**
 * How long the agent has been at it: counts up each second from `from` while `running`, then holds the total to `to`.
 * `took` words a finished one as "took 4m 05s". One that ended with no end time, from before times were kept, shows
 * nothing rather than counting on.
 */
export function Elapsed({
  from,
  to,
  running,
  took = false,
  className = '',
}: {
  from: string | null;
  to: string | null;
  running: boolean;
  took?: boolean;
  className?: string;
}) {
  const live = running && from !== null;
  const now = useNow(live);
  if (from === null || (!live && to === null)) return null;
  const start = Date.parse(from);
  const ms = (live ? now : Date.parse(to as string)) - start;
  const text = duration(ms);
  return (
    <time
      dateTime={`PT${Math.max(0, Math.floor(ms / 1000))}S`}
      title={live ? `Running since ${new Date(start).toLocaleTimeString()}` : `Took ${text}`}
      className={`font-mono text-xs tabular-nums whitespace-nowrap text-neutral-700 ${className}`}
    >
      {!live && took ? `took ${text}` : text}
    </time>
  );
}
