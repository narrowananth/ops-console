import { execFile } from 'node:child_process';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { GitHost, type SessionDiff, type SessionDiffFile, SessionDiffStatus } from '@ops-console/shared';

const run = promisify(execFile);

/** Lines a file's diff keeps; a lockfile's thousands are cut, with the file marked truncated. */
const DIFF_LINES = 3000;
/** Untracked files read into a diff; past this, a build folder git does not ignore would flood it. */
const UNTRACKED_FILES = 200;
/** An untracked file bigger than this shows as a file without its lines. */
const UNTRACKED_BYTES = 512 * 1024;

export const GIT = Symbol('GIT');

export class GitFailed extends Error {}

/** The remote branch has commits the push does not. */
export class BranchMoved extends GitFailed {
  constructor(branch: string) {
    super(`${branch} moved on the remote`);
  }
}

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

  /**
   * The branches `HEAD` moved to by a checkout since `since`, newest first, read from the reflog. A detached checkout
   * and a branch deleted since are left out.
   */
  async checkoutsSince(dir: string, since: Date): Promise<string[]> {
    const log = await this.try(dir, ['log', '-g', '--date=unix', '--format=%gd%x09%gs', 'HEAD']);
    const after = Math.floor(since.getTime() / 1000);
    const moves: string[] = [];
    for (const line of (log ?? '').split('\n')) {
      const entry = /^HEAD@\{(\d+)\}\tcheckout: moving from \S+ to (\S+)$/.exec(line);
      if (!entry) continue;
      if (Number(entry[1]) < after) break;
      const branch = entry[2] as string;
      if (!moves.includes(branch) && (await this.commitOf(dir, `refs/heads/${branch}`))) moves.push(branch);
    }
    return moves;
  }

  /** The branch checked out; null on a detached HEAD or outside a repository. */
  async branchName(dir: string): Promise<string | null> {
    return (await this.try(dir, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || null;
  }

  /**
   * Everything `branch` changes against where it forked from the default branch, on origin when origin has it: its
   * commits, and while it is the branch checked out, the staged, unstaged and untracked files too. On the default
   * branch itself, the commits not pushed yet. `fallback` is the default branch when origin names none.
   */
  async changes(dir: string, fallback: string, branch: string): Promise<SessionDiff> {
    const named = (await this.try(dir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']))?.trim();
    const main = named ? named.replace(/^origin\//, '') : fallback;
    const base = (await this.commitOf(dir, `refs/remotes/origin/${main}`))
      ? `origin/${main}`
      : (await this.commitOf(dir, `refs/heads/${main}`))
        ? main
        : null;
    // Repo Sessions share the folder: the working tree is this branch's only while it is the one checked out.
    const checkedOut = (await this.branchName(dir)) === branch;
    const head = await this.commitOf(dir, `refs/heads/${branch}`);
    const fork = base && head ? ((await this.try(dir, ['merge-base', base, head]))?.trim() ?? head) : head;
    const files: SessionDiffFile[] = fork
      ? parseDiff(
          (await this.try(dir, [
            '-c',
            'core.quotePath=false',
            'diff',
            '--no-color',
            '--no-ext-diff',
            '-M',
            fork,
            ...(checkedOut || !head ? [] : [head]),
          ])) ?? '',
        )
      : [];
    const untracked = checkedOut
      ? ((await this.try(dir, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z'])) ??
        '')
      : '';
    for (const name of untracked.split('\0').filter(Boolean).slice(0, UNTRACKED_FILES)) {
      files.push(await untrackedFile(path.join(dir, name), name));
    }
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      branch,
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

  async isDirty(dir: string): Promise<boolean> {
    const out = await this.try(dir, ['status', '--porcelain']);
    return (out ?? '').trim() !== '';
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

  /** Clones `url` into `dir`, which must be empty or missing. Throws with git's first line when it refuses. */
  async clone(url: string, dir: string): Promise<void> {
    try {
      await run(this.bin, ['clone', '--quiet', url, dir], {
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
   * Checks out an existing branch, or makes `branch` first: from `from` when given, else from the current one. Throws
   * when git refuses.
   */
  async checkout(dir: string, branch: string, create: boolean, from?: string): Promise<void> {
    await this.must(dir, create ? ['checkout', '-b', branch, ...(from ? [from] : [])] : ['checkout', branch]);
  }

  /**
   * The first of `names` origin has, fetched now. When none can be fetched, the first one the Repo has locally, with
   * the fetch's error. Throws when no name is on origin or in the Repo.
   */
  async codeBase(dir: string, names: string[]): Promise<CodeBase> {
    let error: string | null = null;
    for (const branch of names) {
      try {
        await this.must(dir, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
          GIT_TERMINAL_PROMPT: '0',
        });
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

  private async commitOf(dir: string, ref: string): Promise<string | null> {
    return (await this.try(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]))?.trim() || null;
  }

  /** A detached worktree of `repo` at `ref`, in `dir`. Throws with git's first line when it refuses. */
  async addWorktree(repo: string, dir: string, ref: string): Promise<void> {
    await this.must(repo, ['worktree', 'add', '--detach', '--quiet', dir, ref]);
  }

  /** Removes a worktree folder and the record its repository keeps of it. */
  async removeWorktree(dir: string): Promise<void> {
    const common = (await this.try(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
    await rm(dir, { recursive: true, force: true });
    if (common) await this.try(common, ['worktree', 'prune']);
  }

  /** Fetches `branch` from `origin` and makes it a local branch tracking it. Throws with git's first line. */
  async trackBranch(dir: string, branch: string): Promise<void> {
    await this.must(dir, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
      GIT_TERMINAL_PROMPT: '0',
    });
    await this.must(dir, ['branch', '--quiet', '--track', branch, `origin/${branch}`]);
  }

  /** Fetches `branch` from `origin` into `origin/<branch>` and gives the commit it is at. Throws with git's first line. */
  async remoteHead(dir: string, branch: string): Promise<string> {
    await this.must(dir, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
      GIT_TERMINAL_PROMPT: '0',
    });
    const sha = (await this.try(dir, ['rev-parse', `refs/remotes/origin/${branch}`]))?.trim();
    if (!sha) throw new GitFailed(`no origin/${branch}`);
    return sha;
  }

  /** Fetches `branch` from `origin`, so its commits are in the repository. Throws with git's first line. */
  async fetchBranch(dir: string, branch: string): Promise<void> {
    await this.must(dir, ['fetch', '--quiet', 'origin', `refs/heads/${branch}`], { GIT_TERMINAL_PROMPT: '0' });
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

  /** The commit `dir` is at. */
  async head(dir: string): Promise<string | null> {
    return (await this.try(dir, ['rev-parse', 'HEAD']))?.trim() || null;
  }

  /**
   * Pushes the commit `dir` is at to `branch` on `origin`, never with force. A branch that moved on the remote throws
   * `BranchMoved`.
   */
  async pushHead(dir: string, branch: string): Promise<void> {
    try {
      await run(this.bin, ['-C', dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], {
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

  /** The first line of git's own message; it names the problem and holds no secrets. */
  private async must(dir: string, args: string[], env: Record<string, string> = {}): Promise<void> {
    try {
      await run(this.bin, ['-C', dir, ...args], { maxBuffer: 10 * 1024 * 1024, env: { ...process.env, ...env } });
    } catch (error) {
      const { stderr } = error as { stderr?: unknown };
      throw new GitFailed(typeof stderr === 'string' ? (stderr.trim().split('\n')[0] ?? '') : '');
    }
  }

  private async try(dir: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await run(this.bin, ['-C', dir, ...args], { maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch {
      return null;
    }
  }
}

/** A URL git can clone: `github.com/acme/orders` gains `https://` and `.git`; a full or SSH URL is kept. */
export function cloneUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (/^(?:[a-z+]+:\/\/|[^@/\s]+@)/i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/\.git$/, '')}.git`;
}

/** The host and `owner/name` an `origin` URL points at; any other host is `local`. */
export function parseRemote(url: string | null): { host: GitHost; slug: string | null } {
  if (url === null) return { host: GitHost.Local, slug: null };
  const match = /^(?:[a-z+]+:\/\/(?:[^@/]+@)?|[^@/\s]+@)([^/:]+)[/:](?:\d+\/)?(.+?)(?:\.git)?\/?$/i.exec(url.trim());
  const hostname = match?.[1]?.toLowerCase();
  const slug = match?.[2] ?? null;
  const host =
    hostname === 'github.com'
      ? GitHost.Github
      : hostname === 'gitlab.com'
        ? GitHost.Gitlab
        : hostname === 'bitbucket.org'
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
