import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyCli, cliEnv, outsideFile } from '../src/agent/integration-cli';
import { tempDir } from './helpers';

const kind = (cli: Parameters<typeof classifyCli>[0], ...args: string[]) => classifyCli(cli, args).kind;

describe('classifyCli', () => {
  it('reads run at once', () => {
    expect(kind('gh', 'pr', 'view', '12', '--repo', 'acme/orders')).toBe('read');
    expect(kind('glab', 'mr', 'list')).toBe('read');
    expect(kind('bkt', 'pr', 'comments', '42')).toBe('read');
    expect(kind('pup', 'logs', 'search', '--query', 'status:error')).toBe('read');
    expect(kind('pup', 'monitors', 'get', '123')).toBe('read');
    expect(kind('slashdocs', 'docs', 'list')).toBe('read');
    expect(kind('gh', 'api', 'repos/acme/orders/pulls/4')).toBe('read');
    expect(kind('gh', 'api', 'repos/acme/orders/pulls/4', '-X', 'GET')).toBe('read');
  });

  it('writes ask', () => {
    expect(kind('gh', 'pr', 'comment', '12', '--body', 'hi')).toBe('write');
    expect(kind('bkt', 'pr', 'create', '--title', 't')).toBe('write');
    expect(kind('pup', 'monitors', 'mute', '123')).toBe('write');
    expect(kind('pup', 'monitors', 'create', '--file', 'm.json')).toBe('write');
    expect(kind('slashdocs', 'docs', 'create', 'report.html')).toBe('write');
    // An unknown pup verb is a write until it is known to read.
    expect(kind('pup', 'dashboards', 'frobnicate')).toBe('write');
    for (const body of [['-f', 'a=b'], ['-X', 'POST'], ['--method=PATCH'], ['-XDELETE'], ['--input', 'x.json']]) {
      expect(kind('gh', 'api', 'repos/acme/orders/issues', ...body)).toBe('write');
    }
    expect(kind('bkt', 'api', '/rest/api/1.0/projects', '--method', 'POST')).toBe('write');
  });

  it('refuses sign-in, tokens, config, extensions, aliases and what no list names', () => {
    for (const [cli, args] of [
      ['gh', ['auth', 'token']],
      ['gh', ['auth', 'login']],
      ['gh', ['extension', 'install', 'x/y']],
      ['gh', ['alias', 'set', 'a', '!sh']],
      ['gh', ['config', 'set', 'editor', 'vim']],
      ['gh', ['secret', 'list']],
      ['gh', ['repo', 'delete', 'acme/orders']],
      ['bkt', ['auth', 'login']],
      ['bkt', ['extension', 'install']],
      ['pup', ['auth', 'login']],
      ['pup', ['mcp', 'serve']],
      ['pup', ['api-keys', 'list']],
      ['pup', ['alias', 'set', 'a', 'b']],
      ['slashdocs', ['auth', 'login']],
      ['slashdocs', ['update']],
      ['glab', ['auth', 'status']],
    ] as const) {
      expect(kind(cli, ...args), `${cli} ${args.join(' ')}`).toBe('deny');
    }
  });

  it('refuses a merge by command, by endpoint and by mutation', () => {
    for (const [cli, args] of [
      ['gh', ['pr', 'merge', '12']],
      ['glab', ['mr', 'merge', '3']],
      ['bkt', ['pr', 'merge', '42']],
      ['bkt', ['pr', 'auto-merge', '42']],
      ['gh', ['api', 'repos/acme/orders/pulls/4/merge', '-X', 'PUT']],
      ['gh', ['api', 'graphql', '-f', 'query=mutation { mergePullRequest(input: {}) { clientMutationId } }']],
      ['gh', ['pr', 'comment', '1', '--body', 'enablePullRequestAutoMerge']],
    ] as const) {
      expect(kind(cli, ...args), `${cli} ${args.join(' ')}`).toBe('deny');
    }
  });

  it('refuses a flag that passes a secret or another server, a leading flag, and a NUL', () => {
    expect(kind('gh', 'pr', 'view', '1', '--token', 'abc')).toBe('deny');
    expect(kind('slashdocs', 'docs', 'list', '--server=https://evil.example.com')).toBe('deny');
    expect(kind('gh', '--version')).toBe('deny');
    expect(kind('gh', 'pr', 'view', 'a\0b')).toBe('deny');
  });
});

describe('outsideFile', () => {
  it('refuses a file the run could not reach, and lets API paths and its own folders through', async () => {
    const home = await tempDir('ops-console-home-');
    const folder = await tempDir('ops-console-out-');
    await mkdir(path.join(home, '.ssh'));
    await writeFile(path.join(home, '.ssh', 'id_rsa'), 'key');
    await writeFile(path.join(folder, 'report.html'), '<p>hi</p>');
    await symlink(path.join(home, '.ssh', 'id_rsa'), path.join(folder, 'link.html'));
    const roots = [folder];
    expect(outsideFile(['docs', 'create', 'report.html'], roots, folder, home)).toBeNull();
    expect(outsideFile(['docs', 'create', path.join(folder, 'report.html')], roots, folder, home)).toBeNull();
    expect(outsideFile(['api', '/rest/api/1.0/projects'], roots, folder, home)).toBeNull();
    expect(outsideFile(['docs', 'create', '~/.ssh/id_rsa'], roots, folder, home)).toBe('~/.ssh/id_rsa');
    expect(outsideFile(['docs', 'create', path.join(home, '.ssh', 'id_rsa')], roots, folder, home)).not.toBeNull();
    await writeFile(path.join(home, 'secret.txt'), 's');
    expect(
      outsideFile(['docs', 'create', path.relative(folder, path.join(home, 'secret.txt'))], roots, folder, home),
    ).not.toBeNull();
    expect(outsideFile(['--body-file=/etc/hosts'], roots, folder, home)).not.toBeNull();
    // A link inside the folder to a file outside it is still outside.
    expect(outsideFile(['docs', 'create', 'link.html'], roots, folder, home)).toBe('link.html');
  });
});

describe('cliEnv', () => {
  it('passes the CLI its home and PATH and nothing of the daemon', () => {
    const env = cliEnv({
      HOME: '/home/a',
      PATH: '/usr/bin',
      OPS_CONSOLE_TOKEN: 's3cret',
      GH_TOKEN: 'x',
      AWS_SECRET_ACCESS_KEY: 'y',
    });
    expect(env.HOME).toBe('/home/a');
    expect(env.PATH).toContain('/usr/bin');
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(Object.keys(env)).not.toContain('OPS_CONSOLE_TOKEN');
    expect(Object.keys(env)).not.toContain('GH_TOKEN');
    expect(Object.keys(env)).not.toContain('AWS_SECRET_ACCESS_KEY');
  });
});
