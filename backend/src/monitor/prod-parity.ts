import { type ReportStep, type Sample, ScanWindow } from '@ops-console/shared';
import type { DatadogReader } from './datadog';

/** The Recheck's window: the last hour, whatever the Alert's Check interval. */
const RECHECK_WINDOW = ScanWindow.Hour;

export type Recheck = { line: string; step: ReportStep };

/**
 * One read of Datadog for the Alert's query over the last hour (no model turn). It never throws: a Recheck that fails
 * says why and the run goes on.
 */
export async function recheck(reader: DatadogReader, query: string): Promise<Recheck> {
  try {
    const found = await reader.countLogs(query, RECHECK_WINDOW);
    const line = `Datadog recheck, last hour: ${found > 0 ? 'still failing' : 'not seen'}`;
    return { line, step: { kind: 'result', text: line } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    const text = `Recheck failed: ${reason}`;
    return { line: `Datadog recheck, last hour: could not be read (${reason})`, step: { kind: 'warning', text } };
  }
}

/** The `version:` tag of the newest Sample that has one. */
export function deployedVersion(samples: Sample[]): string | null {
  const newest = [...samples].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  for (const sample of newest) {
    const tag = sample.tags.find((candidate) => candidate.startsWith('version:'));
    const value = tag?.slice('version:'.length).trim();
    if (value) return value;
  }
  return null;
}

/** A version names the commit when it is a prefix of it; under 7 characters it could be anything. */
function sameCommit(version: string, sha: string): boolean {
  const v = version.toLowerCase();
  return v.length >= 7 && sha.toLowerCase().startsWith(v);
}

/** The Report step that sets what prod ran against the commit the scratch copy was cut at. */
export function versionStep(version: string | null, sha: string, branch: string): ReportStep {
  const at = `verified at \`${sha.slice(0, 7)}\` of \`${branch}\``;
  if (version === null) return { kind: 'warning', text: `prod version unknown; ${at}` };
  const ran = `prod ran \`${version}\`; ${at}`;
  return sameCommit(version, sha)
    ? { kind: 'result', text: ran }
    : { kind: 'warning', text: `${ran}; the console cannot confirm they match` };
}

/** What the agent is asked to write about how its run differed from prod, in a Report and in a pull request. */
export const PROD_PARITY_ASK =
  'four lines, each saying what in this run matched prod, what was mocked or read from a development Connection, and what could not be checked: Code version, Data, Configuration and environment, Dependencies';
