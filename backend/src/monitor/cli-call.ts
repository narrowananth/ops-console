import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cliEnv } from '../agent/integration-cli';

const run = promisify(execFile);

const CALL_TIMEOUT_MS = 60_000;

/** A log CLI exited non-zero or ran out of time. `stderr` is what it printed; it may hold the service's answer, never the secret. */
export class CliFailed extends Error {
  constructor(
    readonly stderr: string,
    /** Stopped by the time cap, not by its own failure. */
    readonly timedOut: boolean,
  ) {
    super('cli failed');
  }
}

/** `env` carries the address and secret; the daemon's own variables of the CLI stay out of the child. */
export async function callCli(bin: string, args: string[], env: Record<string, string>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    const pending = run(bin, args, {
      env: { ...cliEnv(), ...env },
      maxBuffer: 50 * 1024 * 1024,
      timeout: CALL_TIMEOUT_MS,
      signal,
    });
    pending.child.stdin?.end();
    return (await pending).stdout;
  } catch (error) {
    // A stopped Scan is the caller's to end, not an upstream failure.
    if (signal?.aborted) throw signal.reason;
    const { stderr, killed } = error as { stderr?: unknown; killed?: unknown };
    throw new CliFailed(typeof stderr === 'string' ? stderr : '', killed === true);
  }
}

export const RATE_LIMITED = /\b429\b|too many (?:outstanding )?requests|rate.?limit/i;

const UNREACHABLE: [RegExp, string][] = [
  [/no such host|lookup /i, 'the host name was not found'],
  [/refused/i, 'the connection was refused'],
  [/x509|certificate/i, 'its TLS certificate was not accepted'],
  [/timeout|deadline|timed out/i, 'it did not answer in time'],
];

/** Why a request that never got an answer failed, from the CLI's stderr. */
export const unreachableReason = (stderr: string): string =>
  UNREACHABLE.find(([pattern]) => pattern.test(stderr))?.[1] ?? 'it did not answer';
