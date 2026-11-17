import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { GitHost, type SessionDiff, type SessionDiffFile, SessionDiffStatus } from '@ops-console/shared';
import { gitPool } from '../common/spawn-pool';

const exec = promisify(execFile);

/** Runs `git` through the shared pool, so a burst of reads cannot start dozens of processes. */
const run = (
  bin: string,
  args: string[],
  options: { maxBuffer?: number; env?: NodeJS.ProcessEnv; timeout?: number } = {},
) => gitPool.run(() => exec(bin, args, { ...options, encoding: 'utf8' }));

/**
 * Repository settings that make `git` run a program: a hook or `core.fsmonitor`. The daemon runs `git` outside the Run
 * sandbox in folders an agent run wrote in (ADR 0006), so it turns both off on every call; `-c` outranks the
 * repository's own config.
 */
const NO_PROGRAMS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/** Lines a file's diff keeps; a lockfile's thousands are cut, with the file marked truncated. */
const DIFF_LINES = 3000;
/** Untracked files read into a diff; past this, a build folder git does not ignore would flood it. */
const UNTRACKED_FILES = 200;
/** An untracked file bigger than this shows as a file without its lines. */
const UNTRACKED_BYTES = 512 * 1024;
/** A fetch that takes longer is given up: a hung `ssh` must not stall a run, which reads the last fetched commit. */
const FETCH_TIMEOUT_MS = 8000;
/** A fetch of the same ref this recent stands for a new one, for callers that do not need the very newest commit. */
const FETCH_REUSE_MS = 30_000;

export const GIT = Symbol('GIT');

export class GitFailed extends Error {}

/** The remote branch has commits the push does not. */
export class BranchMoved extends GitFailed {
  constructor(branch: string) {
    super(`${branch} moved on the remote`);
  }
}

/** The branch moved on the remote and rebasing onto it conflicts. The rebase was aborted and the branch is as it was. */
export class RebaseConflict extends BranchMoved {}

/**
 * Where a job reads the code: a branch at a commit. `fetched` is false when origin could not be reached and the
 * Repo's local branch stands in; `error` is then why, and the code may be behind origin.
 */
export type CodeBase = { branch: string; ref: string; sha: string; fetched: boolean; error: string | null };

/** The step a job shows for where its code comes from. */
export function codeBaseStep(base: CodeBase): string {
  const at = `${base.ref} at ${base.sha.slice(0, 7)}`;
  return base.fetched
    ? `Code: ${at}, fetched from origin`
    : `Code: ${at}, local; could not fetch from origin (${base.error ?? 'no reason given'}), so it may be behind`;
}

/** Reads from a local git repository. Tests use real repositories in temporary folders. */
export class Git {
  /** Fetches by repository and ref: callers that ask at once share one process. */
  private readonly fetches = new Map<string, { at: number; running: boolean; done: Promise<void> }>();

  constructor(private readonly bin = 'git') {}

  /** The top folder of the repository holding `dir`, or `null` when it is not inside one or does not exist. */
  async topFolder(dir: string): Promise<string | null> {
    const out = await this.try(dir, ['rev-parse', '--show-toplevel']);
    return out === null ? null : realpath(out.trim());
  }

  /** The current branch; a detached HEAD reads as the short commit. */
  async currentBranch(dir: string): Promise<string | null> {
    const branch = await this.try(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (branch?.trim()) return branch.trim();
    const sha = await this.try(dir, ['rev-parse', '--short', 'HEAD']);
    return sha?.trim() || null;
  }

  /** The branch checked out; null on a detached HEAD or outside a repository. */
  async branchName(dir: string): Promise<string | null> {
    return (await this.try(dir, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || null;
  }

  /**
   * Everything the worktree `dir` changes against where it forked from the default branch, on origin when origin has
   * it: its commits, and its staged, unstaged and untracked files. `branch` names the changes while `dir` is on a
   * detached HEAD. `fallback` is the default branch when origin names none.
   */
  async changes(dir: string, fallback: string, branch: string | null): Promise<SessionDiff> {
    const [named, head, untracked, current] = await Promise.all([
      this.try(dir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']),
      this.commitOf(dir, 'HEAD'),
      this.try(dir, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z']),
      this.branchName(dir),
    ]);
    const main = named?.trim() ? named.trim().replace(/^origin\//, '') : fallback;
    const [remote, local] = await Promise.all([
      this.commitOf(dir, `refs/remotes/origin/${main}`),
      this.commitOf(dir, `refs/heads/${main}`),
    ]);
    const base = remote ? `origin/${main}` : local ? main : null;
    const fork = base && head ? ((await this.try(dir, ['merge-base', base, head]))?.trim() ?? head) : head;
    const [diff, others] = await Promise.all([
      fork
        ? this.try(dir, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', fork])
        : Promise.resolve(null),
      Promise.all(
        (untracked ?? '')
          .split('\0')
          .filter(Boolean)
          .slice(0, UNTRACKED_FILES)
          .map((name) => untrackedFile(path.join(dir, name), name)),
      ),
    ]);
    const files: SessionDiffFile[] = [...(fork ? parseDiff(diff ?? '') : []), ...others];
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      branch: current ?? branch,
      base: fork ? (base ?? branch) : null,
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  }

  /** `origin/HEAD` when set, else the current branch. */
  async defaultBranch(dir: string): Promise<string | null> {
    const head = await this.try(dir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
    if (head?.trim()) return head.trim().replace(/^origin\//, '');
    return this.currentBranch(dir);
  }

  async originUrl(dir: string): Promise<string | null> {
    const url = await this.try(dir, ['remote', 'get-url', 'origin']);
    return url?.trim() || null;
  }

  /** Whether `dir` has uncommitted changes. Throws when git cannot read the status: a failed read is not a clean tree. */
  async isDirty(dir: string): Promise<boolean> {
    return (await this.status(dir)).dirty;
  }

  /**
   * The checked-out branch (a detached HEAD reads as the short commit) and whether the work tree has changes, in one
   * `git status`. `--no-optional-locks` keeps a read from taking the index lock a run's own `git` may hold. Throws with
   * git's first line when git cannot read it.
   */
  async status(dir: string): Promise<{ branch: string | null; dirty: boolean }> {
    const out = await this.read(dir, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch']);
    let head: string | null = null;
    let oid: string | null = null;
    let dirty = false;
    for (const line of out.split('\n')) {
      if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length);
      else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length);
      else if (line !== '' && !line.startsWith('#')) dirty = true;
    }
    const branch = head === '(detached)' ? (oid && oid !== '(initial)' ? oid.slice(0, 7) : null) : head;
    return { branch, dirty };
  }

  /** Local branches by most recent commit. */
  async branches(dir: string): Promise<{ name: string; current: boolean }[]> {
    const out = await this.try(dir, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(HEAD)\t%(refname:short)',
      'refs/heads',
    ]);
    return (out ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [head = '', name = ''] = line.split('\t');
        return { name, current: head === '*' };
      });
  }

  /** Branches only origin has, by most recent commit, as last fetched. A branch the Repo also has locally is not listed. */
  async remoteOnlyBranches(dir: string): Promise<string[]> {
    const local = new Set((await this.branches(dir)).map((branch) => branch.name));
    const out = await this.try(dir, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)',
      'refs/remotes/origin',
    ]);
    return (out ?? '')
      .split('\n')
      .map((ref) => ref.replace(/^refs\/remotes\/origin\//, ''))
      .filter((name) => name !== '' && name !== 'HEAD' && !local.has(name));
  }

  /** Fetches every branch of origin and drops the ones it deleted. Never throws; a slow or missing remote is skipped. */
  async refreshRemote(dir: string): Promise<void> {
    try {
      await run(this.bin, [...NO_PROGRAMS, '-C', dir, 'fetch', '--quiet', '--prune', 'origin'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 8000,
      });
    } catch {
      // The branches as last fetched stand.
    }
  }

  /** Makes local branch `branch` at `ref`, which may be a remote ref. Throws with git's first line when git refuses. */
  async createBranch(dir: string, branch: string, ref: string): Promise<void> {
    await this.must(dir, ['branch', '--quiet', '--no-track', branch, ref]);
  }

  /** The files git knows in `dir`: tracked, plus untracked ones no ignore rule hides. Paths are relative to `dir`. */
  async files(dir: string): Promise<string[]> {
    const out = await this.try(dir, [
      '-c',
      'core.quotePath=false',
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    return [...new Set((out ?? '').split('\0').filter(Boolean))];
  }

  /** Clones `url` into `dir`, which must be empty or missing. Throws with git's first line when it refuses. */
  async clone(url: string, dir: string): Promise<void> {
    try {
      await run(this.bin, [...NO_PROGRAMS, 'clone', '--quiet', '--', url, dir], {
        maxBuffer: 10 * 1024 * 1024,
        // No prompt for a password: a clone the operator's git cannot do alone fails instead of hanging.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (error) {
      const { stderr } = error as { stderr?: unknown };
      throw new GitFailed(typeof stderr === 'string' ? (stderr.trim().split('\n').at(-1) ?? '') : '');
    }
  }

  /** Deletes a local branch, merged or not; its commits stay in the reflog. Throws when git refuses. */
  async deleteBranch(dir: string, branch: string): Promise<void> {
    await this.must(dir, ['branch', '-D', branch]);
  }

  /** Puts uncommitted changes, untracked files included, on the stash. Throws when git refuses. */
  async stash(dir: string, message: string): Promise<void> {
    await this.must(dir, ['stash', 'push', '--include-untracked', '-m', message]);
  }

  /**
   * Checks out an existing branch, or makes `branch` first: from `from` when given, else from the current one. `shared`
   * takes a branch another worktree has checked out. Throws when git refuses.
   */
  async checkout(dir: string, branch: string, create: boolean, from?: string, shared = false): Promise<void> {
    await this.must(
      dir,
      create
        ? ['checkout', '-b', branch, ...(from ? [from] : [])]
        : ['checkout', ...(shared ? ['--ignore-other-worktrees'] : []), branch],
    );
  }

  /**
   * The first of `names` origin has, fetched now. When none can be fetched, the first one the Repo has locally, with
   * the fetch's error. Throws when no name is on origin or in the Repo.
   */
  async codeBase(dir: string, names: string[], reuse = false): Promise<CodeBase> {
    let error: string | null = null;
    for (const branch of names) {
      try {
        await this.fetchOnce(dir, branchKey(branch), [branchSpec(branch)], reuse);
        const sha = await this.commitOf(dir, `refs/remotes/origin/${branch}`);
        if (sha) return { branch, ref: `origin/${branch}`, sha, fetched: true, error: null };
      } catch (failed) {
        error ??= failed instanceof GitFailed && failed.message ? failed.message : 'git fetch failed';
      }
    }
    for (const branch of names) {
      const sha = await this.commitOf(dir, `refs/heads/${branch}`);
      if (sha) return { branch, ref: branch, sha, fetched: false, error };
    }
    throw new GitFailed(`none of ${names.join(', ')} is on origin or in the Repo${error ? ` (${error})` : ''}`);
  }

  /** Like `codeBase`, without asking origin: the first of `names` as last fetched, else the Repo's own branch. */
  async codeBaseKept(dir: string, names: string[]): Promise<CodeBase> {
    for (const branch of names) {
      const sha = await this.commitOf(dir, `refs/remotes/origin/${branch}`);
      if (sha) return { branch, ref: `origin/${branch}`, sha, fetched: false, error: null };
    }
    for (const branch of names) {
      const sha = await this.commitOf(dir, `refs/heads/${branch}`);
      if (sha) return { branch, ref: branch, sha, fetched: false, error: null };
    }
    throw new GitFailed(`none of ${names.join(', ')} is on origin or in the Repo`);
  }

  private async commitOf(dir: string, ref: string): Promise<string | null> {
    return (await this.try(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]))?.trim() || null;
  }

  /** A detached worktree of `repo` at `ref`, in `dir`. Throws with git's first line when it refuses. */
  async addWorktree(repo: string, dir: string, ref: string): Promise<void> {
    await this.must(repo, ['worktree', 'add', '--detach', '--quiet', dir, ref]);
  }

  /**
   * A worktree of `repo` in `dir` for a Session: `branch` checked out, or, with `branch` null, a detached HEAD at `ref`.
   * `shared` lets it take a branch another worktree has checked out. Throws with git's first line when git refuses.
   */
  async addSessionWorktree(
    repo: string,
    dir: string,
    branch: string | null,
    ref: string,
    shared = false,
  ): Promise<void> {
    await this.must(repo, [
      'worktree',
      'add',
      '--quiet',
      ...(shared ? ['--force'] : []),
      ...(branch === null ? ['--detach', dir, ref] : [dir, branch]),
    ]);
  }

  /** The folder of the worktree that has `branch` checked out, the repository's own folder included; null when none has. */
  async worktreeOf(repo: string, branch: string): Promise<string | null> {
    const list = (await this.try(repo, ['worktree', 'list', '--porcelain'])) ?? '';
    for (const block of list.split('\n\n')) {
      const folder = /^worktree (.+)$/m.exec(block)?.[1];
      if (
        folder &&
        new RegExp(`^branch refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(block)
      ) {
        return realpath(folder).catch(() => folder);
      }
    }
    return null;
  }

  /** Moves `dir` to `ref` with a detached HEAD, leaving every branch as it is. Throws with git's first line. */
  async checkoutDetached(dir: string, ref: string): Promise<void> {
    await this.must(dir, ['checkout', '--quiet', '--detach', ref]);
  }

  /** Fetches `branch` from `origin`, and moves a clean `dir` forward to it when that is a fast-forward. Never throws. */
  async pull(dir: string, branch: string, reuse = false): Promise<void> {
    try {
      await this.remoteHead(dir, branch, reuse);
    } catch {
      return;
    }
    const checkedOut = await this.branchName(dir);
    if (checkedOut === null || checkedOut === branch) {
      await this.try(dir, ['merge', '--ff-only', '--quiet', `refs/remotes/origin/${branch}`]);
    }
  }

  /**
   * Checks a scratch copy is still the worktree `addWorktree` made: its `.git` is a file that names a folder under
   * `repo`'s own `worktrees`. A run that rewrote it would point the daemon's `git` at a repository of its own. Throws
   * `GitFailed` when it differs.
   */
  async requireWorktree(dir: string, repo: string): Promise<void> {
    const changed = new GitFailed('the scratch copy was changed outside the console');
    const gitFile = path.join(dir, '.git');
    try {
      if (!(await lstat(gitFile)).isFile()) throw changed;
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(gitFile, 'utf8'))?.[1];
      const common = (await this.try(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
      if (!named || !common) throw changed;
      const admin = await realpath(path.resolve(dir, named));
      const worktrees = path.join(await realpath(common), 'worktrees') + path.sep;
      if (!admin.startsWith(worktrees)) throw changed;
    } catch (error) {
      throw error instanceof GitFailed ? error : changed;
    }
  }

  /** Removes a worktree folder and the record its repository keeps of it. */
  async removeWorktree(dir: string): Promise<void> {
    const common = (await this.try(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
    await rm(dir, { recursive: true, force: true });
    if (common) await this.try(common, ['worktree', 'prune']);
  }

  /** Fetches `branch` from `origin` and makes it a local branch tracking it. Throws with git's first line. */
  async trackBranch(dir: string, branch: string, reuse = false): Promise<void> {
    await this.fetchOnce(dir, branchKey(branch), [branchSpec(branch)], reuse);
    await this.must(dir, ['branch', '--quiet', '--track', branch, `origin/${branch}`]);
  }

  /** Fetches `branch` from `origin` into `origin/<branch>` and gives the commit it is at. Throws with git's first line. */
  async remoteHead(dir: string, branch: string, reuse = false): Promise<string> {
    await this.fetchOnce(dir, branchKey(branch), [branchSpec(branch)], reuse);
    const sha = (await this.try(dir, ['rev-parse', `refs/remotes/origin/${branch}`]))?.trim();
    if (!sha) throw new GitFailed(`no origin/${branch}`);
    return sha;
  }

  /**
   * Fetches every branch of `branches` from `origin` into `origin/<branch>` in one `git fetch`, and gives each one's
   * commit. Throws with git's first line when any is missing on origin.
   */
  async remoteHeads(dir: string, branches: string[], reuse = false): Promise<Map<string, string>> {
    const unique = [...new Set(branches)];
    await this.fetchOnce(dir, `branches:${[...unique].sort().join('\0')}`, unique.map(branchSpec), reuse);
    const heads = new Map<string, string>();
    for (const branch of unique) {
      const sha = (await this.try(dir, ['rev-parse', `refs/remotes/origin/${branch}`]))?.trim();
      if (!sha) throw new GitFailed(`no origin/${branch}`);
      heads.set(branch, sha);
    }
    return heads;
  }

  /** Fetches `ref` from `origin` into no branch, so its commits are in the repository. Throws with git's first line. */
  async fetchRef(dir: string, ref: string, reuse = false): Promise<void> {
    await this.fetchOnce(dir, `ref:${ref}`, [ref], reuse);
  }

  /** Whether `sha` is a commit the repository has. */
  async hasCommit(dir: string, sha: string): Promise<boolean> {
    return (await this.commitOf(dir, sha)) !== null;
  }

  /**
   * The files that conflict when `head` merges into `base`, empty for a clean merge, worked out by `git merge-tree`
   * without touching a branch or the work tree. Null when git cannot tell: an old git, or a commit it does not have.
   */
  async mergeConflicts(dir: string, base: string, head: string): Promise<string[] | null> {
    try {
      await run(
        this.bin,
        [...NO_PROGRAMS, '-C', dir, 'merge-tree', '--write-tree', '--name-only', '--no-messages', base, head],
        {
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return [];
    } catch (error) {
      // Exit 1 is a merge with conflicts: the tree on the first line, then one conflicted path per line.
      const { code, stdout } = error as { code?: unknown; stdout?: unknown };
      if (code !== 1 || typeof stdout !== 'string') return null;
      const [, ...paths] = stdout.split('\n');
      return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
    }
  }

  /** Fetches `branch` from `origin`, so its commits are in the repository. Throws with git's first line. */
  async fetchBranch(dir: string, branch: string, reuse = false): Promise<void> {
    await this.fetchOnce(dir, `head:${branch}`, [`refs/heads/${branch}`], reuse);
  }

  /**
   * Commits every change in `dir` with `message`; the new commit, or null when nothing changed. The Repo's git hooks
   * are skipped: a scratch copy has no installed packages for them, and the host's CI still checks the push.
   */
  async commitAll(dir: string, message: string): Promise<string | null> {
    await this.must(dir, ['add', '--all']);
    if ((await this.try(dir, ['diff', '--cached', '--quiet'])) !== null) return null;
    await this.must(dir, ['commit', '--quiet', '--no-verify', '-m', message]);
    return (await this.try(dir, ['rev-parse', 'HEAD']))?.trim() ?? null;
  }

  /** How many commits `branch` has that `origin/<base>` (the local `base` without it) lacks; 0 when either is missing. */
  async commitsAhead(dir: string, base: string, branch: string): Promise<number> {
    for (const from of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
      const count = await this.try(dir, ['rev-list', '--count', `${from}..refs/heads/${branch}`]);
      if (count !== null) return Number.parseInt(count, 10) || 0;
    }
    return 0;
  }

  /** The commits `branch` has that `origin/<base>` (the local `base` without it) lacks, oldest first; none when either is missing. */
  async commitsSince(dir: string, base: string, branch: string): Promise<{ subject: string; body: string }[]> {
    for (const from of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
      const out = await this.try(dir, [
        'log',
        '--reverse',
        '--max-count=50',
        '--format=%s%x1f%b%x1e',
        `${from}..refs/heads/${branch}`,
      ]);
      if (out === null) continue;
      return out
        .split('\x1e')
        .map((entry) => entry.replace(/^\n/, ''))
        .filter((entry) => entry.trim() !== '')
        .map((entry) => {
          const [subject = '', body = ''] = entry.split('\x1f');
          return { subject: subject.trim(), body: body.trim() };
        });
    }
    return [];
  }

  /** Files with changes not committed yet: staged, unstaged and untracked. */
  async uncommittedFiles(dir: string): Promise<number> {
    const out = await this.try(dir, ['--no-optional-locks', 'status', '--porcelain']);
    return (out ?? '').split('\n').filter((line) => line.trim() !== '').length;
  }

  /** The commit local branch `branch` is at; null when the Repo has no such branch. */
  async branchHead(dir: string, branch: string): Promise<string | null> {
    return this.commitOf(dir, `refs/heads/${branch}`);
  }

  /** The commit `dir` is at. */
  async head(dir: string): Promise<string | null> {
    return (await this.try(dir, ['rev-parse', 'HEAD']))?.trim() || null;
  }

  /**
   * Pushes the commit `dir` is at to `branch` on `origin`, never with force. A branch that moved on the remote throws
   * `BranchMoved`.
   */
  async pushHead(dir: string, branch: string, source = 'HEAD'): Promise<void> {
    try {
      await run(this.bin, [...NO_PROGRAMS, '-C', dir, 'push', '--quiet', 'origin', `${source}:refs/heads/${branch}`], {
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (error) {
      const { stderr } = error as { stderr?: unknown };
      const text = typeof stderr === 'string' ? stderr.trim() : '';
      if (/\[rejected\]|non-fast-forward|fetch first/.test(text)) throw new BranchMoved(branch);
      throw new GitFailed(text.split('\n')[0] ?? '');
    }
  }

  /**
   * `pushHead`, and when the branch moved on the remote, rebases the commits `dir` is at onto the new tip and pushes
   * again, never with force; up to `tries` times, since the branch can move again. A rebase that conflicts is undone
   * and throws `RebaseConflict`: only a person can settle that.
   */
  async pushHeadRebasing(dir: string, branch: string, tries = 3): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.pushHead(dir, branch);
        return;
      } catch (error) {
        if (!(error instanceof BranchMoved) || attempt >= tries) throw error;
        try {
          await this.remoteHead(dir, branch);
        } catch {
          throw new BranchMoved(branch);
        }
        try {
          await this.must(dir, ['rebase', '--quiet', `refs/remotes/origin/${branch}`]);
        } catch {
          await this.try(dir, ['rebase', '--abort']);
          throw new RebaseConflict(branch);
        }
      }
    }
  }

  /**
   * One `git fetch` of `specs` from `origin` per repository and `key`: callers that ask while it runs share it, and one
   * that asks within 30 seconds of a fetch that worked shares that too when `reuse` is set. Throws with git's first line.
   */
  private fetchOnce(dir: string, key: string, specs: string[], reuse: boolean): Promise<void> {
    const id = `${dir}\0${key}`;
    const kept = this.fetches.get(id);
    if (kept && (kept.running || (reuse && Date.now() - kept.at < FETCH_REUSE_MS))) return kept.done;
    const entry = { at: Date.now(), running: true, done: Promise.resolve() };
    entry.done = this.must(
      dir,
      ['fetch', '--quiet', 'origin', ...specs],
      { GIT_TERMINAL_PROMPT: '0' },
      FETCH_TIMEOUT_MS,
    ).then(
      () => {
        entry.running = false;
        entry.at = Date.now();
      },
      (error) => {
        if (this.fetches.get(id) === entry) this.fetches.delete(id);
        throw error;
      },
    );
    this.fetches.set(id, entry);
    return entry.done;
  }

  /** The first line of git's own message; it names the problem and holds no secrets. */
  private async must(dir: string, args: string[], env: Record<string, string> = {}, timeout?: number): Promise<void> {
    try {
      await run(this.bin, [...NO_PROGRAMS, '-C', dir, ...args], {
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...env },
        timeout,
      });
    } catch (error) {
      const { stderr, killed } = error as { stderr?: unknown; killed?: unknown };
      if (killed === true) throw new GitFailed(`git ${args[0]} timed out`);
      throw new GitFailed(typeof stderr === 'string' ? (stderr.trim().split('\n')[0] ?? '') : '');
    }
  }

  /** Output of a read that must work. Throws with git's first line. */
  private async read(dir: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await run(this.bin, [...NO_PROGRAMS, '-C', dir, ...args], { maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const { stderr } = error as { stderr?: unknown };
      throw new GitFailed(typeof stderr === 'string' ? (stderr.trim().split('\n')[0] ?? '') : '');
    }
  }

  private async try(dir: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await run(this.bin, [...NO_PROGRAMS, '-C', dir, ...args], { maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch {
      return null;
    }
  }
}

const branchKey = (branch: string) => `branch:${branch}`;
const branchSpec = (branch: string) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`;

/** A URL git can clone: `github.com/acme/orders` gains `https://` and `.git`; a full or SSH URL is kept. */
export function cloneUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (/^(?:[a-z+]+:\/\/|[^@/\s]+@)/i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/\.git$/, '')}.git`;
}

const REMOTE_URL = /^(?:[a-z+]+:\/\/(?:[^@/]+@)?|[^@/\s]+@)([^/:]+)[/:](?:\d+\/)?(.+?)(?:\.git)?\/?$/i;

/** The lowercase hostname and `owner/name` an `origin` URL names, in `https://host/path` or `git@host:path` form. */
function splitRemote(url: string | null): { hostname: string | null; slug: string | null } {
  const match = url === null ? null : REMOTE_URL.exec(url.trim());
  return { hostname: match?.[1]?.toLowerCase() ?? null, slug: match?.[2] ?? null };
}

/** The lowercase hostname an `origin` URL points at; null for a local path or no URL. */
export function remoteHostname(url: string | null): string | null {
  return splitRemote(url).hostname;
}

/** Bitbucket Cloud's website host and its two SSH hosts: `git@ssh.bitbucket.org:owner/name.git` is a Bitbucket remote. */
const BITBUCKET_HOSTNAMES = ['bitbucket.org', 'ssh.bitbucket.org', 'altssh.bitbucket.org'];

/** The host and `owner/name` an `origin` URL points at; any other host is `local`. */
export function parseRemote(url: string | null): { host: GitHost; slug: string | null } {
  if (url === null) return { host: GitHost.Local, slug: null };
  const { hostname, slug } = splitRemote(url);
  const host =
    hostname === 'github.com'
      ? GitHost.Github
      : hostname === 'gitlab.com'
        ? GitHost.Gitlab
        : hostname !== null && BITBUCKET_HOSTNAMES.includes(hostname)
          ? GitHost.Bitbucket
          : null;
  return host === null ? { host: GitHost.Local, slug: null } : { host, slug };
}

/** A `git diff` split per file: its status, counts and lines, hunk headers kept for line numbers. */
export function parseDiff(diff: string): SessionDiffFile[] {
  const files: SessionDiffFile[] = [];
  let file: SessionDiffFile | null = null;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      file = {
        name: header[2] ?? '',
        old_name: null,
        status: SessionDiffStatus.Modified,
        additions: 0,
        deletions: 0,
        binary: false,
        lines: [],
        truncated: false,
      };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (file === null) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) file.status = SessionDiffStatus.Added;
      else if (line.startsWith('deleted file mode')) file.status = SessionDiffStatus.Deleted;
      else if (line.startsWith('rename from ')) {
        file.status = SessionDiffStatus.Renamed;
        file.old_name = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) file.name = line.slice('rename to '.length);
      else if (line.startsWith('+++ b/')) file.name = line.slice('+++ b/'.length);
      else if (line.startsWith('Binary files ')) file.binary = true;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      push(file, { sign: ' ', text: line });
      continue;
    }
    if (!inHunk || line === '' || line.startsWith('\\')) continue;
    const sign = line[0] === '+' ? '+' : line[0] === '-' ? '-' : ' ';
    if (sign === '+') file.additions++;
    if (sign === '-') file.deletions++;
    push(file, { sign, text: line.slice(1) });
  }
  return files;
}

function push(file: SessionDiffFile, line: SessionDiffFile['lines'][number]): void {
  if (file.lines.length < DIFF_LINES) file.lines.push(line);
  else file.truncated = true;
}

/** A file git does not track yet, as an added file: every line `+`, none for a big or binary one. */
async function untrackedFile(full: string, name: string): Promise<SessionDiffFile> {
  const file: SessionDiffFile = {
    name,
    old_name: null,
    status: SessionDiffStatus.Added,
    additions: 0,
    deletions: 0,
    binary: false,
    lines: [],
    truncated: false,
  };
  const size = await stat(full).then(
    (info) => (info.isFile() ? info.size : null),
    () => null,
  );
  if (size === null) return file;
  if (size > UNTRACKED_BYTES) {
    file.truncated = true;
    return file;
  }
  const bytes = await readFile(full).catch(() => null);
  if (bytes === null) return file;
  if (bytes.includes(0)) {
    file.binary = true;
    return file;
  }
  const text = bytes.toString('utf8');
  if (text === '') return file;
  const lines = text.replace(/\n$/, '').split('\n');
  file.additions = lines.length;
  push(file, { sign: ' ', text: `@@ -0,0 +1,${lines.length} @@` });
  for (const line of lines) push(file, { sign: '+', text: line });
  return file;
}
