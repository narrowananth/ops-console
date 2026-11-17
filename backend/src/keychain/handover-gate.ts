/**
 * Which Keychain keys the handover to this app still holds back. A key waits only until its own item has moved,
 * so a read of an item already moved is not held up by the rest.
 */
export class HandoverGate {
  /** Keys still to move; `null` while the handover has not yet said which items there are. */
  private pending: Set<string> | null = null;
  private finished = false;
  private readonly listeners = new Set<() => void>();

  /** The handover found these items to move; every other key is free from now on. */
  expect(keys: Iterable<string>): void {
    this.pending = new Set(keys);
    this.notify();
  }

  /** The item under `key` is in place. */
  moved(key: string): void {
    this.pending?.delete(key);
    this.notify();
  }

  /** The handover ended, moved or not: nothing waits any longer. */
  finish(): void {
    this.finished = true;
    this.notify();
  }

  /** Resolves once `key` is free to use. */
  waitFor(key: string): Promise<void> {
    if (this.free(key)) return Promise.resolve();
    return new Promise((resolve) => {
      const listener = () => {
        if (!this.free(key)) return;
        this.listeners.delete(listener);
        resolve();
      };
      this.listeners.add(listener);
    });
  }

  private free(key: string): boolean {
    return this.finished || (this.pending !== null && !this.pending.has(key));
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
