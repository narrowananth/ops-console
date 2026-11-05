import { mkdir, mkdtemp, readFile, realpath, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adoptKeychainItems,
  type Codesign,
  CodesignUnavailable,
  HandoverRefused,
  makeCodesign,
  otherVersionApps,
  type RunProgram,
} from '../src/keychain/handover';
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

const IDENTIFIER = 'dev.ops-console.app';

/** A `codesign` that passes every bundle and names `identifier` for each, unless `fail` says otherwise. */
function fakeCodesign(options: { identifier?: string; fail?: (args: string[]) => Error | null } = {}) {
  const calls: string[][] = [];
  const codesign: Codesign = async (args) => {
    calls.push(args);
    const failure = options.fail?.(args);
    if (failure) throw failure;
    return args[0] === '-dv' ? `Identifier=${options.identifier ?? IDENTIFIER}\nFormat=app bundle\n` : '';
  };
  return { codesign, calls };
}

/** What every handover test hands `adoptKeychainItems` besides its own folders. */
const checked = (root: string) => ({ versionsDir: root, codesign: fakeCodesign().codesign });

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
      ...checked(root),
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
      ...checked(root),
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
        ...checked(root),
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
      ...checked(root),
    });

    expect(moved).toBe(0);
    expect(calls).toEqual([]);
    expect(await owner(ownerFile)).toBe(app('0.1.1'));
  });
});

describe('the check on the previous app', () => {
  /** Versions `names` (the last is this app) and everything `adoptKeychainItems` takes; `held` is the old app's items. */
  async function setup(codesign: Codesign, names = ['0.1.0', '0.1.1'], held = new Map([['connection:db', 'pw-1']])) {
    const { root, app } = await versions(...names);
    const self = app(names.at(-1) ?? '');
    const { run, calls } = oldApp(held);
    const keychain = new FakeKeychain();
    const ownerFile = path.join(root, 'keychain-owner.json');
    const options = {
      self,
      previous: otherVersionApps(path.dirname(path.dirname(path.dirname(path.dirname(self)))), APP),
      ownerFile,
      script: 'keychain-handover.mjs',
      service: 'ops-console',
      keychain,
      run,
      versionsDir: root,
      codesign,
    };
    return { root, app, options, calls, keychain, ownerFile };
  }

  /** The handover is refused with a reason matching `reason`: nothing taken, nothing written, no owner recorded. */
  async function expectRefused(setupResult: Awaited<ReturnType<typeof setup>>, reason: RegExp) {
    const error = await adoptKeychainItems(setupResult.options).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HandoverRefused);
    expect((error as HandoverRefused).reason).toMatch(reason);
    expect(setupResult.calls).toEqual([]);
    expect(setupResult.keychain.values.size).toBe(0);
    await expect(readFile(setupResult.ownerFile, 'utf8')).rejects.toThrow();
  }

  /** A fake `codesign` that fails `--verify` for the bundles whose path holds `version`. */
  const failingFor = (version: string) =>
    fakeCodesign({
      fail: (args) => (args[0] === '--verify' && String(args[2]).includes(version) ? new Error('invalid') : null),
    });

  it('hands over when the bundle passes `codesign` and carries this app’s identifier (Behavior 1, 2)', async () => {
    const { codesign, calls: signed } = fakeCodesign();
    const { options, app } = await setup(codesign);

    expect(await adoptKeychainItems(options)).toBe(1);
    const bundle = await realpath(app('0.1.0').slice(0, app('0.1.0').indexOf('.app') + '.app'.length));
    expect(signed).toContainEqual(['--verify', '--strict', bundle]);
  });

  it('refuses, taking and writing nothing, when the bundle fails `codesign --verify` (Behavior 3)', async () => {
    const { codesign } = fakeCodesign({
      fail: (args) => (args[0] === '--verify' ? new Error('a sealed resource is missing or invalid') : null),
    });
    await expectRefused(await setup(codesign), /--verify --strict/);
  });

  it('refuses when its bundle identifier differs from this app’s (Behavior 2)', async () => {
    const codesign: Codesign = async (args) => {
      if (args[0] !== '-dv') return '';
      return `Identifier=${String(args[1]).includes('0.1.0') ? 'com.example.other' : IDENTIFIER}\n`;
    };
    await expectRefused(await setup(codesign), /com\.example\.other/);
  });

  it('refuses when `codesign` cannot run, and says the tool failed (Behavior 4)', async () => {
    const { codesign } = fakeCodesign({ fail: () => new CodesignUnavailable('could not start (ENOENT)') });
    await expectRefused(await setup(codesign), /`codesign` could not run/);
  });

  it('refuses a recorded owner that fails the check, and does not try the newest version instead (Behavior 5)', async () => {
    const { codesign, calls: signed } = failingFor('0.1.0');
    const result = await setup(codesign, ['0.1.0', '0.1.1', '0.1.2']);
    await writeFile(result.ownerFile, JSON.stringify({ executable: result.app('0.1.0') }));

    await expect(adoptKeychainItems(result.options)).rejects.toBeInstanceOf(HandoverRefused);

    expect(result.calls).toEqual([]);
    expect(signed.some((args) => args.some((arg) => arg.includes('0.1.1')))).toBe(false);
    expect(await owner(result.ownerFile)).toBe(result.app('0.1.0'));
  });

  it('refuses a recorded owner outside the versions folder (Behavior 2, 5)', async () => {
    const result = await setup(fakeCodesign().codesign, ['0.1.1']);
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'elsewhere-'));
    const planted = path.join(elsewhere, APP);
    await mkdir(path.dirname(planted), { recursive: true });
    await writeFile(planted, '');
    await writeFile(result.ownerFile, JSON.stringify({ executable: planted }));

    await expect(adoptKeychainItems(result.options)).rejects.toMatchObject({
      reason: expect.stringMatching(/version folder/),
    });
    expect(result.calls).toEqual([]);
  });

  it('refuses an owner inside this app’s own version folder (Behavior 2)', async () => {
    const result = await setup(fakeCodesign().codesign, ['0.1.1']);
    const sibling = path.join(path.dirname(result.options.self), '..', '..', 'Other.app/Contents/MacOS/Other');
    await mkdir(path.dirname(sibling), { recursive: true });
    await writeFile(sibling, '');
    await writeFile(result.ownerFile, JSON.stringify({ executable: sibling }));

    await expect(adoptKeychainItems(result.options)).rejects.toMatchObject({
      reason: expect.stringMatching(/version folder/),
    });
    expect(result.calls).toEqual([]);
  });

  it('refuses a path that reaches another folder through a link inside versions (Behavior 2)', async () => {
    const result = await setup(fakeCodesign().codesign, ['0.1.1']);
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'elsewhere-'));
    await mkdir(path.join(elsewhere, 'Ops Console.app/Contents/MacOS'), { recursive: true });
    await writeFile(path.join(elsewhere, APP), '');
    await symlink(elsewhere, path.join(result.root, '0.1.0'));
    result.options.previous = [path.join(result.root, '0.1.0', APP)];

    await expect(adoptKeychainItems(result.options)).rejects.toBeInstanceOf(HandoverRefused);
    expect(result.calls).toEqual([]);
  });

  it('accepts a version folder whose name starts with two dots (Behavior 2)', async () => {
    const result = await setup(fakeCodesign().codesign, ['..old', '0.1.1']);
    expect(await adoptKeychainItems(result.options)).toBe(1);
  });

  it('checks only the newest version when no owner is recorded, and does not fall back to an older one (Behavior 7)', async () => {
    const { codesign, calls: signed } = failingFor('0.1.1');
    const result = await setup(codesign, ['0.1.0', '0.1.1', '0.1.2']);

    await expect(adoptKeychainItems(result.options)).rejects.toBeInstanceOf(HandoverRefused);
    expect(result.calls).toEqual([]);
    expect(signed.some((args) => args.some((arg) => arg.includes('0.1.0')))).toBe(false);
  });

  it('does not run `codesign` for a recorded owner that is gone (Behavior 6)', async () => {
    const { codesign, calls: signed } = fakeCodesign({ fail: () => new Error('never reached') });
    const result = await setup(codesign, ['0.1.1']);
    await writeFile(result.ownerFile, JSON.stringify({ executable: path.join(result.root, 'gone', APP) }));

    expect(await adoptKeychainItems(result.options)).toBe(0);
    expect(signed).toEqual([]);
    expect(await owner(result.ownerFile)).toBe(result.app('0.1.1'));
  });

  it('keeps no state between starts: a refused app passes on the next start once it is fixed (Behavior 8)', async () => {
    let broken = true;
    const codesign: Codesign = async (args) => {
      if (args[0] === '--verify' && broken) throw new Error('invalid');
      return args[0] === '-dv' ? `Identifier=${IDENTIFIER}\n` : '';
    };
    const result = await setup(codesign);
    await expectRefused(result, /--verify --strict/);

    broken = false;
    expect(await adoptKeychainItems(result.options)).toBe(1);
  });
});

describe('the system `codesign`', () => {
  const SECRET = 'pw-1';

  /** A `codesign` program in a fresh folder, the only one on PATH while `work` runs. */
  async function withCodesign<T>(script: string | null, work: () => Promise<T>): Promise<T> {
    const bin = await mkdtemp(path.join(tmpdir(), 'bin-'));
    if (script !== null) await writeFile(path.join(bin, 'codesign'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      return await work();
    } finally {
      process.env.PATH = saved;
    }
  }

  /** The handover through the real runner of `limitMs`, with a secret waiting in the old app. */
  async function refusal(script: string | null, limitMs = 10_000) {
    const { root, app } = await versions('0.1.0', '0.1.1');
    const { run, calls } = oldApp(new Map([['connection:db', SECRET]]));
    const ownerFile = path.join(root, 'keychain-owner.json');
    const error = await withCodesign(script, () =>
      adoptKeychainItems({
        self: app('0.1.1'),
        previous: [app('0.1.0')],
        ownerFile,
        script: 'keychain-handover.mjs',
        service: 'ops-console',
        keychain: new FakeKeychain(),
        run,
        versionsDir: root,
        codesign: makeCodesign(limitMs),
      }).then(
        () => null,
        (caught: unknown) => caught,
      ),
    );
    expect(error).toBeInstanceOf(HandoverRefused);
    expect(calls).toEqual([]);
    return (error as HandoverRefused).reason;
  }

  it('refuses when `codesign` is not installed (Behavior 4)', async () => {
    expect(await refusal(null)).toBe('`codesign` could not run: could not start (ENOENT)');
  });

  it('refuses when `codesign` runs past its limit (Behavior 4)', async () => {
    expect(await refusal('exec /bin/sleep 30', 200)).toBe(
      '`codesign` could not run: did not finish within 0.2 seconds',
    );
  });

  it('refuses with the first line of what `codesign` printed, without the bundle path, and no secret (Behavior 3, 11)', async () => {
    const reason = await refusal(
      'echo "/some/where/Ops Console.app: a sealed resource is missing or invalid" >&2\necho "In architecture: arm64e" >&2\nexit 1',
    );
    expect(reason).toBe('its bundle fails `codesign --verify --strict`: a sealed resource is missing or invalid');
    expect(reason).not.toContain(SECRET);
  });

  it('refuses with the exit code when `codesign` fails silently (Behavior 3)', async () => {
    expect(await refusal('exit 3')).toBe('its bundle fails `codesign --verify --strict`: exited with 3');
  });
});
