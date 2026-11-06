import { useSyncExternalStore } from 'react';

/** `42s`, `4m 05s`, `1h 02m`: how long, to the second under an hour. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** One clock for every live counter on the page, so two of them never disagree by a tick. */
let tickNow = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    tickNow = Date.now();
    timer = setInterval(() => {
      tickNow = Date.now();
      for (const one of listeners) one();
    }, 1000);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const quiet = () => () => {};

/** The time now, a second at a time and the same for every caller, while `live`. */
export function useNow(live: boolean): number {
  const shared = useSyncExternalStore(live ? subscribe : quiet, () => tickNow);
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
