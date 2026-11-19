import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cliEnv } from '../agent/integration-cli';

const run = promisify(execFile);

const CALL_TIMEOUT_MS = 60_000;

/** `logcli` exited non-zero. `stderr` is what it printed; it may hold Loki's answer, never the secret. */
export class LogcliFailed extends Error {
  constructor(readonly stderr: string) {
    super('logcli failed');
  }
}

/** `env` carries the address, tenant and secret; the daemon's own `LOKI_*` stays out of the child. */
export async function logcli(bin: string, args: string[], env: Record<string, string>, signal?: AbortSignal) {
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
    const { stderr } = error as { stderr?: unknown };
    throw new LogcliFailed(typeof stderr === 'string' ? stderr : '');
  }
}

/**
 * What a failed `logcli` call was, from its stderr. `logcli` prints Loki's response body but never the status code
 * ("error response from server: <body> (<nil>) attempts remaining: 0", capitalized on some paths), so the body is the evidence.
 */
type LokiFailure =
  | { kind: 'auth' }
  | { kind: 'rate_limited' }
  | { kind: 'limit'; reason: string }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'other' };

const RATE_LIMITED = /\b429\b|too many (?:outstanding )?requests|rate.?limit/i;
const REFUSED_CREDENTIALS =
  /\b40[13]\b|unauthori[sz]ed|forbidden|authentication|credentials|access denied|invalid (?:token|scope)/i;
const QUERY_LIMIT = /\b(?:max(?:imum)?|limit|exceed(?:s|ed)?|too many|too large)\b/i;

const UNREACHABLE: [RegExp, string][] = [
  [/no such host|lookup /i, 'the host name was not found'],
  [/refused/i, 'the connection was refused'],
  [/x509|certificate/i, 'its TLS certificate was not accepted'],
  [/timeout|deadline|timed out/i, 'it did not answer in time'],
];

export function lokiFailure(stderr: string): LokiFailure {
  const body = /error response from server: (.*?) \(<nil>\) attempts remaining/is.exec(stderr)?.[1]?.trim();
  if (RATE_LIMITED.test(stderr)) return { kind: 'rate_limited' };
  if (body !== undefined) {
    if (REFUSED_CREDENTIALS.test(body)) return { kind: 'auth' };
    if (QUERY_LIMIT.test(body)) return { kind: 'limit', reason: body.split('\n')[0]?.slice(0, 300) ?? body };
    return { kind: 'other' };
  }
  if (/error sending request/i.test(stderr)) {
    const reason = UNREACHABLE.find(([pattern]) => pattern.test(stderr))?.[1] ?? 'it did not answer';
    return { kind: 'unreachable', reason };
  }
  return { kind: 'other' };
}
