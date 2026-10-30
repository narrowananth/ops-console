import type { Keychain } from '../../src/keychain/keychain';

/** Tests never touch the login Keychain. */
export class FakeKeychain implements Keychain {
  readonly values = new Map<string, string>();

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
