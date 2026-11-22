import { ProcessState, type Script, type SessionProcess } from '@ops-console/shared';
import { ascending } from '../lib/sort';

/** The scripts a folder lists, one group per tool in the order the daemon found them, each A to Z. */
export function bySource(scripts: Script[]): [string, Script[]][] {
  const groups = new Map<string, Script[]>();
  for (const script of scripts) groups.set(script.source, [...(groups.get(script.source) ?? []), script]);
  return [...groups].map(([source, list]) => [source, ascending(list, (one) => one.name)]);
}

export const isRunning = (process: SessionProcess): boolean => process.state === ProcessState.Running;

/** `running`, `exited 1` or `stopped`. */
export function stateLabel(process: SessionProcess): string {
  if (process.state === ProcessState.Exited) return `exited ${process.exit_code ?? '?'}`;
  return process.state;
}

/** The dot beside a process: green while it runs, red for an exit that failed, grey otherwise. */
export function stateTone(process: SessionProcess): 'ok' | 'failed' | 'idle' {
  if (process.state === ProcessState.Running) return 'ok';
  if (process.state === ProcessState.Exited && process.exit_code !== 0) return 'failed';
  return 'idle';
}

/** `just now`, `42s ago`, `5m ago`, `3h ago`, `2d ago`. */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** The selected process in a sentence: `Running · started 2m ago`, `Exited with code 1`, `Stopped`. */
export function stateSentence(process: SessionProcess, now: number): string {
  if (process.state === ProcessState.Running) return `Running · started ${ago(now - Date.parse(process.started_at))}`;
  if (process.state === ProcessState.Exited) return `Exited with code ${process.exit_code ?? '?'}`;
  return 'Stopped';
}
