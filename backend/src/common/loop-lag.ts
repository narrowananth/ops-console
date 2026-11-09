import { monitorEventLoopDelay } from 'node:perf_hooks';

/** A stall this long, seen in a check, is worth a line in the log. */
const WARN_AT_MS = 1000;
const CHECK_EVERY_MS = 30_000;

/**
 * Watches how long the daemon's one thread goes without answering, and logs a warning when a stall passes a second.
 * Everything shares that thread: requests, the socket, every agent's stream and the database. The warning says when
 * the console felt slow, so a slow spell can be set against what was running. Returns the function that stops it.
 */
export function watchLoopLag(warn: (message: string) => void): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    const worst = histogram.max / 1e6;
    const typical = histogram.percentile(99) / 1e6;
    histogram.reset();
    if (worst >= WARN_AT_MS) {
      warn(
        `the daemon stalled for ${Math.round(worst)} ms in the last ${CHECK_EVERY_MS / 1000} s (p99 ${Math.round(typical)} ms)`,
      );
    }
  }, CHECK_EVERY_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
