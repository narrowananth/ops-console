import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DynamicModule } from '@nestjs/common';
import { type Daemon, startDaemon } from '../src/daemon';
import { FakeKeychain } from './fakes/keychain';

export const FAKE_CLAUDE = path.resolve(import.meta.dirname, 'fakes/claude.mjs');
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../drizzle');

export async function tempDir(prefix = 'ops-console-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export type TestDaemon = Daemon & { log: string[] };

export async function startTestDaemon(
  options: {
    dataDir?: string;
    uiDir?: string | null;
    migrationsDir?: string;
    port?: number;
    modules?: DynamicModule[];
    log?: string[];
    claudeBin?: string;
  } = {},
): Promise<TestDaemon> {
  const log = options.log ?? [];
  const daemon = await startDaemon({
    dataDir: options.dataDir ?? (await tempDir()),
    port: options.port ?? 0,
    version: '1.2.3-test',
    uiDir: options.uiDir ?? null,
    migrationsDir: options.migrationsDir ?? MIGRATIONS_DIR,
    writeLog: (line) => log.push(line),
    modules: options.modules ?? [],
    claudeBin: options.claudeBin ?? FAKE_CLAUDE,
    keychain: new FakeKeychain(),
  });
  return Object.assign(daemon, { log });
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
