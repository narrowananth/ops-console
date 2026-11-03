import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adoptKeychainItems, otherVersionApps, type RunProgram } from '../src/keychain/handover';
import { FakeKeychain } from './fakes/keychain';

const APP = 'Ops Console.app/Contents/MacOS/Ops Console';

/** Installed versions with an app each, under a fresh `versions` folder; the last one is the newest. */
async function versions(...names: string[]): Promise<{ root: string; app: (name: string) => string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'versions-'));
  const app = (name: string) => path.join(root, name, APP);
  for (const [index, name] of names.entries()) {
    await mkdir(path.dirname(app(name)), { recursive: true });
    await writeFile(app(name), '');
    const at = new Date(Date.UTC(2026, 0, 1 + index));
    await utimes(app(name), at, at);
  }
  return { root, app };
}

/** The old app's side of the handover: `take` empties `held`, `put` fills it again. */
function oldApp(held: Map<string, string>): { run: RunProgram; calls: string[] } {
  const calls: string[] = [];
  const run: RunProgram = async (program, args, input) => {
    calls.push(`${program} ${args[1]}`);
    if (args[1] === 'take') {
      const taken = Object.fromEntries(held);
      held.clear();
      return JSON.stringify(taken);
    }
    for (const [account, secret] of Object.entries(JSON.parse(input) as Record<string, string>)) {
      held.set(account, secret);
    }
    return '';
  };
  return { run, calls };
}

const owner = async (file: string) => JSON.parse(await readFile(file, 'utf8')).executable;

describe('Keychain items after an update', () => {
  it("moves every item from the previous version's app to this one, then records this one", async () => {
    const { root, app } = await versions('0.1.0', '0.1.1');
    const held = new Map([
      ['connection:db', 'pw-1'],
      ['mcp:sentry', 'pw-2'],
    ]);
    const { run, calls } = oldApp(held);
    const keychain = new FakeKeychain();
    const ownerFile = path.join(root, 'keychain-owner.json');

    const moved = await adoptKeychainItems({
      self: app('0.1.1'),
      previous: otherVersionApps(path.join(root, '0.1.1'), APP),
      ownerFile,
      script: 'keychain-handover.mjs',
      service: 'ops-console',
      keychain,
      run,
    });

    expect(moved).toBe(2);
    expect(calls).toEqual([`${app('0.1.0')} take`]);
    expect(Object.fromEntries(keychain.values)).toEqual({ 'connection:db': 'pw-1', 'mcp:sentry': 'pw-2' });
    expect(await owner(ownerFile)).toBe(app('0.1.1'));
  });

  it('takes from the recorded app, and does nothing once this app holds the items', async () => {
    const { root, app } = await versions('0.1.0', '0.1.1', '0.1.2');
    const ownerFile = path.join(root, 'keychain-owner.json');
    await writeFile(ownerFile, JSON.stringify({ executable: app('0.1.0') }));
    const { run, calls } = oldApp(new Map([['connection:db', 'pw-1']]));
    const options = {
      self: app('0.1.2'),
      previous: otherVersionApps(path.join(root, '0.1.2'), APP),
      ownerFile,
      script: 'keychain-handover.mjs',
      service: 'ops-console',
      keychain: new FakeKeychain(),
      run,
    };

    expect(await adoptKeychainItems(options)).toBe(1);
    expect(await adoptKeychainItems(options)).toBe(0);
    expect(calls).toEqual([`${app('0.1.0')} take`]);
  });

  it('gives the items back to the old app when this one cannot write them', async () => {
    const { root, app } = await versions('0.1.0', '0.1.1');
    const held = new Map([['connection:db', 'pw-1']]);
    const { run, calls } = oldApp(held);
    const keychain = new FakeKeychain();
    keychain.set = async () => {
      throw new Error('write refused');
    };
    const ownerFile = path.join(root, 'keychain-owner.json');

    await expect(
      adoptKeychainItems({
        self: app('0.1.1'),
        previous: [app('0.1.0')],
        ownerFile,
        script: 'keychain-handover.mjs',
        service: 'ops-console',
        keychain,
        run,
      }),
    ).rejects.toThrow('write refused');

    expect(calls).toEqual([`${app('0.1.0')} take`, `${app('0.1.0')} put`]);
    expect(Object.fromEntries(held)).toEqual({ 'connection:db': 'pw-1' });
    await expect(readFile(ownerFile, 'utf8')).rejects.toThrow();
  });

  it('records this app and moves nothing when no older app is left', async () => {
    const { root, app } = await versions('0.1.1');
    const ownerFile = path.join(root, 'keychain-owner.json');
    await writeFile(ownerFile, JSON.stringify({ executable: path.join(root, 'gone', APP) }));
    const { run, calls } = oldApp(new Map());

    const moved = await adoptKeychainItems({
      self: app('0.1.1'),
      previous: otherVersionApps(path.join(root, '0.1.1'), APP),
      ownerFile,
      script: 'keychain-handover.mjs',
      service: 'ops-console',
      keychain: new FakeKeychain(),
      run,
    });

    expect(moved).toBe(0);
    expect(calls).toEqual([]);
    expect(await owner(ownerFile)).toBe(app('0.1.1'));
  });
});
