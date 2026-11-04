import { useEffect, useState } from 'react';

/** `42s`, `4m 05s`, `1h 02m`: how long, to the second under an hour. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** The time now, a second at a time, while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
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
