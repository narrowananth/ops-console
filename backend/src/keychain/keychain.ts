import { AsyncEntry } from '@napi-rs/keyring';

export const KEYCHAIN = Symbol('KEYCHAIN');

/** Secrets by key in the login Keychain (ADR 0004). Values are read at the moment of use and never logged. */
export interface Keychain {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/** `service` keeps `pnpm dev`'s items (`ops-console-dev`) apart from the installed app's (`ops-console`). */
export class LoginKeychain implements Keychain {
  constructor(private readonly service = 'ops-console') {}

  async set(key: string, value: string): Promise<void> {
    await new AsyncEntry(this.service, key).setPassword(value);
  }

  async get(key: string): Promise<string | null> {
    return (await new AsyncEntry(this.service, key).getPassword()) ?? null;
  }

  async delete(key: string): Promise<void> {
    await new AsyncEntry(this.service, key).deletePassword();
  }
}
