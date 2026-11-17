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
