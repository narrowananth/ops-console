import { execFileSync } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectionEnv, ConnectionType } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { connections } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { ProcessesService } from '../src/processes/processes.service';
import { connectionsNamedIn, prodConnectionsNamedIn } from '../src/processes/prod-env';
import { type AgentDaemon, WORKING_DIR } from './agent-fixtures';
import { tempDir } from './helpers';
import { node, startProcess, startProcessDaemon, writeFixtures } from './process-fixtures';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  await rm(path.join(WORKING_DIR, '.env'), { force: true });
});

const prod = (name: string, host: string) => ({ name, config: JSON.stringify({ host, port: 5432, user: 'app' }) });

describe('PROD Connections a folder names in its .env', () => {
  it('finds a PROD Connection whose host the .env files hold, from any .env file, and no other', async () => {
    const dir = await tempDir('ops-console-env-');
    await writeFile(path.join(dir, '.env'), 'DATABASE_URL=postgres://u:p@db.orders.example.com:5432/app\n');
    await writeFile(path.join(dir, '.env.local'), 'REDIS=redis://cache.billing.example.com\n');
    await mkdir(path.join(dir, 'nested'));
    await writeFile(path.join(dir, 'nested', '.env'), 'X=db.nested.example.com\n');
    const found = await prodConnectionsNamedIn(dir, [
      prod('orders-prod', 'db.orders.example.com'),
      prod('billing-cache', 'CACHE.billing.example.com'),
      prod('nested-prod', 'db.nested.example.com'),
      prod('other', 'db.other.example.com'),
      { name: 'local-ish', config: JSON.stringify({ host: 'localhost' }) },
    ]);
    expect(found).toEqual(['billing-cache', 'orders-prod']);
  });

  it('finds nothing in a folder with no .env or with no PROD Connection', async () => {
    const dir = await tempDir('ops-console-env-');
    expect(await prodConnectionsNamedIn(dir, [prod('orders-prod', 'db.orders.example.com')])).toEqual([]);
    await writeFile(path.join(dir, '.env'), 'A=db.orders.example.com');
    expect(await prodConnectionsNamedIn(dir, [])).toEqual([]);
  });

  it('names the PROD Connection on the process the operator starts and in the agent Approval text', async () => {
    const { server } = await writeFixtures();
    const daemon = await startProcessDaemon();
    running.push(daemon);
    const store = daemon.app.get<Store>(STORE);
    store.write((tx) => {
      tx.insert(connections)
        .values({
          id: 'c1',
          name: 'orders-prod',
          type: ConnectionType.Postgres,
          env: ConnectionEnv.Prod,
          config: JSON.stringify({ host: 'db.orders.example.com' }),
        })
        .run();
      tx.insert(connections)
        .values({
          id: 'c2',
          name: 'orders-dev',
          type: ConnectionType.Postgres,
          env: ConnectionEnv.Dev,
          config: JSON.stringify({ host: 'db.dev.example.com' }),
        })
        .run();
    });
    const sessionId = daemon.createSession();
    const plain = await startProcess(daemon, sessionId, { name: 'plain', command: node(server) });
    expect(plain.prod_connections).toEqual([]);

    await writeFile(path.join(WORKING_DIR, '.env'), 'DB=db.orders.example.com\nDEV=db.dev.example.com\n');
    const started = await startProcess(daemon, sessionId, { name: 'api', command: node(server) });
    expect(started.prod_connections).toEqual(['orders-prod']);

    const described = await daemon.app
      .get(ProcessesService)
      .describeStart(sessionId, { name: 'api', command: 'pnpm dev' });
    expect(described.prod).toEqual(['orders-prod']);
    expect(described.summary).toContain("This folder's .env names the PROD Connection orders-prod");
  });
});

type Row = { id: string; name: string; env: string; access: string; config: string };
const row = (name: string, config: Record<string, unknown>, access = 'read', env = 'dev'): Row => ({
  id: `id-${name}`,
  name,
  env,
  access,
  config: JSON.stringify(config),
});
const namedIn = (folder: string, rows: Row[]) => connectionsNamedIn(folder, rows).map((r) => r.name);

describe('Connections a folder names in its .env', () => {
  it('names a read Connection whose host any .env file holds, in any case, and no other', async () => {
    const dir = await tempDir('ops-console-env-');
    await writeFile(path.join(dir, '.env'), 'DATABASE_URL=postgres://u:p@DB.orders.example.com:5432/app\n');
    await writeFile(path.join(dir, '.env.local'), 'KAFKA=kafka.billing.example.com:9092\n');
    await mkdir(path.join(dir, 'nested'));
    await writeFile(path.join(dir, 'nested', '.env'), 'X=db.nested.example.com\n');
    await writeFile(path.join(dir, 'config.yml'), 'host: db.yaml.example.com\n');
    expect(
      namedIn(dir, [
        row('orders', { host: 'db.orders.example.com', port: 5432, database: 'app', user: 'app' }),
        row('events', { bootstrap_servers: 'x', kafbat_url: 'https://kafka.billing.example.com/ui' }),
        row('nested', { host: 'db.nested.example.com' }),
        row('yaml', { host: 'db.yaml.example.com' }),
        row('other', { host: 'db.other.example.com' }),
      ]),
    ).toEqual(['orders', 'events']);
  });

  it('names a Connection on this machine only when both its port and its database name appear', async () => {
    const dir = await tempDir('ops-console-env-');
    await writeFile(
      path.join(dir, '.env'),
      'DATABASE_URL=postgres://u:p@localhost:5432/orders\nOTHER=postgres://u:p@localhost:6000/billing\nCACHE_PORT=15432\n',
    );
    const local = (name: string, port: number, database: string, host = 'localhost') =>
      row(name, { host, port, database, user: 'u' });
    expect(
      namedIn(dir, [
        local('both', 5432, 'orders'),
        local('both-by-address', 5432, 'orders', '127.0.0.1'),
        local('port-only', 5432, 'ledger'),
        local('name-only', 7000, 'orders'),
        local('longer-port', 432, 'orders'),
        local('other-db', 6000, 'billing'),
        local('neither', 7000, 'ledger'),
        row('redis-local', { host: '127.0.0.1', port: 5432, db_index: 0 }),
      ]),
    ).toEqual(['both', 'both-by-address', 'other-db']);
  });

  it('never names a Connection with Access Level write or none, and names a PROD one with read', async () => {
    const dir = await tempDir('ops-console-env-');
    await writeFile(path.join(dir, '.env'), 'A=db.example.com\n');
    const config = { host: 'db.example.com' };
    const found = connectionsNamedIn(dir, [
      row('reads', config),
      row('writes', config, 'write'),
      row('none', config, 'none'),
      row('prod-reads', config, 'read', 'prod'),
      row('prod-writes', config, 'write', 'prod'),
    ]);
    expect(found.map((r) => [r.name, r.env])).toEqual([
      ['reads', 'dev'],
      ['prod-reads', 'prod'],
    ]);
  });

  it('names nothing, and raises nothing, for a missing folder, no .env, an unreadable one or a file over 1 MB', async () => {
    const rows = [row('orders', { host: 'db.orders.example.com' })];
    expect(namedIn(path.join(await tempDir('ops-console-env-'), 'gone'), rows)).toEqual([]);
    const empty = await tempDir('ops-console-env-');
    expect(namedIn(empty, rows)).toEqual([]);
    const big = await tempDir('ops-console-env-');
    await writeFile(path.join(big, '.env'), `A=db.orders.example.com\n${'#'.repeat(1_000_001)}`);
    expect(namedIn(big, rows)).toEqual([]);
    const unreadable = await tempDir('ops-console-env-');
    await mkdir(path.join(unreadable, '.env'));
    expect(namedIn(unreadable, rows)).toEqual([]);
  });

  it('returns only the Connections it was given, never text from the file', async () => {
    const dir = await tempDir('ops-console-env-');
    await writeFile(path.join(dir, '.env'), 'DB_PASSWORD=hunter2-from-env\nHOST=db.orders.example.com\n');
    const given = row('orders', { host: 'db.orders.example.com' });
    const found = connectionsNamedIn(dir, [given]);
    expect(found).toEqual([given]);
    expect(JSON.stringify(found)).not.toContain('hunter2');
  });
});

describe('reading .env files safely', () => {
  const rows = [row('orders', { host: 'db.orders.example.com' })];
  const named = 'HOST=db.orders.example.com\n';

  it('skips a FIFO and a link to a device, promptly, and still reads the valid file beside them', async () => {
    const dir = await tempDir('ops-console-env-');
    execFileSync('mkfifo', [path.join(dir, '.env.fifo')]);
    await symlink('/dev/zero', path.join(dir, '.env.zero'));
    expect(namedIn(dir, rows)).toEqual([]);
    await writeFile(path.join(dir, '.env.local'), named);
    expect(namedIn(dir, rows)).toEqual(['orders']);
  }, 5000);

  it('does not follow a link to a regular file', async () => {
    const dir = await tempDir('ops-console-env-');
    await writeFile(path.join(dir, 'secrets.txt'), named);
    await symlink(path.join(dir, 'secrets.txt'), path.join(dir, '.env.link'));
    expect(namedIn(dir, rows)).toEqual([]);
  });

  it('lets a directory called .env, or a file over 1 MB, hide nothing', async () => {
    const dir = await tempDir('ops-console-env-');
    await mkdir(path.join(dir, '.env'));
    await writeFile(path.join(dir, '.env.big'), `${named}${'#'.repeat(1_000_001)}`);
    expect(namedIn(dir, rows)).toEqual([]);
    await writeFile(path.join(dir, '.env.local'), named);
    expect(namedIn(dir, rows)).toEqual(['orders']);
  });
});

describe('what names a Connection', () => {
  const dir = async (text: string) => {
    const folder = await tempDir('ops-console-env-');
    await writeFile(path.join(folder, '.env'), text);
    return folder;
  };

  it('uses the host field and the host of a URL field, never another dotted string', async () => {
    const folder = await dir('A=svc.ro\nB=app.v2\nC=reader.example.org\n');
    expect(
      namedIn(folder, [
        row('user', { host: 'db.unrelated.example.com', user: 'svc.ro' }),
        row('database', { host: 'db.unrelated.example.com', database: 'app.v2' }),
        row('email', { host: 'db.unrelated.example.com', note: 'reader.example.org' }),
      ]),
    ).toEqual([]);
  });

  it('matches a host on token boundaries only', async () => {
    const folder = await dir(
      [
        'A=notdb.example.com',
        'B=db.example.com.evil',
        'C=10.0.0.55',
        'D=my-db.example.com',
        'E=db.example.com-backup',
        '',
      ].join('\n'),
    );
    expect(namedIn(folder, [row('dotted', { host: 'db.example.com' }), row('address', { host: '10.0.0.5' })])).toEqual(
      [],
    );
  });

  it.each([
    ['a port after it', 'HOST=db.example.com:5432'],
    ['a URL', 'U=postgres://u:p@db.example.com/app'],
    ['double quotes', 'H="db.example.com"'],
    ['single quotes', "H='db.example.com'"],
    ['the end of the file', 'H=db.example.com'],
    ['a full stop ending a line', 'H=db.example.com.\nX=1'],
    ['another case', 'H=DB.Example.COM'],
    ['a comma list', 'H=db.example.com,other.example.com'],
  ])('matches a host written with %s', async (_label, text) => {
    expect(namedIn(await dir(text), [row('orders', { host: 'db.example.com' })])).toEqual(['orders']);
  });

  it('matches the host of a URL field, and the exact address of a host', async () => {
    const folder = await dir('A=10.0.0.5\nB=kafka.example.com\n');
    expect(
      namedIn(folder, [row('address', { host: '10.0.0.5' }), row('ui', { ui_url: 'https://kafka.example.com/ui' })]),
    ).toEqual(['address', 'ui']);
  });

  it('never matches a host shorter than 5 characters by itself', async () => {
    const folder = await dir('H=x.io\n');
    expect(namedIn(folder, [row('short', { host: 'x.io' })])).toEqual([]);
  });

  it('names a Connection on this machine only for its port and its database name as tokens, in this file', async () => {
    const folder = await dir('A=postgres://u:p@localhost:5432/orders\nB=localhost:5433/rebilling\nC=ledger2 5434\n');
    const local = (name: string, config: Record<string, unknown>) => row(name, { host: 'localhost', ...config });
    expect(
      namedIn(folder, [
        local('both', { port: 5432, database: 'orders' }),
        local('inside-a-word', { port: 5433, database: 'billing' }),
        local('longer-name', { port: 5434, database: 'ledger' }),
        local('no-database', { port: 5432 }),
        local('no-port', { database: 'orders' }),
        local('empty-database', { port: 5432, database: '' }),
      ]),
    ).toEqual(['both']);
  });
});

describe('which files count for the automatic pick', () => {
  const git = (folder: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: folder,
      stdio: 'ignore',
    });
  const rows = [row('orders', { host: 'db.orders.example.com' })];
  const named = 'HOST=db.orders.example.com\n';

  it('counts an untracked .env.local and nothing git tracks, nor a template, sample, example or dist', async () => {
    const folder = await tempDir('ops-console-env-');
    git(folder, 'init', '-q', '-b', 'main');
    await writeFile(path.join(folder, '.env.production'), named);
    await writeFile(path.join(folder, '.env.example'), named);
    await writeFile(path.join(folder, '.env.sample'), named);
    await writeFile(path.join(folder, '.env.template'), named);
    await writeFile(path.join(folder, '.env.dist'), named);
    git(folder, 'add', '.env.production');
    git(folder, 'commit', '-q', '-m', 'first');
    expect(namedIn(folder, rows)).toEqual([]);
    await writeFile(path.join(folder, '.env.local'), named);
    expect(namedIn(folder, rows)).toEqual(['orders']);
  });

  it('counts a file in a folder that is not a git repository', async () => {
    const folder = await tempDir('ops-console-env-');
    await writeFile(path.join(folder, '.env'), named);
    expect(namedIn(folder, rows)).toEqual(['orders']);
  });

  it('keeps the PROD tag of a process as it was: any .env file counts, tracked or an example', async () => {
    const folder = await tempDir('ops-console-env-');
    git(folder, 'init', '-q', '-b', 'main');
    await writeFile(path.join(folder, '.env'), named);
    await writeFile(path.join(folder, '.env.example'), 'X=db.example-prod.example.com\n');
    git(folder, 'add', '.env');
    git(folder, 'commit', '-q', '-m', 'first');
    expect(
      await prodConnectionsNamedIn(folder, [
        prod('orders-prod', 'db.orders.example.com'),
        prod('example-prod', 'db.example-prod.example.com'),
      ]),
    ).toEqual(['example-prod', 'orders-prod']);
  });
});
