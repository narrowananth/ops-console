import { ErrorCode } from '@ops-console/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type KeychainEntry, KeychainTimeout, LoginKeychain } from '../src/keychain/keychain';
import { KeychainWaitTracker } from '../src/keychain/keychain-wait';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A native Keychain item the Mac answers when the test says so, as when the operator types the password. */
class PromptingEntry implements KeychainEntry {
  readonly answers: (() => void)[] = [];
  stored: string | null = 'secret';

  private ask<T>(answer: () => T): Promise<T> {
    return new Promise<T>((resolve) => this.answers.push(() => resolve(answer())));
  }

  setPassword(value: string): Promise<void> {
    return this.ask(() => {
      this.stored = value;
    });
  }

  getPassword(): Promise<string | null> {
    return this.ask(() => this.stored);
  }

  deletePassword(): Promise<void> {
    return this.ask(() => {
      this.stored = null;
    });
  }
}

const NOTHING = Symbol('pending');
async function settled<T>(promise: Promise<T>): Promise<T | typeof NOTHING> {
  return Promise.race([promise, Promise.resolve(NOTHING)]);
}

describe('Keychain call limits', () => {
  it('answers a call the Mac answers in time (Behavior 16)', async () => {
    const entry = new PromptingEntry();
    const keychain = new LoginKeychain('t', undefined, { entry: () => entry });
    const got = keychain.get('k');
    await vi.advanceTimersByTimeAsync(5_000);
    entry.answers[0]?.();
    await expect(got).resolves.toBe('secret');
  });

  it('fails a get, set and delete with keychain_timeout after 60 seconds (Behavior 11)', async () => {
    const entry = new PromptingEntry();
    const keychain = new LoginKeychain('t', undefined, { entry: () => entry });
    for (const call of [() => keychain.get('k'), () => keychain.set('k', 'v'), () => keychain.delete('k')]) {
      const pending = call();
      const failed = expect(pending).rejects.toMatchObject({ code: ErrorCode.KeychainTimeout, status: 503 });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(await settled(pending.catch(() => 'failed'))).toBe(NOTHING);
      await vi.advanceTimersByTimeAsync(1);
      await failed;
    }
  });

  it('takes an answer that comes after the timeout without a second outcome (Behavior 11)', async () => {
    const entry = new PromptingEntry();
    const keychain = new LoginKeychain('t', undefined, { entry: () => entry });
    const outcomes: string[] = [];
    const pending = keychain.set('k', 'late').then(
      () => outcomes.push('stored'),
      (error: unknown) => outcomes.push(error instanceof KeychainTimeout ? 'timeout' : 'other'),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    // The operator types the password after all. A late result must not surface as a second outcome or an
    // unhandled rejection, which vitest would report.
    entry.answers[0]?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcomes).toEqual(['timeout']);
  });

  it('waits at most 90 seconds for the handover, then 60 more for the call (Behavior 12)', async () => {
    const entry = new PromptingEntry();
    let handed: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      handed = resolve;
    });
    const keychain = new LoginKeychain('t', ready, { entry: () => entry });

    const stuck = keychain.get('k');
    const stuckFailed = expect(stuck).rejects.toBeInstanceOf(KeychainTimeout);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(entry.answers).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await stuckFailed;

    // A handover that ends at 80 seconds starts the call's own 60 seconds then.
    const later = new LoginKeychain('t', new Promise<void>((r) => setTimeout(r, 80_000)), { entry: () => entry });
    const got = later.get('k');
    await vi.advanceTimersByTimeAsync(80_000);
    expect(entry.answers).toHaveLength(1);
    entry.answers[0]?.();
    await expect(got).resolves.toBe('secret');
    handed();
  });

  it('names the wait in the error and never carries the secret (Behavior 16)', async () => {
    const entry = new PromptingEntry();
    const keychain = new LoginKeychain('t', undefined, { entry: () => entry });
    const pending = keychain.set('connection:1', 'hunter2');
    const failed = pending.catch((error: unknown) => error as Error);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = (await failed) as Error;
    expect(error.message).toBe("Keychain is waiting for the Mac's password prompt");
    expect(error.message).not.toContain('hunter2');
    expect(error.message).not.toContain('connection:1');
  });
});

describe('Keychain wait tracker', () => {
  it('shows nothing for a call under 10 seconds (Behavior 14)', async () => {
    const wait = new KeychainWaitTracker();
    const heard: unknown[] = [];
    wait.onChange((state) => heard.push(state));
    const done = wait.begin();
    await vi.advanceTimersByTimeAsync(9_999);
    done();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heard).toEqual([]);
    expect(wait.state()).toEqual({ waiting: false, since: null, pending: 0 });
  });

  it('shows the wait at 10 seconds with the oldest call’s start, and clears when the last ends (Behavior 14)', async () => {
    const wait = new KeychainWaitTracker();
    const heard: unknown[] = [];
    wait.onChange((state) => heard.push(state));
    const first = wait.begin();
    const startedAt = new Date().toISOString();
    await vi.advanceTimersByTimeAsync(4_000);
    const second = wait.begin();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(heard).toEqual([{ waiting: true, since: startedAt, pending: 2 }]);

    first();
    expect(heard.at(-1)).toEqual({ waiting: true, since: expect.any(String), pending: 1 });
    second();
    expect(heard.at(-1)).toEqual({ waiting: false, since: null, pending: 0 });
    expect(heard).toHaveLength(3);
  });

  it('tells when a call starts or ends while the wait shows, and only then (Behavior 14)', async () => {
    const wait = new KeychainWaitTracker();
    const heard: { waiting: boolean; pending: number }[] = [];
    wait.onChange(({ waiting, pending }) => heard.push({ waiting, pending }));
    const first = wait.begin();
    const early = wait.begin();
    early();
    await vi.advanceTimersByTimeAsync(10_000);
    const late = wait.begin();
    late();
    first();
    expect(heard).toEqual([
      { waiting: true, pending: 1 },
      { waiting: true, pending: 2 },
      { waiting: true, pending: 1 },
      { waiting: false, pending: 0 },
    ]);
  });

  it('clears when the pending call times out (Behavior 14)', async () => {
    const wait = new KeychainWaitTracker();
    const entry = new PromptingEntry();
    const keychain = new LoginKeychain('t', undefined, { entry: () => entry, wait });
    const pending = keychain.get('k').catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(wait.state()).toMatchObject({ waiting: true, pending: 1 });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await pending).toBeInstanceOf(KeychainTimeout);
    expect(wait.state()).toEqual({ waiting: false, since: null, pending: 0 });
  });
});
