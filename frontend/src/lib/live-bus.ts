import type { WsEvent } from '@ops-console/shared';

export type Listener = (event: WsEvent) => void;

/** Everyone who wants each event the console's one socket brings: components while mounted, and `waitForEvent`. */
export const listeners = new Set<Listener>();

/** Resolves true when `/ws` brings an event `match` accepts, false after `ms`. `stop` ends the wait early. */
export function waitForEvent(
  match: (event: WsEvent) => boolean,
  ms: number,
): { done: Promise<boolean>; stop: () => void } {
  let stop = () => {};
  const done = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      resolve(false);
    }, ms);
    const listener: Listener = (event) => {
      if (!match(event)) return;
      stop();
      resolve(true);
    };
    stop = () => {
      clearTimeout(timer);
      listeners.delete(listener);
    };
    listeners.add(listener);
  });
  return { done, stop };
}
