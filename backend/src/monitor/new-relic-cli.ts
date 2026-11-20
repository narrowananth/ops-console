import { CliFailed, RATE_LIMITED, unreachableReason } from './cli-call';

/** The smallest query that proves the key, account and region work. An account with no logs answers with a count of 0. */
export const HEALTH_QUERY = 'SELECT count(*) FROM Log SINCE 1 minute ago';

/**
 * What a failed `newrelic nrql query` call was, from its stderr and whether the time cap stopped it. The CLI ends a
 * failed query with `log.Fatal`, so the client's error text is the evidence.
 */
type NewRelicFailure =
  | { kind: 'auth' }
  | { kind: 'rate_limited' }
  | { kind: 'unreachable'; reason: string }
  /** New Relic refused the query, or gave up on it. `reason` is its own words. */
  | { kind: 'refused'; reason: string }
  | { kind: 'other' };

const REFUSED_KEY = /\b40[13]\b|unauthori[sz]ed|forbidden|invalid (?:api )?key/i;
const NO_ANSWER = /dial tcp|no such host|connection refused|x509|tls:|i\/o timeout|error sending request/i;
const TIMED_OUT = /time[d ]?-?out|took longer|deadline exceeded/i;
const REJECTED_QUERY = /\b400\b|syntax|bad request|invalid|unexpected|not supported/i;

/** The message of the CLI's last log line: its `msg="..."` value, else the first line. */
function reasonOf(stderr: string): string {
  const quoted = /msg="((?:[^"\\]|\\.)*)"/.exec(stderr)?.[1];
  const text =
    quoted === undefined
      ? (stderr.split('\n').find((line) => line.trim() !== '') ?? '')
      : quoted.replace(/\\(.)/g, '$1');
  return text.trim().slice(0, 300);
}

export function newRelicFailure({ stderr, timedOut }: CliFailed): NewRelicFailure {
  if (RATE_LIMITED.test(stderr)) return { kind: 'rate_limited' };
  if (REFUSED_KEY.test(stderr)) return { kind: 'auth' };
  if (NO_ANSWER.test(stderr)) return { kind: 'unreachable', reason: unreachableReason(stderr) };
  if (timedOut) return { kind: 'refused', reason: 'the query did not finish in time' };
  if (TIMED_OUT.test(stderr) || REJECTED_QUERY.test(stderr)) return { kind: 'refused', reason: reasonOf(stderr) };
  return { kind: 'other' };
}
