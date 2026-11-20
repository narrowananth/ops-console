import { RATE_LIMITED, unreachableReason } from './cli-call';

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

const REFUSED_CREDENTIALS =
  /\b40[13]\b|unauthori[sz]ed|forbidden|authentication|credentials|access denied|invalid (?:token|scope)/i;
const QUERY_LIMIT = /\b(?:max(?:imum)?|limit|exceed(?:s|ed)?|too many|too large)\b/i;

export function lokiFailure(stderr: string): LokiFailure {
  const body = /error response from server: (.*?) \(<nil>\) attempts remaining/is.exec(stderr)?.[1]?.trim();
  if (RATE_LIMITED.test(stderr)) return { kind: 'rate_limited' };
  if (body !== undefined) {
    if (REFUSED_CREDENTIALS.test(body)) return { kind: 'auth' };
    if (QUERY_LIMIT.test(body)) return { kind: 'limit', reason: body.split('\n')[0]?.slice(0, 300) ?? body };
    return { kind: 'other' };
  }
  if (/error sending request/i.test(stderr)) {
    return { kind: 'unreachable', reason: unreachableReason(stderr) };
  }
  return { kind: 'other' };
}
