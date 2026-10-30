import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { GitHost } from '@ops-console/shared';

const run = promisify(execFile);

export const GIT = Symbol('GIT');

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

  private async try(dir: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await run(this.bin, ['-C', dir, ...args], { maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch {
      return null;
    }
  }
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
