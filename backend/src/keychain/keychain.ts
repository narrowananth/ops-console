import { AsyncEntry } from '@napi-rs/keyring';

export const KEYCHAIN = Symbol('KEYCHAIN');

const SERVICE = 'ops-console';

/** Secrets by key in the login Keychain (ADR 0004). Values are read at the moment of use and never logged. */
export interface Keychain {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export class LoginKeychain implements Keychain {
  async set(key: string, value: string): Promise<void> {
    await new AsyncEntry(SERVICE, key).setPassword(value);
  }

  async get(key: string): Promise<string | null> {
    return (await new AsyncEntry(SERVICE, key).getPassword()) ?? null;
  }

  async delete(key: string): Promise<void> {
    await new AsyncEntry(SERVICE, key).deletePassword();
  }
}
