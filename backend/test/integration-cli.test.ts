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

describe('classifyCli for logcli', () => {
  const QUERY = '{service_name="shop-api"} | json | status >= 500';
  const reason = (...args: string[]) => {
    const verdict = classifyCli('logcli', args);
    return verdict.kind === 'deny' ? verdict.reason : null;
  };

  it('reads a log or metric query, the labels and the series, with the flags for time, limit, output and quiet', () => {
    for (const args of [
      ['query', QUERY],
      ['query', '--since', '2h', '--limit', '100', QUERY],
      ['query', '--since=2h', '--limit=100', QUERY],
      ['query', '--from', '2026-10-01T00:00:00Z', '--to', '2026-10-01T01:00:00Z', QUERY],
      ['query', '-o', 'jsonl', '-q', '-z', 'UTC', QUERY],
      ['query', '--output=raw', '--quiet', '--timezone=UTC', '--output-timestamp-format=rfc3339nano', QUERY],
      ['query', '--forward', '--batch', '500', '--no-labels', QUERY],
      ['query', '--step', '10m', '--interval', '1m', 'sum by (route) (count_over_time({a="b"} [10m]))'],
      [
        'query',
        '--include-label',
        'route',
        '--exclude-label',
        'pod',
        '--include-common-labels',
        '--labels-length',
        '10',
        QUERY,
      ],
      ['labels'],
      ['labels', 'service_name', '--since', '24h'],
      ['labels', '--from=2026-10-01T00:00:00Z', '--to=2026-10-02T00:00:00Z'],
      ['series', '{service_name="shop-api"}', '--since', '1h'],
      ['series', '--analyze-labels', '{service_name=~".+"}'],
    ]) {
      expect(classifyCli('logcli', args), args.join(' ')).toEqual({ kind: 'read' });
    }
  });

  it('refuses every flag that changes the address, tenant, credentials, TLS or proxy, in both spellings, and runs nothing', () => {
    for (const flag of [
      '--addr',
      '--org-id',
      '--username',
      '--password',
      '--bearer-token',
      '--bearer-token-file',
      '--tls-skip-verify',
      '--ca-cert',
      '--cert',
      '--key',
      '--proxy-url',
      '--envproxy',
      '--auth-header',
      '--header',
      '--query-tags',
      '--compress',
      '--nocache',
    ]) {
      expect(reason('query', flag, 'https://evil.example.com', QUERY), `${flag} value`).toMatch(new RegExp(`^${flag}`));
      expect(reason('query', `${flag}=https://evil.example.com`, QUERY), `${flag}=value`).toMatch(
        new RegExp(`^${flag}`),
      );
      expect(reason('labels', flag), `${flag} alone`).toMatch(new RegExp(`^${flag}`));
    }
  });

  it('refuses a flag it does not know, a flag that reads or writes a file, and live tailing', () => {
    for (const flag of [
      '--tail',
      '-t',
      '-f',
      '--follow',
      '--store-config',
      '--remote-schema',
      '--schema-store',
      '--part-path-prefix',
      '--merge-parts',
      '--keep-parts',
      '--stdin',
      '--parallel-max-workers',
      '--retries',
      '--log.level',
      '--cpuprofile',
      '--memprofile',
      '--help',
      '--version',
      '--config',
      '--env-file',
      '--no-quiet',
      '--future-flag',
    ]) {
      expect(reason('query', flag, QUERY), flag).toMatch(/not allowed|not on the list/);
    }
  });

  it('refuses a short flag that is combined with another or glued to its value, since the CLI reads it differently', () => {
    expect(reason('query', '-qo', 'jsonl', QUERY)).not.toBeNull();
    expect(reason('query', '-ojsonl', QUERY)).not.toBeNull();
    expect(reason('query', '-qz', 'UTC', QUERY)).not.toBeNull();
    expect(reason('query', '-H', QUERY)).not.toBeNull();
  });

  it('refuses a flag value that starts with a dash, in both spellings, so no flag hides as a value', () => {
    expect(reason('query', QUERY, '--limit', '--addr=http://evil.example')).toMatch(/--limit.*value/);
    expect(reason('query', '-o', '--addr', 'http://evil.example', QUERY)).toMatch(/-o.*value/);
    expect(reason('query', '--since', '--bearer-token=x', QUERY)).toMatch(/--since.*value/);
    for (const args of [
      ['query', '--since=1h', QUERY],
      ['query', '--since', '1h', QUERY],
      ['query', '--limit', '10', QUERY],
      ['query', '-o', 'jsonl', QUERY],
    ]) {
      expect(classifyCli('logcli', args), args.join(' ')).toEqual({ kind: 'read' });
    }
  });

  it('refuses an argument that makes the CLI read its arguments from a file, and the end-of-flags marker', () => {
    expect(reason('query', '@/tmp/args.txt')).toMatch(/file/);
    expect(reason('query', '--limit', '@/tmp/args.txt', QUERY)).toMatch(/file/);
    expect(reason('labels', '--since=@/tmp/args.txt')).toMatch(/file/);
    expect(reason('query', '--', '--addr=https://evil.example.com', QUERY)).not.toBeNull();
  });

  it('refuses every other command, and a flag before the command', () => {
    for (const args of [
      ['instant-query', QUERY],
      ['stats', QUERY],
      ['volume', QUERY],
      ['detected-fields', QUERY],
      ['fmt'],
      ['delete', 'create', QUERY],
      ['help'],
      ['--addr=https://evil.example.com', 'query', QUERY],
      ['-q', 'query', QUERY],
    ]) {
      expect(reason(...args), args.join(' ')).not.toBeNull();
    }
    expect(reason('delete', 'create', QUERY)).toContain('delete');
  });

  it('lets a query say anything a log line might, such as a merge word or an @', () => {
    expect(classifyCli('logcli', ['query', '{app="x"} |= "auto-merge"'])).toEqual({ kind: 'read' });
    expect(classifyCli('logcli', ['query', '{app="x"} |= "a@b.example.com"'])).toEqual({ kind: 'read' });
  });
});

describe('classifyCli for newrelic', () => {
  const NRQL = "SELECT count(*) FROM Log WHERE `service.name` = 'shop-api' SINCE 1 hour ago";
  const reason = (...args: string[]) => {
    const verdict = classifyCli('newrelic', args);
    return verdict.kind === 'deny' ? verdict.reason : null;
  };

  it('reads an NRQL query, with the flags for the query and the output format, in both spellings', () => {
    for (const args of [
      ['nrql', 'query', '--query', NRQL],
      ['nrql', 'query', `--query=${NRQL}`],
      ['nrql', 'query', '--query', NRQL, '--format', 'JSON'],
      ['nrql', 'query', '--format=Text', `--query=${NRQL}`],
      ['nrql', 'query', '--format', 'yaml', '--query', NRQL],
    ]) {
      expect(classifyCli('newrelic', args), args.join(' ')).toEqual({ kind: 'read' });
    }
  });

  it('refuses every flag that changes the key, account, region or profile, or what the CLI logs or reads, in both spellings, and runs nothing', () => {
    for (const flag of [
      '--apiKey',
      '--accountId',
      '--region',
      '--profile',
      '--licenseKey',
      '--debug',
      '--trace',
      '--plain',
      '--config',
      '--configFile',
      '--help',
      '--version',
    ]) {
      expect(reason('nrql', 'query', flag, 'x', '--query', NRQL), `${flag} value`).toMatch(new RegExp(`^${flag}`));
      expect(reason('nrql', 'query', `${flag}=x`, '--query', NRQL), `${flag}=value`).toMatch(new RegExp(`^${flag}`));
      expect(reason('nrql', 'query', '--query', NRQL, flag), `${flag} alone`).toMatch(new RegExp(`^${flag}`));
    }
    for (const short of ['-a', '-q', '-h', '-v']) {
      expect(reason('nrql', 'query', short, 'x'), short).toMatch(new RegExp(`^${short} `));
    }
  });

  it('refuses an abbreviation, a flag in another case, and a flag with no value', () => {
    for (const flag of ['--que', '--q', '--form', '--QUERY', '--Query', '--FORMAT', '--Format']) {
      expect(reason('nrql', 'query', flag, NRQL), flag).toMatch(/not allowed/);
    }
    expect(reason('nrql', 'query', '--query', NRQL, '--format=')).toMatch(/--format.*value/);
    expect(reason('nrql', 'query', '--query', NRQL, '--format')).toMatch(/--format.*value/);
    expect(reason('nrql', 'query', '--query=')).toMatch(/--query.*value/);
  });

  it('refuses every other command, in any case, and a flag before the command', () => {
    for (const args of [
      ['nerdgraph', 'query', '{ actor { user { email } } }'],
      ['profile', 'list'],
      ['profile', 'add', '--profile', 'x'],
      ['apiAccess', 'create'],
      ['config', 'list'],
      ['events', 'post'],
      ['entity', 'search'],
      ['workload', 'list'],
      ['diagnose', 'run'],
      ['install'],
      ['nrql'],
      ['nrql', 'history'],
      ['query', '--query', NRQL],
      ['NRQL', 'query', '--query', NRQL],
      ['nrql', 'QUERY', '--query', NRQL],
      ['--accountId=1', 'nrql', 'query'],
      ['help'],
    ]) {
      expect(reason(...args), args.join(' ')).not.toBeNull();
    }
    expect(reason('nerdgraph', 'query', 'x')).toContain('nerdgraph');
  });

  it('refuses a flag value that starts with a dash, in both spellings, so no flag hides as a value', () => {
    expect(reason('nrql', 'query', '--query', '--accountId=1')).toMatch(/--query.*value/);
    expect(reason('nrql', 'query', '--query', '-1')).toMatch(/--query.*value/);
    expect(reason('nrql', 'query', '--query', NRQL, '--format', '--region')).toMatch(/--format.*value/);
    expect(reason('nrql', 'query', '--format', '--apiKey', 'x', '--query', NRQL)).toMatch(/--format.*value/);
    expect(reason('nrql', 'query', '--query=-x')).toMatch(/--query.*value/);
    expect(reason('nrql', 'query', '--query', NRQL, '--format=-x')).toMatch(/--format.*value/);
  });

  it('refuses the end-of-flags marker and a loose argument', () => {
    expect(reason('nrql', 'query', '--', '--accountId=1', '--query', NRQL)).not.toBeNull();
    expect(reason('nrql', 'query', '--query', NRQL, 'extra')).not.toBeNull();
    expect(reason('nrql', 'query', NRQL)).not.toBeNull();
  });

  it('lets a query say anything an event might, such as a flag name or a merge word', () => {
    for (const query of [
      "SELECT * FROM Log WHERE message = '--accountId=1'",
      "SELECT * FROM Log WHERE message LIKE '%auto-merge%'",
    ]) {
      expect(classifyCli('newrelic', ['nrql', 'query', '--query', query]), query).toEqual({ kind: 'read' });
    }
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
