import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunSandbox } from '@ops-console/shared';

const run = promisify(execFile);

export const RUN_SANDBOX = Symbol('RUN_SANDBOX');

/** Whether the Run sandbox works on this Mac, tested with a trivial command each time it is read. */
export interface RunSandboxGate {
  check(): Promise<RunSandbox>;
}

export class SeatbeltRunSandbox implements RunSandboxGate {
  async check(): Promise<RunSandbox> {
    if (process.platform !== 'darwin') return { status: 'unavailable', reason: 'Seatbelt exists on macOS only' };
    try {
      await run('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5_000 });
      return { status: 'on', reason: null };
    } catch (error) {
      const detail = error instanceof Error ? (error.message.split('\n').at(-1) ?? error.message) : String(error);
      return { status: 'unavailable', reason: `sandbox-exec failed: ${detail}` };
    }
  }
}
