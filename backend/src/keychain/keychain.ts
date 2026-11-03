import { AsyncEntry } from '@napi-rs/keyring';

export const KEYCHAIN = Symbol('KEYCHAIN');

/** Secrets by key in the login Keychain (ADR 0004). Values are read at the moment of use and never logged. */
export interface Keychain {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/**
 * `service` keeps `pnpm dev`'s items (`ops-console-dev`) apart from the installed app's (`ops-console`). Every use
 * waits for `ready`: the handover of the items to this app, which would ask for the password once per item if
 * this app reached for one first.
 */
export class LoginKeychain implements Keychain {
  constructor(
    private readonly service = 'ops-console',
    private readonly ready: Promise<unknown> = Promise.resolve(),
  ) {}

  async set(key: string, value: string): Promise<void> {
    await this.ready;
    await new AsyncEntry(this.service, key).setPassword(value);
  }

  async get(key: string): Promise<string | null> {
    await this.ready;
    return (await new AsyncEntry(this.service, key).getPassword()) ?? null;
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    await new AsyncEntry(this.service, key).deletePassword();
  }
}
