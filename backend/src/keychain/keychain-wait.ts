import type { KeychainWait } from '@ops-console/shared';

export const KEYCHAIN_WAIT = Symbol('KEYCHAIN_WAIT');

/** A Keychain call pending this long is a Keychain wait: the Mac is probably asking for the login password. */
export const WAIT_SHOWN_MS = 10_000;

/**
 * The Keychain calls the daemon has sent and the Mac has not answered. `state()` says whether any has waited past
 * `thresholdMs`; listeners hear each change of that state. A call that timed out is no longer pending.
 */
export class KeychainWaitTracker {
  private readonly started = new Map<symbol, number>();
  private readonly timers = new Map<symbol, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(state: KeychainWait) => void>();
  private last: KeychainWait = { waiting: false, since: null, pending: 0 };
  /** Once shown, the wait stays until every pending call has ended: the Mac's prompt is probably still up. */
  private latched = false;

  constructor(private readonly thresholdMs = WAIT_SHOWN_MS) {}

  /** Marks a call as pending; the returned function marks it answered or given up on. */
  begin(): () => void {
    const id = Symbol('keychain call');
    this.started.set(id, Date.now());
    const timer = setTimeout(() => this.publish(), this.thresholdMs);
    timer.unref();
    this.timers.set(id, timer);
    this.publish();
    return () => {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.started.delete(id);
      this.publish();
    };
  }

  state(): KeychainWait {
    const oldest = Math.min(...this.started.values());
    const waiting = this.started.size > 0 && (this.latched || Date.now() - oldest >= this.thresholdMs);
    return { waiting, since: waiting ? new Date(oldest).toISOString() : null, pending: this.started.size };
  }

  /** Called with the state each time `waiting` flips, and when `pending` changes while it is true. */
  onChange(listener: (state: KeychainWait) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    const next = this.state();
    const changed = next.waiting !== this.last.waiting || (next.waiting && next.pending !== this.last.pending);
    this.last = next;
    this.latched = next.waiting;
    if (changed) for (const listener of this.listeners) listener(next);
  }
}
