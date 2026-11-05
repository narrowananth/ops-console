import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Keychain } from './keychain';

/** Runs `program` with `args` and `input` on stdin, resolving to its stdout; rejects on a non-zero exit. */
export type RunProgram = (program: string, args: string[], input: string) => Promise<string>;

/** Runs `codesign` with `args`, resolving to what it printed; rejects on a non-zero exit, `CodesignUnavailable` when it cannot run. */
export type Codesign = (args: string[]) => Promise<string>;

/** `codesign` is missing, would not start, or did not finish in time: the check could not be made. */
export class CodesignUnavailable extends Error {}

/** The handover was declined because the previous app failed its check. `reason` is shown to the operator; it holds no secret. */
export class HandoverRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'HandoverRefused';
  }
}

export const CODESIGN_LIMIT_MS = 10_000;

export type HandoverOptions = {
  /** This app's executable, which the Keychain items move to. */
  self: string;
  /** Other installed versions' app executables, newest first: where the items are when no owner is recorded. */
  previous: string[];
  /** Records which executable holds the items now. */
  ownerFile: string;
  /** `keychain-handover.mjs`, which the old app runs to hand its items over. */
  script: string;
  service: string;
  keychain: Keychain;
  run?: RunProgram;
  /** The folder holding every installed version; the previous app must sit in one of them, not in this app's. */
  versionsDir: string;
  codesign?: Codesign;
};

/**
 * Moves the console's Keychain items to this app from the app that holds them. Every release is a new ad-hoc
 * signed app, a stranger to each item, so macOS would ask for the login password once per item. The old app reads
 * them without asking and this one writes them back, so nobody is asked. Returns how many items moved.
 *
 * The previous app is checked first (`verifyPreviousApp`); one that fails refuses the handover with `HandoverRefused`
 * before anything is taken or written.
 */
export async function adoptKeychainItems(options: HandoverOptions): Promise<number> {
  const { self, ownerFile, script, service, keychain, run = runProgram, versionsDir, codesign = runCodesign } = options;
  const recorded = readOwner(ownerFile);
  if (recorded === self) return 0;
  const from =
    recorded !== null ? (existsSync(recorded) ? recorded : null) : (options.previous.find(existsSync) ?? null);
  if (from === null) {
    writeFileSync(ownerFile, `${JSON.stringify({ executable: self })}\n`);
    return 0;
  }

  await verifyPreviousApp({ from, self, versionsDir, codesign });
  const taken = await run(from, [script, 'take', service], '');
  const secrets = JSON.parse(taken) as Record<string, string>;
  try {
    for (const [account, secret] of Object.entries(secrets)) await keychain.set(account, secret);
  } catch (error) {
    // The old app took them out: it puts them back, so a failed write loses none.
    await run(from, [script, 'put', service], taken);
    throw error;
  }
  writeFileSync(ownerFile, `${JSON.stringify({ executable: self })}\n`);
  return Object.keys(secrets).length;
}

/**
 * The app executable at `executable` (relative to a version folder) in every other installed version beside
 * `versionDir`, newest first.
 */
export function otherVersionApps(versionDir: string, executable: string): string[] {
  const versions = path.dirname(versionDir);
  return readdirSync(versions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && path.join(versions, entry.name) !== versionDir)
    .map((entry) => path.join(versions, entry.name, executable))
    .filter(existsSync)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function bundleOf(executable: string): string | null {
  const marker = '.app/Contents/MacOS/';
  const at = executable.indexOf(marker);
  return at === -1 ? null : executable.slice(0, at + '.app'.length);
}

const real = (target: string): string => {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

/**
 * Throws `HandoverRefused` unless `from` is an earlier build of this app: its real path sits inside another version
 * folder under `versionsDir`, its bundle passes `codesign --verify --strict`, and its bundle identifier equals this
 * app's. An ad-hoc signature names no signing authority, and a new Node makes a new `cdhash`, so neither is pinned.
 */
export async function verifyPreviousApp(options: {
  from: string;
  self: string;
  versionsDir: string;
  codesign: Codesign;
}): Promise<void> {
  const { from, self, versionsDir, codesign } = options;
  const fromReal = real(from);
  const relative = path.relative(real(versionsDir), fromReal);
  const [folder] = relative.split(path.sep);
  const ownFolder = path.relative(real(versionsDir), real(self)).split(path.sep)[0];
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || !folder || folder === ownFolder) {
    throw new HandoverRefused('its real path is not inside another installed version folder');
  }
  const bundle = bundleOf(fromReal);
  const ownBundle = bundleOf(real(self));
  if (bundle === null) throw new HandoverRefused('it is not an app bundle');
  if (ownBundle === null) throw new HandoverRefused("this app's executable is not in an app bundle");

  const check = async <T>(work: Promise<T>, failure: string): Promise<T> =>
    work.catch((error: unknown) => {
      const text = error instanceof Error ? error.message.trim().split('\n').at(-1) : String(error);
      throw new HandoverRefused(
        error instanceof CodesignUnavailable ? `\`codesign\` could not run: ${text}` : `${failure}: ${text}`,
      );
    });
  await check(codesign(['--verify', '--strict', bundle]), 'its bundle fails `codesign --verify --strict`');
  const [theirs, ours] = await Promise.all([
    check(codesign(['-dv', bundle]), 'its signature could not be read'),
    check(codesign(['-dv', ownBundle]), "this app's signature could not be read"),
  ]);
  const identifier = (output: string) => /^Identifier=(.+)$/m.exec(output)?.[1]?.trim() ?? null;
  if (identifier(theirs) === null || identifier(theirs) !== identifier(ours)) {
    throw new HandoverRefused(
      `its bundle identifier (${identifier(theirs) ?? 'none'}) differs from this app's (${identifier(ours) ?? 'none'})`,
    );
  }
}

/** The cause in `codesign`'s stderr: its first line without the bundle path, or the exit code when it printed none. */
function describeCodesignFailure(stderr: string, code: unknown): string {
  const first = stderr.split('\n').find((line) => line.trim() !== '');
  return first?.replace(/^.*?\.app: /, '').trim() || `exited with ${String(code)}`;
}

/** Runs the system `codesign`. It rejects with `CodesignUnavailable` when the tool cannot start or passes `limitMs`. */
export const makeCodesign =
  (limitMs: number): Codesign =>
  (args) =>
    new Promise((resolve, reject) => {
      execFile('codesign', args, { timeout: limitMs, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error === null) return resolve(`${stdout}${stderr}`);
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.killed) return reject(new CodesignUnavailable(`did not finish within ${limitMs / 1000} seconds`));
        if (typeof failure.code === 'string')
          return reject(new CodesignUnavailable(`could not start (${failure.code})`));
        reject(new Error(describeCodesignFailure(stderr, failure.code)));
      });
    });

const runCodesign = makeCodesign(CODESIGN_LIMIT_MS);

function readOwner(file: string): string | null {
  try {
    const owner = JSON.parse(readFileSync(file, 'utf8')) as { executable?: unknown };
    return typeof owner.executable === 'string' ? owner.executable : null;
  } catch {
    return null;
  }
}

const runProgram: RunProgram = (program, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${args[1] ?? 'handover'} failed: ${stderr.trim().split('\n').at(-1) ?? code}`));
    });
    child.stdin.end(input);
  });
