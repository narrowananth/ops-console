import { Logger } from '@nestjs/common';

export type Job = {
  name: string;
  /** The first slot strictly after `after`. */
  nextSlot: (after: Date) => Date;
  run: () => Promise<void> | void;
  /** Rebuilt on start from the owning spec's rows; `null` when the job never ran. */
  lastRunAt: () => Promise<Date | null> | Date | null;
};

/** Slots every `minutes` minutes, aligned to the hour. */
export function everyMinutes(minutes: number): (after: Date) => Date {
  const step = minutes * 60_000;
  return (after) => new Date((Math.floor(after.getTime() / step) + 1) * step);
}

/** In-process timers, no queue. A missed slot runs once at start, however many slots were missed. */
export class Scheduler {
  private readonly logger = new Logger('scheduler');
  private readonly jobs: Job[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private started = false;

  register(job: Job): void {
    if (this.jobs.some((existing) => existing.name === job.name))
      throw new Error(`job ${job.name} is registered twice`);
    this.jobs.push(job);
    if (this.started) this.arm(job, new Date());
  }

  async start(): Promise<void> {
    this.started = true;
    const now = new Date();
    for (const job of this.jobs) {
      const last = await job.lastRunAt();
      // Runs in the background so a slow catch-up does not hold up the daemon's start.
      if (last !== null && job.nextSlot(last) <= now) void this.runOnce(job);
      this.arm(job, now);
    }
  }

  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private arm(job: Job, after: Date): void {
    const slot = job.nextSlot(after);
    const timer = setTimeout(
      async () => {
        await this.runOnce(job);
        // A timer that fires a moment early must not run the same slot twice.
        if (this.started) this.arm(job, new Date(Math.max(Date.now(), slot.getTime())));
      },
      Math.max(0, slot.getTime() - Date.now()),
    );
    timer.unref();
    this.timers.set(job.name, timer);
  }

  private async runOnce(job: Job): Promise<void> {
    try {
      await job.run();
    } catch (error) {
      this.logger.error(`job ${job.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
