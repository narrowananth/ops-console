import { Logger } from '@nestjs/common';

/** Tasks that run at the same time once the queue opens. */
const CONCURRENCY = 2;

export type StartupTiming = {
  /** How long after the port opens the first task starts. */
  delayMs: number;
  /** How long a slot rests between one task ending and the next starting. */
  gapMs: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Background work the daemon would otherwise start all at once while it boots: the first MCP Probe, the usage poll,
 * the scans a stopped daemon missed. Services add their task in `onApplicationBootstrap`; the daemon opens the queue
 * once the port listens, after a short delay, and two tasks run at a time in the order they were added. The one
 * thread then answers the page's first requests before any of it starts.
 */
export class StartupQueue {
  private readonly logger = new Logger('startup');
  private readonly waiting: { name: string; run: () => Promise<unknown> | unknown }[] = [];
  private timing: StartupTiming | null = null;
  private active = 0;
  private stopped = false;

  /** Queues `run`; a task added after the queue opened goes to the back of the line. */
  add(name: string, run: () => Promise<unknown> | unknown): void {
    this.waiting.push({ name, run });
    if (this.timing) this.pump(this.timing);
  }

  /** Opens the queue after `delayMs`. Returns at once. */
  open(timing: StartupTiming): void {
    void sleep(timing.delayMs).then(() => {
      if (this.stopped) return;
      this.timing = timing;
      this.pump(timing);
    });
  }

  stop(): void {
    this.stopped = true;
    this.waiting.length = 0;
  }

  private pump(timing: StartupTiming): void {
    while (!this.stopped && this.active < CONCURRENCY) {
      const task = this.waiting.shift();
      if (!task) return;
      this.active += 1;
      void (async () => {
        try {
          await task.run();
        } catch (error) {
          this.logger.warn(`${task.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (timing.gapMs > 0) await sleep(timing.gapMs);
        this.active -= 1;
        this.pump(timing);
      })();
    }
  }
}
