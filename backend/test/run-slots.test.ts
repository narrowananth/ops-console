import { describe, expect, it } from 'vitest';
import { RunSlots } from '../src/agent/run-slots';

describe('RunSlots', () => {
  it('hands out places up to the limit, then makes runs wait in order', async () => {
    const slots = new RunSlots(2);
    const signal = new AbortController().signal;
    const first = await slots.acquire(signal);
    await slots.acquire(signal);
    const order: string[] = [];
    const ahead: number[] = [];
    const third = slots.acquire(signal, (n) => ahead.push(n)).then(() => order.push('third'));
    const fourth = slots.acquire(signal, (n) => ahead.push(n)).then(() => order.push('fourth'));
    expect(slots.counts()).toEqual({ going: 2, waiting: 2 });
    expect(ahead).toEqual([2, 3]);
    first();
    await third;
    expect(order).toEqual(['third']);
    expect(slots.counts()).toEqual({ going: 2, waiting: 1 });
    void fourth;
  });

  it('gives a place back once, however often the release is called', async () => {
    const slots = new RunSlots(1);
    const release = await slots.acquire(new AbortController().signal);
    release();
    release();
    expect(slots.counts()).toEqual({ going: 0, waiting: 0 });
  });

  it('drops a waiting run that aborts, holding no place and taking none from the next', async () => {
    const slots = new RunSlots(1);
    const release = await slots.acquire(new AbortController().signal);
    const abort = new AbortController();
    const dropped = slots.acquire(abort.signal);
    const next = slots.acquire(new AbortController().signal);
    abort.abort();
    await expect(dropped).rejects.toThrow('aborted');
    expect(slots.counts()).toEqual({ going: 1, waiting: 1 });
    release();
    await next;
    expect(slots.counts()).toEqual({ going: 1, waiting: 0 });
  });

  it('refuses at once a run already aborted', async () => {
    const slots = new RunSlots(1);
    const abort = new AbortController();
    abort.abort();
    await expect(slots.acquire(abort.signal)).rejects.toThrow('aborted');
    expect(slots.counts()).toEqual({ going: 0, waiting: 0 });
  });
});
