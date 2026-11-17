import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectionEnv, ConnectionType } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { connections } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { ProcessesService } from '../src/processes/processes.service';
import { prodConnectionsNamedIn } from '../src/processes/prod-env';
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
