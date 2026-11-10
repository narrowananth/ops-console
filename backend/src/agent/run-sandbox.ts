import { readFileSync } from 'node:fs';
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
  /** Folders outside the working folder the run may write and read: the Session's output folder. */
  writable?: string[];
  /** Other Repos' checkouts the operator opened to this Session: the run writes and reads them like its working folder. */
  repos?: { path: string; gitFile: boolean }[];
  /** The run's Network allowlist (ADR 0006): the only hosts its commands reach. */
  networkDomains: string[];
  /** The run may not change its working folder: a review of pull request text, or an answer in a thread. */
  readOnly?: boolean;
  /** The working folder's `.git` is a file, as in a worktree: the run may not rewrite it. */
  gitFile?: boolean;
  /** The working folder is a Session's own worktree: the Repo's git folder and this worktree's folder in it, where its commits go. */
  gitDirs?: WorktreeGitDirs | null;
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

export const TEMP = ['/tmp', '/private/tmp'];

/**
 * Where build tools and commit hooks keep their downloads, under the operator's home: npm, pnpm, Yarn, Cargo's crate
 * cache, Go modules, Maven, Gradle, pre-commit, pip and the macOS cache folder. Never a folder on PATH, such as
 * `~/.cargo/bin` or `~/go/bin`, so a run cannot leave a program there for a later command.
 */
export const TOOL_CACHES = [
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.cache',
  '.cargo/registry',
  '.cargo/git',
  '.cargo/.package-cache',
  'go/pkg',
  '.m2/repository',
  '.gradle',
  '.nuget/packages',
  'Library/Caches',
  'Library/pnpm',
];

/**
 * Git control files the daemon's own `git` later reads outside the sandbox (Pull request opening, Comment passes, the
 * Network allowlist). A run's commands may not write them, whatever the SDK's own profile adds.
 */
export function gitControl(workingDir: string, gitFile: boolean): string[] {
  const git = path.join(workingDir, '.git');
  return gitFile
    ? [git]
    : ['hooks', 'config', 'config.worktree', 'commondir', 'gitdir'].map((name) => path.join(git, name));
}

/**
 * The Run sandbox for one agent run (ADR 0006): macOS Seatbelt through the SDK. Commands write only in the working
 * folder, the temp folders and the tool caches, and read neither the data folder, which holds the session token, nor the operator's
 * cloud and Keychain credentials. The working folder stays readable though it sits inside the data folder. The run
 * fails when the sandbox is unavailable and can never ask to leave it. Commands reach only the Network allowlist.
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
    // That service only checks certificates; hosts off the allowlist stay refused.
    enableWeakerNetworkIsolation: true,
    network: { allowedDomains: run.networkDomains, strictAllowlist: true },
    filesystem: {
      allowWrite: [
        ...(run.readOnly ? [] : [run.workingDir]),
        ...TEMP,
        ...(run.readOnly || !run.gitDirs ? [] : [run.gitDirs.common]),
        ...(run.writable ?? []),
        ...(run.readOnly ? [] : (run.repos ?? []).map((repo) => repo.path)),
        ...TOOL_CACHES.map((folder) => path.join(home, folder)),
      ],
      denyWrite: [
        ...gitControl(run.workingDir, run.gitFile === true),
        ...(run.gitDirs ? worktreeControl(run.gitDirs) : []),
        ...(run.repos ?? []).flatMap((repo) => gitControl(repo.path, repo.gitFile)),
      ],
      denyRead: [
        run.dataDir,
        // The installed app and its bundled `node`: macOS may trust that binary's Keychain items without a prompt.
        path.join(home, '.ops-console'),
        path.join(home, '.aws'),
        path.join(home, '.config', 'gcloud'),
        path.join(home, 'Library', 'Keychains'),
        path.join(home, '.ssh'),
      ],
      allowRead: [
        run.workingDir,
        ...(run.writable ?? []),
        ...(run.readable ?? []),
        ...(run.repos ?? []).map((repo) => repo.path),
      ],
    },
  };
}
