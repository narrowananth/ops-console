import { AsyncEntry } from '@napi-rs/keyring';
import { ErrorCode, KEYCHAIN_WAIT_MESSAGE } from '@ops-console/shared';
import { ApiError } from '../common/errors';
import type { KeychainWaitTracker } from './keychain-wait';

export const KEYCHAIN = Symbol('KEYCHAIN');

/** Secrets by key in the login Keychain (ADR 0004). Values are read at the moment of use and never logged. */
export interface Keychain {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/** One call waits this long for the Mac to answer, then fails. */
export const CALL_LIMIT_MS = 60_000;
/** A call waits this long for the handover of the items to this app, then fails. */
export const HANDOVER_LIMIT_MS = 90_000;

/** A Keychain call the Mac did not answer in time, usually because it waits for the login password. */
export class KeychainTimeout extends ApiError {
  constructor() {
    super(503, ErrorCode.KeychainTimeout, KEYCHAIN_WAIT_MESSAGE);
  }
}

/** The part of a Keychain item `LoginKeychain` uses; tests pass a fake that never answers. */
export interface KeychainEntry {
  setPassword(value: string): Promise<void>;
  getPassword(): Promise<string | null | undefined>;
  deletePassword(): Promise<unknown>;
}

export type LoginKeychainOptions = {
  entry?: (service: string, key: string) => KeychainEntry;
  wait?: KeychainWaitTracker;
  callMs?: number;
  handoverMs?: number;
};

/**
 * Fails with `KeychainTimeout` when `work` has not settled in `ms`. The native call cannot be cancelled: whatever it
 * does later is dropped.
 */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new KeychainTimeout()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * `service` keeps `pnpm dev`'s items (`ops-console-dev`) apart from the installed app's (`ops-console`). Every use
 * waits for `ready`: the handover of the items to this app, which would ask for the password once per item if
 * this app reached for one first. The wait for `ready` ends after 90 seconds and each call after 60; both fail with
 * `keychain_timeout`, and the tracker shows the call from the moment it starts.
 */
export class LoginKeychain implements Keychain {
  private readonly entry: (service: string, key: string) => KeychainEntry;
  private readonly callMs: number;
  private readonly handoverMs: number;

  constructor(
    private readonly service = 'ops-console',
    private readonly ready: Promise<unknown> = Promise.resolve(),
    private readonly options: LoginKeychainOptions = {},
  ) {
    this.entry = options.entry ?? ((name, key) => new AsyncEntry(name, key));
    this.callMs = options.callMs ?? CALL_LIMIT_MS;
    this.handoverMs = options.handoverMs ?? HANDOVER_LIMIT_MS;
  }

  async set(key: string, value: string): Promise<void> {
    await this.call((entry) => entry.setPassword(value), key);
  }

  async get(key: string): Promise<string | null> {
    return (await this.call((entry) => entry.getPassword(), key)) ?? null;
  }

  async delete(key: string): Promise<void> {
    await this.call((entry) => entry.deletePassword(), key);
  }

  private async call<T>(use: (entry: KeychainEntry) => Promise<T>, key: string): Promise<T> {
    const done = this.options.wait?.begin();
    try {
      await within(this.ready, this.handoverMs);
      return await within(use(this.entry(this.service, key)), this.callMs);
    } finally {
      done?.();
    }
  }
}
