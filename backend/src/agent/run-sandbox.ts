import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';

export type SandboxRun = {
  /** The folder the run works in: its scratch copy, or the checkout. */
  workingDir: string;
  /** The folder the run may not change: a review of pull request text, or an answer in a thread. */
  readOnly?: boolean;
  /** The working folder's `.git` is a file, as in a worktree: the run may not rewrite it. */
  gitFile?: boolean;
  /** The working folder is a Session's own worktree: the Repo's git folder and this worktree's folder in it, where its commits go. */
  gitDirs?: WorktreeGitDirs | null;
  /** Other Repos' checkouts the operator opened to this Session: their git control files stay closed like the working folder's. */
  repos?: { path: string; gitFile: boolean }[];
  home?: string;
};

export type WorktreeGitDirs = { common: string; admin: string };

/**
 * The git folders of a worktree: the `.git` file names its own folder `<common>/worktrees/<name>`, and the Repo's git
 * folder `<common>` is two levels up. Null when `.git` is not that file.
 */
export function worktreeGitDirs(workingDir: string): WorktreeGitDirs | null {
  try {
    const named = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(path.join(workingDir, '.git'), 'utf8'))?.[1];
    if (!named) return null;
    const admin = path.resolve(workingDir, named);
    const common = path.dirname(path.dirname(admin));
    return path.basename(path.dirname(admin)) === 'worktrees' ? { common, admin } : null;
  } catch {
    return null;
  }
}

/**
 * What a worktree's commits write, which its run may not: the Repo's hooks and config, and the files that say where
 * this worktree and its Repo are. The daemon's own `git` reads them outside the sandbox.
 */
function worktreeControl({ common, admin }: WorktreeGitDirs): string[] {
  return [
    ...['hooks', 'config', 'config.worktree', 'commondir', 'gitdir'].map((name) => path.join(common, name)),
    ...['config.worktree', 'commondir', 'gitdir'].map((name) => path.join(admin, name)),
  ];
}

/**
 * Git control files the daemon's own `git` later reads outside the sandbox (Pull request opening, PR action Sessions, the
 * Network allowlist). A run's commands may not write them, whatever the SDK's own profile adds.
 */
export function gitControl(workingDir: string, gitFile: boolean): string[] {
  const git = path.join(workingDir, '.git');
  return gitFile
    ? [git]
    : ['hooks', 'config', 'config.worktree', 'commondir', 'gitdir'].map((name) => path.join(git, name));
}

/**
 * The Run sandbox for one agent run (ADR 0006): macOS Seatbelt through the SDK. It guards the Keychain and what reaches
 * it, and nothing else: commands write anywhere, reach any host, bind and reach `localhost`, and use any Unix socket,
 * as in the operator's own terminal. Closed: the login Keychain folder, the installed app and its bundled `node`
 * (macOS may trust it with Keychain items), and the git control files the daemon's own `git` reads outside the sandbox
 * (a `credential.helper` written there would run with the Keychain). A read-only run may not change its working folder.
 * The run fails when the sandbox is unavailable and can never ask to leave it.
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
    enableWeakerNetworkIsolation: true,
    network: { allowedDomains: ['*'], allowAllUnixSockets: true, allowLocalBinding: true },
    filesystem: {
      allowWrite: ['/'],
      denyWrite: [
        ...(run.readOnly ? [run.workingDir, ...(run.gitDirs ? [run.gitDirs.common] : [])] : []),
        ...gitControl(run.workingDir, run.gitFile === true),
        ...(run.gitDirs ? worktreeControl(run.gitDirs) : []),
        ...(run.repos ?? []).flatMap((repo) => gitControl(repo.path, repo.gitFile)),
      ],
      denyRead: [path.join(home, '.ops-console'), path.join(home, 'Library', 'Keychains')],
    },
  };
}
