import { ProcessState, type Scripts, type SessionProcess } from '@ops-console/shared';

export type Runner = Scripts['runner'];

/** The command a script starts as: `pnpm run dev`. */
export const scriptCommand = (runner: Runner, script: string): string => `${runner} run ${script}`;

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
