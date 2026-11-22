import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartupQueue } from '../src/common/startup-queue';
import { everyMinutes, Scheduler } from '../src/scheduler/scheduler';

describe('start-up queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts nothing before it opens, then runs the tasks in the order they were added', async () => {
    const queue = new StartupQueue();
    const ran: string[] = [];
    for (const name of ['probe', 'usage', 'proxy']) queue.add(name, () => void ran.push(name));
    queue.open({ delayMs: 3000, gapMs: 0 });

    await vi.advanceTimersByTimeAsync(2999);
    expect(ran).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toEqual(['probe', 'usage', 'proxy']);
  });

  it('runs two tasks at a time and rests between them', async () => {
    const queue = new StartupQueue();
    let active = 0;
    let most = 0;
    const started: number[] = [];
    for (let n = 0; n < 6; n++) {
      queue.add(`task ${n}`, async () => {
        active += 1;
        most = Math.max(most, active);
        started.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 100));
        active -= 1;
      });
    }
    queue.open({ delayMs: 0, gapMs: 500 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(started).toHaveLength(6);
    expect(most).toBe(2);
    // The third task waits for a slot to end its run and its rest.
    expect((started[2] ?? 0) - (started[0] ?? 0)).toBeGreaterThanOrEqual(600);
  });

  it('keeps going when a task fails, and runs a task added after it opened', async () => {
    const queue = new StartupQueue();
    const ran: string[] = [];
    queue.add('broken', () => {
      throw new Error('boom');
    });
    queue.add('fine', () => void ran.push('fine'));
    queue.open({ delayMs: 0, gapMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    queue.add('late', () => void ran.push('late'));
    await vi.advanceTimersByTimeAsync(1);

    expect(ran).toEqual(['fine', 'late']);
  });

  it('holds the scans a stopped daemon missed until the queue opens', async () => {
    vi.setSystemTime(new Date('2026-10-30T12:07:00.000Z'));
    const queue = new StartupQueue();
    const scheduler = new Scheduler(queue);
    const ran: string[] = [];
    for (const name of ['scan-a', 'scan-b', 'scan-c']) {
      scheduler.register({
        name,
        nextSlot: everyMinutes(15),
        lastRunAt: () => new Date('2026-10-30T09:00:00.000Z'),
        run: () => void ran.push(name),
      });
    }
    await scheduler.start();
    expect(ran).toEqual([]);

    queue.open({ delayMs: 3000, gapMs: 0 });
    await vi.advanceTimersByTimeAsync(3001);
    expect(ran).toEqual(['scan-a', 'scan-b', 'scan-c']);
    scheduler.stop();
  });
});
