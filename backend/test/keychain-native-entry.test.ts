import { ErrorCode } from '@ops-console/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructed: unknown[][] = [];
let failToOpen: Error | null = null;

vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    constructor(...args: unknown[]) {
      constructed.push(args);
      if (failToOpen) throw failToOpen;
    }
    async getPassword() {
      return 'value';
    }
    async setPassword() {}
    async deletePassword() {}
  },
}));

const { LoginKeychain, SecretServiceUnavailable } = await import('../src/keychain/keychain');

beforeEach(() => {
  constructed.length = 0;
  failToOpen = null;
});

describe('the native item behind the Keychain (ADR 0004)', () => {
  it('is pinned to the Secret Service on Linux, so the library never falls back to the kernel keyring (Behavior 16, 17)', async () => {
    await new LoginKeychain('t', undefined, { platform: 'linux' }).get('connection:a');
    expect(constructed).toEqual([['t', 'connection:a', { linux: { store: 'secret-service' } }]]);
  });

  it('reads no secret when the pinned store cannot open, and refuses a save with the reason (Behavior 16)', async () => {
    failToOpen = new Error('no Secret Service is available');
    const keychain = new LoginKeychain('t', undefined, { platform: 'linux' });
    await expect(keychain.get('connection:a')).resolves.toBeNull();
    await expect(keychain.delete('connection:a')).resolves.toBeUndefined();
    const refused = await keychain.set('connection:a', 'x').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SecretServiceUnavailable);
    expect(refused).toMatchObject({ status: 409, code: ErrorCode.InvalidState });
    await expect(keychain.availability()).resolves.toMatchObject({ available: false, store: 'secret_service' });
  });

  it('leaves a failure to open on a Mac as the error it was (Behavior 34)', async () => {
    failToOpen = new Error('keychain locked');
    const keychain = new LoginKeychain('t', undefined, { platform: 'darwin' });
    await expect(keychain.get('connection:a')).rejects.not.toBeInstanceOf(SecretServiceUnavailable);
  });
});
