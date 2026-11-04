import os from 'node:os';
import path from 'node:path';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';

export type SandboxRun = {
  /** The folder the run writes in: its scratch copy, or the checkout. */
  workingDir: string;
  /** The folder the daemon runs on: `state.db`, `runtime.json` and every scratch copy sit in it. */
  dataDir: string;
  /** Folders outside the working folder the run may read, such as the Session's attached files. */
  readable?: string[];
  /** A Fix reads `~/.ssh` so its PR stage can push; every other run denies it (ADR 0006). */
  readSsh?: boolean;
  home?: string;
};

const TEMP = ['/tmp', '/private/tmp'];

/**
 * The Run sandbox for one agent run (ADR 0006): macOS Seatbelt through the SDK. Commands write only in the working
 * folder and the temp folders, and read neither the data folder, which holds the session token, nor the operator's
 * cloud and Keychain credentials. The working folder stays readable though it sits inside the data folder. The run
 * fails when the sandbox is unavailable and can never ask to leave it. The network stays open.
 */
export function runSandbox(run: SandboxRun): SandboxSettings {
  const home = run.home ?? os.homedir();
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    // The Access mode, not the sandbox, decides which commands ask.
    autoAllowBashIfSandboxed: false,
    // Go programs such as `gh` check certificates through macOS's trust service, which the sandbox blocks without it.
    // The network is open anyway (ADR 0006), so this gives up nothing more.
    enableWeakerNetworkIsolation: true,
    filesystem: {
      allowWrite: [run.workingDir, ...TEMP],
      denyRead: [
        run.dataDir,
        path.join(home, '.aws'),
        path.join(home, '.config', 'gcloud'),
        path.join(home, 'Library', 'Keychains'),
        ...(run.readSsh ? [] : [path.join(home, '.ssh')]),
      ],
      allowRead: [run.workingDir, ...(run.readable ?? [])],
    },
  };
}
