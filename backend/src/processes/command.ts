import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Runs a program with no shell and returns its output. `lsof` and `ps` exit non-zero when nothing matches; that is an empty answer. */
export async function output(file: string, args: string[]): Promise<string> {
  try {
    return (await run(file, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (
      error instanceof Error &&
      'stdout' in error &&
      typeof error.stdout === 'string' &&
      !('killed' in error && error.killed)
    ) {
      return error.stdout;
    }
    throw error;
  }
}
