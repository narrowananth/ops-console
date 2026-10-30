import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { type DynamicModule, type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { API_PREFIX, WS_PATH } from '@ops-console/shared';
import type Database from 'better-sqlite3';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AppModule } from './app.module';
import { lockDataDir, writeRuntimeFile } from './common/data-dir';
import { DaemonLogger, type WriteLog } from './common/logger';
import { StartupRecovery } from './common/recovery';
import { Session } from './common/session';
import { WsHub } from './common/ws-hub';
import { applyMigrations } from './db/migrate';
import { openSqlite } from './db/open';
import { Store } from './db/store';
import { type Keychain, LoginKeychain } from './keychain/keychain';
import { Scheduler } from './scheduler/scheduler';

const HOST = '127.0.0.1';

export type DaemonOptions = {
  dataDir: string;
  port: number;
  version: string;
  /** Built frontend; `null` in development, where Vite serves it. */
  uiDir: string | null;
  migrationsDir: string;
  writeLog: WriteLog;
  modules?: DynamicModule[];
  keychain?: Keychain;
  claudeBin?: string;
};

export type Daemon = {
  url: string;
  port: number;
  token: string;
  app: INestApplication;
  stop(): Promise<void>;
};

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const logger = new DaemonLogger(options.writeLog);
  Logger.overrideLogger(logger);
  const log = new Logger('daemon');
  const cleanups: (() => Promise<void> | void)[] = [];
  const undo = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  };

  try {
    await mkdir(options.dataDir, { recursive: true });
    cleanups.push(await lockDataDir(options.dataDir));

    const sqlite: Database.Database = openSqlite(options.dataDir);
    cleanups.push(() => {
      sqlite.close();
    });
    applyMigrations(sqlite, options.migrationsDir, (message) => log.log(message));

    const session = new Session(options.version);
    const hub = new WsHub(session);
    cleanups.push(() => hub.close());
    const app = await NestFactory.create(
      AppModule.forRoot({
        session,
        store: new Store(sqlite, hub),
        hub,
        keychain: options.keychain ?? new LoginKeychain(),
        claudeBin: options.claudeBin ?? 'claude',
        modules: options.modules ?? [],
      }),
      new ExpressAdapter(express()),
      { logger },
    );
    cleanups.push(() => app.close());
    app.setGlobalPrefix(API_PREFIX);
    if (options.uiDir) serveUi(app, options.uiDir);
    await app.init();

    await app.get(StartupRecovery).runAll();

    const server = app.getHttpServer() as Server;
    await listen(server, options.port);
    const port = (server.address() as AddressInfo).port;
    hub.attach(server);

    const scheduler = app.get(Scheduler);
    await scheduler.start();
    cleanups.push(() => scheduler.stop());

    cleanups.push(
      await writeRuntimeFile(options.dataDir, {
        pid: process.pid,
        port,
        version: options.version,
        started_at: session.startedAt,
        token: session.token,
      }),
    );
    log.log(`started ${options.version} on ${HOST}:${port}, data folder ${options.dataDir}`);

    return {
      url: `http://${HOST}:${port}`,
      port,
      token: session.token,
      app,
      async stop() {
        await undo();
        log.log('stopped');
      },
    };
  } catch (error) {
    log.error(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
    await undo();
    throw error;
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EADDRINUSE' ? new Error(`port ${port} is already in use`) : error);
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** Static files, with unknown client routes falling back to `index.html`. `/api` and `/ws` never fall back. */
function serveUi(app: INestApplication, uiDir: string): void {
  if (!existsSync(path.join(uiDir, 'index.html'))) throw new Error(`no built UI at ${uiDir}`);
  app.use(express.static(uiDir, { index: false }));
  app.use((request: Request, response: Response, next: NextFunction) => {
    const isClientRoute =
      request.method === 'GET' && !request.path.startsWith(`/${API_PREFIX}/`) && request.path !== WS_PATH;
    // `root` keeps send's dotfile check off the install path, which sits under ~/.ops-console.
    if (isClientRoute) response.sendFile('index.html', { root: uiDir });
    else next();
  });
}
