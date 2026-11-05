import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Git, GitFailed } from '../src/repos/git';
import { tempDir } from './helpers';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'pipe',
  });

async function makeRepo(): Promise<string> {
  const dir = path.join(await tempDir('ops-console-git-safety-'), 'repo');
  await mkdir(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

/** A hook and an fsmonitor program a run could have planted, each leaving a marker file when git starts it. */
async function plant(repo: string): Promise<{ hook: string; monitor: string }> {
  const hook = path.join(path.dirname(repo), 'hook-ran');
  const monitor = path.join(path.dirname(repo), 'monitor-ran');
  const post = path.join(repo, '.git', 'hooks', 'post-commit');
  await writeFile(post, `#!/bin/sh\ntouch '${hook}'\n`);
  await chmod(post, 0o755);
  const program = path.join(path.dirname(repo), 'monitor.sh');
  await writeFile(program, `#!/bin/sh\ntouch '${monitor}'\nexit 1\n`);
  await chmod(program, 0o755);
  sh(repo, 'config', 'core.fsmonitor', program);
  return { hook, monitor };
}

describe('the daemon’s git, outside the Run sandbox (ADR 0006)', () => {
  it('runs no hook and no fsmonitor program from the repository’s own config', async () => {
    const repo = await makeRepo();
    const { hook, monitor } = await plant(repo);
    const git = new Git();
    await writeFile(path.join(repo, 'b.txt'), 'two\n');

    expect(await git.isDirty(repo)).toBe(true);
    expect(await git.commitAll(repo, 'second')).toMatch(/^[0-9a-f]{40}$/);

    expect(existsSync(hook)).toBe(false);
    expect(existsSync(monitor)).toBe(false);

    // The same repository does run them for plain git, so the checks above prove something.
    await writeFile(path.join(repo, 'c.txt'), 'three\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'third');
    expect(existsSync(hook)).toBe(true);
    expect(existsSync(monitor)).toBe(true);
  });

  it('puts `--` before a clone URL, so a URL that starts with a dash is no option', async () => {
    const dir = path.join(await tempDir('ops-console-git-safety-'), 'clone');
    await expect(new Git().clone('--upload-pack=touch /tmp/never', dir)).rejects.toThrow(GitFailed);
    expect(existsSync('/tmp/never')).toBe(false);
  });
});

describe('a scratch copy the daemon’s git runs in', () => {
  async function scratch() {
    const repo = await makeRepo();
    const git = new Git();
    const dir = path.join(path.dirname(repo), 'scratch');
    await git.addWorktree(repo, dir, 'HEAD');
    return { repo, dir, git };
  }

  it('is accepted while its .git is the worktree the console made', async () => {
    const { repo, dir, git } = await scratch();
    await expect(git.requireWorktree(dir, repo)).resolves.toBeUndefined();
  });

  it('is refused when a run points its .git at a repository of its own', async () => {
    const { repo, dir, git } = await scratch();
    const other = path.join(path.dirname(repo), 'other');
    await mkdir(other);
    sh(other, 'init', '-q');
    await writeFile(path.join(dir, '.git'), `gitdir: ${path.join(other, '.git')}\n`);
    await expect(git.requireWorktree(dir, repo)).rejects.toThrow('changed outside the console');
  });

  it('is refused when .git is no longer a file, or names nothing', async () => {
    const { repo, dir, git } = await scratch();
    await writeFile(path.join(dir, '.git'), 'not a gitfile\n');
    await expect(git.requireWorktree(dir, repo)).rejects.toThrow(GitFailed);
    await rm(path.join(dir, '.git'));
    await mkdir(path.join(dir, '.git'));
    await expect(git.requireWorktree(dir, repo)).rejects.toThrow(GitFailed);
  });
});
