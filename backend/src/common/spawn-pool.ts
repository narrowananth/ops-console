import { AsyncLocalStorage } from 'node:async_hooks';

const background = new AsyncLocalStorage<true>();

/** Runs `work` so every process it starts waits behind the operator's own actions for a free slot. */
export function asBackground<T>(work: () => Promise<T>): Promise<T> {
  return background.run(true, work);
}

/** Caps how many processes of one kind run at once; a slot goes to an operator action before a background read. */
export class SpawnPool {
  private active = 0;
  private readonly urgent: (() => void)[] = [];
  private readonly later: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => (background.getStore() ? this.later : this.urgent).push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      // A waiter takes this slot over, so the count stays as it is.
      const next = this.urgent.shift() ?? this.later.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** `git` processes. */
export const gitPool = new SpawnPool(8);
/** `gh`, `glab` and `bkt` processes. */
export const hostCliPool = new SpawnPool(6);
