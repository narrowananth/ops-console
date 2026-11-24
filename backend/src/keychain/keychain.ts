import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AsyncEntry } from '@napi-rs/keyring';
import { ErrorCode, KEYCHAIN_WAIT_MESSAGE, type KeychainAvailability } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import type { KeychainWaitTracker } from './keychain-wait';

export const KEYCHAIN = Symbol('KEYCHAIN');

/** Secrets by key in the login Keychain (ADR 0004). Values are read at the moment of use and never logged. */
export interface Keychain {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  /** Whether secrets can be stored on this machine; absent where the system always can. */
  availability?(): Promise<KeychainAvailability>;
}

/** One call waits this long for the Mac to answer, then fails. */
export const CALL_LIMIT_MS = 60_000;
/** A call waits this long for the handover of the items to this app, then fails. */
export const HANDOVER_LIMIT_MS = 90_000;
/**
 * Native calls in flight at once. Each holds a libuv thread while the Mac waits for a password, so a few prompts
 * cannot take every thread the daemon's files, DNS and crypto share.
 */
export const NATIVE_CALLS = 2;

/** The availability probe gives the Secret Service this long to answer before it counts a pending prompt as an answer. */
export const PROBE_LIMIT_MS = 5_000;
/** An item no one writes: reading it asks the Secret Service for nothing but whether it answers. */
const PROBE_KEY = 'availability-probe';

/** A Keychain call the Mac did not answer in time, usually because it waits for the login password. */
export class KeychainTimeout extends ApiError {
  constructor() {
    super(503, ErrorCode.KeychainTimeout, KEYCHAIN_WAIT_MESSAGE);
  }
}

/** Secrets need a Secret Service the console could not reach. Linux only: a Mac always has its Keychain. */
export class SecretServiceUnavailable extends ApiError {
  constructor(readonly detail: string) {
    super(
      409,
      ErrorCode.InvalidState,
      `No Secret Service answered: ${detail}. Secrets need a desktop keyring such as GNOME Keyring or KWallet, running in this login session.`,
    );
  }
}

/**
 * A native error that says the operator or the keyring refused the call, so a Secret Service is there. "Permission
 * denied" is no such word: a failed connect to the bus socket says it too.
 */
const REFUSED = /dismiss|cancel|locked|unlock|prompt/i;
/** A native error that says nothing answered on the bus. The spike confirms the wording on each system. */
const NO_SERVICE = /ServiceUnknown|NoStorageAccess|org\.freedesktop\.secrets|not activatable|no secret service|d-?bus/i;

/**
 * Whether a native error means no Secret Service is reachable, as against one that is there and refused or failed.
 * Only the first lets a read or a delete count as "nothing stored".
 */
export function secretServiceMissing(error: unknown, busReachable: boolean): boolean {
  const text = error instanceof Error ? error.message : String(error);
  if (REFUSED.test(text)) return false;
  return !busReachable || NO_SERVICE.test(text);
}

/** Whether this login session has a D-Bus session bus to reach a Secret Service on. */
export function sessionBusReachable(env: NodeJS.ProcessEnv = process.env): boolean {
  const address = env.DBUS_SESSION_BUS_ADDRESS;
  if (address) {
    const socket = /unix:path=([^,;]+)/.exec(address)?.[1];
    return socket === undefined || existsSync(socket);
  }
  return env.XDG_RUNTIME_DIR !== undefined && existsSync(path.join(env.XDG_RUNTIME_DIR, 'bus'));
}

/** The first line of a native error, cut short: what the Permissions row and a failed save show. */
function detailOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split('\n')[0] ?? text).slice(0, 200) || 'the call failed';
}

/**
 * A native item, pinned on Linux to the Secret Service: left alone, the library falls back to the kernel keyutils
 * keyring when no Secret Service runs, which would keep a secret in kernel memory and report secrets as storable
 * (ADR 0004). A pinned store makes the constructor throw instead. The option is ignored on other systems.
 */
export function nativeEntry(service: string, key: string): KeychainEntry {
  return new AsyncEntry(service, key, { linux: { store: 'secret-service' } });
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
  nativeCalls?: number;
  probeMs?: number;
  /** Whether a D-Bus session bus exists; tests pass a fixed answer. */
  busReachable?: () => boolean;
  /** The system the console runs on, for the checks that differ: Linux has a Secret Service, not a Keychain. */
  platform?: NodeJS.Platform;
  /** Where the keys this console holds are listed, so the next handover reads them directly. Never holds a value. */
  manifestFile?: string;
};

const manifestSchema = z.object({ keys: z.array(z.string()) });

/** What a Keychain call waits on before it reaches for its item. */
type Gate = { waitFor(key: string): Promise<unknown> };

/** Runs at most `limit` jobs at once; the rest wait their turn. */
class Slots {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        // An async wrapper turns a throw before the job returns a promise (a native item that fails to open) into a
        // rejection, so the slot is freed and a queued call does not wait out its limit.
        (async () => job())()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.queue.shift()?.();
          });
      };
      if (this.active < this.limit) start();
      else this.queue.push(start);
    });
  }
}

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
 * `service` keeps `pnpm dev`'s items (`ops-console-dev`) apart from the installed app's (`ops-console`). A use of a key
 * waits for the handover of that item to this app, which would ask for the password if this app reached for it
 * first; the wait ends after 90 seconds and each call after 60, both failing with `keychain_timeout`, and the tracker
 * shows the call from the moment it starts. A call made while the tracker already shows a wait fails at once: the
 * Mac's prompt is up. A value read or written stays in memory, since only this app writes it.
 */
export class LoginKeychain implements Keychain {
  private readonly entry: (service: string, key: string) => KeychainEntry;
  private readonly callMs: number;
  private readonly handoverMs: number;
  private readonly gate: Gate;
  private readonly slots: Slots;
  private readonly values = new Map<string, string>();
  /** Every key this app holds. `trusted` once a file or a finished handover says the list is complete. */
  private readonly keys = new Set<string>();
  private trusted = false;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly service = 'ops-console',
    ready: Promise<unknown> | Gate = Promise.resolve(),
    private readonly options: LoginKeychainOptions = {},
  ) {
    this.entry = options.entry ?? nativeEntry;
    this.callMs = options.callMs ?? CALL_LIMIT_MS;
    this.handoverMs = options.handoverMs ?? HANDOVER_LIMIT_MS;
    this.slots = new Slots(options.nativeCalls ?? NATIVE_CALLS);
    this.platform = options.platform ?? process.platform;
    this.gate = ready instanceof Promise ? { waitFor: () => ready } : ready;
    this.loadManifest();
  }

  async set(key: string, value: string): Promise<void> {
    await this.write(key, value, true);
  }

  /** Writes an item the handover moves to this app, without waiting for the handover that is doing it. */
  async moveIn(key: string, value: string): Promise<void> {
    await this.write(key, value, false);
  }

  private async write(key: string, value: string, gated: boolean): Promise<void> {
    await this.call((entry) => entry.setPassword(value), key, gated);
    this.values.set(key, value);
    this.remember(key, true);
  }

  async get(key: string): Promise<string | null> {
    const kept = this.values.get(key);
    if (kept !== undefined) return kept;
    let value: string | null;
    try {
      value = (await this.call((entry) => entry.getPassword(), key)) ?? null;
    } catch (error) {
      // With no Secret Service nothing was ever stored, so there is nothing to read.
      if (error instanceof SecretServiceUnavailable) return null;
      throw error;
    }
    if (value !== null) this.values.set(key, value);
    return value;
  }

  async delete(key: string): Promise<void> {
    try {
      await this.call((entry) => entry.deletePassword(), key);
    } catch (error) {
      // As with a read: with no Secret Service the item is already gone. Only a save needs one.
      if (!(error instanceof SecretServiceUnavailable)) throw error;
    }
    this.values.delete(key);
    this.remember(key, false);
  }

  /**
   * Whether this machine can store secrets. A Mac always can. On Linux the Secret Service must answer a read: a read
   * still pending after `probeMs` is a keyring waiting for its unlock prompt, so it counts as answering.
   */
  async availability(): Promise<KeychainAvailability> {
    const store = this.platform === 'linux' ? 'secret_service' : 'keychain';
    const available: KeychainAvailability = { available: true, reason: null, store };
    if (this.platform !== 'linux' || this.options.wait?.state().waiting) return available;
    try {
      await within(
        this.slots.run(() => this.open(PROBE_KEY).getPassword()),
        this.options.probeMs ?? PROBE_LIMIT_MS,
      );
    } catch (error) {
      // A refusal or a failure of any other kind came from a Secret Service that is there; only a missing one is "unavailable".
      if (error instanceof SecretServiceUnavailable) {
        return { available: false, reason: `no Secret Service answered: ${error.detail}`, store };
      }
      if (!(error instanceof KeychainTimeout) && secretServiceMissing(error, this.bus())) {
        return { available: false, reason: `no Secret Service answered: ${detailOf(error)}`, store };
      }
    }
    return available;
  }

  /** The keys this app holds, for a handover to read directly; `null` until a start has made the list complete. */
  manifest(): string[] | null {
    return this.trusted ? [...this.keys].sort() : null;
  }

  /** Says the keys seen so far, and `more`, are all there are, and keeps the list from now on. */
  confirmManifest(more: string[] = []): void {
    for (const key of more) this.keys.add(key);
    this.trusted = true;
    this.saveManifest();
  }

  private remember(key: string, held: boolean): void {
    if (held) this.keys.add(key);
    else this.keys.delete(key);
    if (this.trusted) this.saveManifest();
  }

  private loadManifest(): void {
    if (!this.options.manifestFile) return;
    try {
      const { keys } = manifestSchema.parse(JSON.parse(readFileSync(this.options.manifestFile, 'utf8')));
      for (const key of keys) this.keys.add(key);
      this.trusted = true;
    } catch {
      // No list yet: the handover scans the login keychain once, and this app lists what it moved.
    }
  }

  private saveManifest(): void {
    const file = this.options.manifestFile;
    if (!file) return;
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ keys: [...this.keys].sort() })}\n`);
    renameSync(temp, file);
  }

  /**
   * The native item for `key`. On Linux the pinned store makes the constructor throw when no Secret Service is
   * there, which is the library's own word for it: no text matching needed.
   */
  private open(key: string): KeychainEntry {
    try {
      return this.entry(this.service, key);
    } catch (error) {
      if (this.platform === 'linux') throw new SecretServiceUnavailable(detailOf(error));
      throw error;
    }
  }

  private bus(): boolean {
    return (this.options.busReachable ?? sessionBusReachable)();
  }

  private async call<T>(use: (entry: KeychainEntry) => Promise<T>, key: string, gated = true): Promise<T> {
    if (this.options.wait?.state().waiting) throw new KeychainTimeout();
    const done = this.options.wait?.begin();
    let abandoned = false;
    try {
      if (gated) await within(this.gate.waitFor(key), this.handoverMs);
      // A call that gave up while it queued does not start its native call afterwards.
      return await within(
        this.slots.run(() => (abandoned ? Promise.reject(new KeychainTimeout()) : use(this.open(key)))),
        this.callMs,
      );
    } catch (error) {
      abandoned = true;
      if (this.platform === 'linux' && !(error instanceof ApiError)) {
        if (secretServiceMissing(error, this.bus())) throw new SecretServiceUnavailable(detailOf(error));
        // The Secret Service is there and said no, as when its unlock prompt is dismissed.
        throw new ApiError(502, ErrorCode.UpstreamFailed, `The Secret Service refused the call: ${detailOf(error)}`);
      }
      throw error;
    } finally {
      done?.();
    }
  }
}
