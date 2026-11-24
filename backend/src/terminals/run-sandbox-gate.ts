import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { RunSandbox } from '@ops-console/shared';
import { LINUX_RUN_SANDBOX_PENDING, LINUX_RUN_SANDBOX_VERIFIED } from '../agent/run-sandbox';

const run = promisify(execFile);

export const RUN_SANDBOX = Symbol('RUN_SANDBOX');

/** Whether the Run sandbox works on this machine, tested with a trivial command each time it is read. */
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

/** Runs a program with no shell; rejects when it is missing or exits non-zero. */
export type Program = (file: string, args: string[]) => Promise<unknown>;

const runProgram: Program = (file, args) => run(file, args, { timeout: 5_000 });

/** The install command for the pieces the Agent SDK's Linux sandbox needs, per package manager. */
const installWith = (packages: string[]): string =>
  `Debian or Ubuntu: \`sudo apt install ${packages.join(' ')}\`; Fedora: \`sudo dnf install ${packages.join(' ')}\`; Arch: \`sudo pacman -S ${packages.join(' ')}\``;

/**
 * bubblewrap, on Linux and WSL2. The row names the first piece that is missing; once all are there it says the sandbox
 * is on only when `LINUX_RUN_SANDBOX_VERIFIED` is true, since runs do not start before the Linux spike has settled the
 * rules.
 */
export class BubblewrapRunSandbox implements RunSandboxGate {
  constructor(
    private readonly options: {
      program?: Program;
      kernel?: () => Promise<string>;
      verified?: boolean;
    } = {},
  ) {}

  async check(): Promise<RunSandbox> {
    const program = this.options.program ?? runProgram;
    const unavailable = (reason: string): RunSandbox => ({ status: 'unavailable', reason });
    const kernel = await (this.options.kernel ?? readKernel)();
    if (/microsoft/i.test(kernel) && !/wsl2/i.test(kernel)) {
      return unavailable('Sandboxing needs WSL2: this distribution runs WSL1. Upgrade it with `wsl --set-version`');
    }
    const names = [
      ...((await works(program, 'bwrap', ['--version'])) ? [] : ['bubblewrap']),
      ...((await works(program, 'socat', ['-V'])) ? [] : ['socat']),
    ];
    if (names.length > 0) {
      return unavailable(
        `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} not installed. ${installWith(names)}`,
      );
    }
    try {
      // The namespaces a run's commands get: their own user and network, over a read-only view of the disk.
      await program('bwrap', ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true']);
    } catch (error) {
      return unavailable(`bubblewrap cannot start a sandbox: ${firstLine(error)}${NAMESPACE_HINT}`);
    }
    return (this.options.verified ?? LINUX_RUN_SANDBOX_VERIFIED)
      ? { status: 'on', reason: null }
      : unavailable(LINUX_RUN_SANDBOX_PENDING);
  }
}

/** On Ubuntu 24.04 AppArmor limits the user namespaces bubblewrap needs. */
const NAMESPACE_HINT =
  '. On Ubuntu this is usually AppArmor limiting unprivileged user namespaces: allow /usr/bin/bwrap in an AppArmor profile';

async function works(program: Program, file: string, args: string[]): Promise<boolean> {
  try {
    await program(file, args);
    return true;
  } catch {
    return false;
  }
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split('\n').filter(Boolean);
  return (lines.at(-1) ?? text).slice(0, 200);
}

async function readKernel(): Promise<string> {
  return readFile('/proc/version', 'utf8').catch(() => '');
}

/** The Run sandbox gate for this machine's system. */
export function runSandboxGate(platform: NodeJS.Platform = process.platform): RunSandboxGate {
  return platform === 'linux' ? new BubblewrapRunSandbox() : new SeatbeltRunSandbox();
}
