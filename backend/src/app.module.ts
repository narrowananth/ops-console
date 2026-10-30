import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { ClaudeCliModule } from './claude-cli/claude-cli.module';
import { DATA_DIR } from './common/data-dir';
import { ErrorFilter } from './common/error.filter';
import { HealthController } from './common/health.controller';
import { StartupRecovery } from './common/recovery';
import { SESSION, type Session } from './common/session';
import { WsHub } from './common/ws-hub';
import { STORE, type Store } from './db/store';
import type { Keychain } from './keychain/keychain';
import { KeychainModule } from './keychain/keychain.module';
import { McpClientModule } from './mcp-client/mcp-client.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SettingsModule } from './settings/settings.module';

export type AppParts = {
  dataDir: string;
  session: Session;
  store: Store;
  hub: WsHub;
  keychain: Keychain;
  claudeBin: string;
  /** Feature modules; each later spec adds its own. */
  modules: DynamicModule[];
};

@Module({})
export class AppModule {
  static forRoot(parts: AppParts): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        AuthModule,
        SettingsModule,
        SchedulerModule,
        KeychainModule.forRoot(parts.keychain),
        ClaudeCliModule.forRoot(parts.claudeBin),
        McpClientModule.forRoot(parts.session.version),
        ...parts.modules,
      ],
      controllers: [HealthController],
      providers: [
        { provide: DATA_DIR, useValue: parts.dataDir },
        { provide: SESSION, useValue: parts.session },
        { provide: STORE, useValue: parts.store },
        { provide: WsHub, useValue: parts.hub },
        StartupRecovery,
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
      exports: [DATA_DIR, SESSION, STORE, WsHub, StartupRecovery],
    };
  }
}
