import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Keychain } from './keychain';

/** Runs `program` with `args` and `input` on stdin, resolving to its stdout; rejects on a non-zero exit. */
export type RunProgram = (program: string, args: string[], input: string) => Promise<string>;

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
};

/**
 * Moves the console's Keychain items to this app from the app that holds them. Every release is a new ad-hoc
 * signed app, a stranger to each item, so macOS would ask for the login password once per item. The old app reads
 * them without asking and this one writes them back, so nobody is asked. Returns how many items moved.
 */
export async function adoptKeychainItems(options: HandoverOptions): Promise<number> {
  const { self, ownerFile, script, service, keychain, run = runProgram } = options;
  const recorded = readOwner(ownerFile);
  if (recorded === self) return 0;
  const from =
    recorded !== null ? (existsSync(recorded) ? recorded : null) : (options.previous.find(existsSync) ?? null);
  if (from === null) {
    writeFileSync(ownerFile, `${JSON.stringify({ executable: self })}\n`);
    return 0;
  }

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
