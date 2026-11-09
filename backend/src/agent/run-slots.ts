/** Job runs going at once, when nothing sets another number. */
export const DEFAULT_JOB_RUN_LIMIT = 3;

/**
 * A fixed number of places for the runs a job starts (an Agent Review, a Verification, a Fix and the rest). Each one
 * boots its own Claude Code process with every Connection's MCP server and may run the tests, so a handful at once
 * slows the whole console. A run past the limit waits its turn, first come first served.
 */
export class RunSlots {
  private going = 0;
  private readonly waiting: { start: () => void; drop: () => void }[] = [];

  constructor(private readonly limit: number) {}

  /** Runs with a place, and runs waiting for one. */
  counts(): { going: number; waiting: number } {
    return { going: this.going, waiting: this.waiting.length };
  }

  /**
   * Resolves with the function that gives the place back, once there is one. `onWait` is called at once when the run
   * has to wait. Rejects when `signal` aborts first, holding no place.
   */
  acquire(signal: AbortSignal, onWait?: (ahead: number) => void): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    if (this.going < this.limit) return Promise.resolve(this.take());
    return new Promise((resolve, reject) => {
      const entry = {
        start: () => {
          signal.removeEventListener('abort', entry.drop);
          resolve(this.take());
        },
        drop: () => {
          const at = this.waiting.indexOf(entry);
          if (at >= 0) this.waiting.splice(at, 1);
          reject(new Error('aborted'));
        },
      };
      signal.addEventListener('abort', entry.drop, { once: true });
      this.waiting.push(entry);
      onWait?.(this.going + this.waiting.length - 1);
    });
  }

  /** Takes a place; the function it returns gives it back once, and hands it to the run waiting longest. */
  private take(): () => void {
    this.going += 1;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.going -= 1;
      this.waiting.shift()?.start();
    };
  }
}
