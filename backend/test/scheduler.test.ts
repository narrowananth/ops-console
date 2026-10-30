import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonLogger } from '../src/common/logger';
import { everyMinutes, type Job, Scheduler } from '../src/scheduler/scheduler';

const at = (time: string) => new Date(`2026-10-30T${time}:00.000Z`);

function job(overrides: Partial<Job> & { runs: Date[] }): Job {
  return {
    name: 'scan',
    nextSlot: everyMinutes(15),
    lastRunAt: () => null,
    run: () => {
      overrides.runs.push(new Date());
    },
    ...overrides,
  };
}

describe('scheduler', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new Scheduler();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('runs a job at each slot while the daemon runs', async () => {
    vi.setSystemTime(at('10:05'));
    const runs: Date[] = [];
    scheduler.register(job({ runs }));
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(runs).toEqual([at('10:15'), at('10:30'), at('10:45')]);
  });

  it('runs a job once at start when slots passed while the daemon was stopped', async () => {
    vi.setSystemTime(at('12:07'));
    const runs: Date[] = [];
    scheduler.register(job({ runs, lastRunAt: () => at('09:00') }));
    await scheduler.start();
    expect(runs).toEqual([at('12:07')]);

    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(runs).toEqual([at('12:07'), at('12:15')]);
  });

  it('does not run at start when no slot passed since the last run', async () => {
    vi.setSystemTime(at('12:07'));
    const runs: Date[] = [];
    scheduler.register(job({ runs, lastRunAt: () => at('12:01') }));
    await scheduler.start();
    expect(runs).toEqual([]);
  });

  it('logs a job that throws and runs it again at its next slot', async () => {
    vi.setSystemTime(at('10:05'));
    const log: string[] = [];
    Logger.overrideLogger(new DaemonLogger((line) => log.push(line)));
    const runs: Date[] = [];
    let calls = 0;
    scheduler.register(
      job({
        runs,
        run: () => {
          calls++;
          if (calls === 1) throw new Error('Datadog timed out');
          runs.push(new Date());
        },
      }),
    );
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runs).toEqual([]);
    expect(log.join('\n')).toMatch(/job scan failed: Datadog timed out/);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(runs).toEqual([at('10:30')]);
  });
});
