import { type DynamicModule, Module } from '@nestjs/common';
import { DISK_ACCESS, type DiskAccessGate, MacDiskAccess } from './disk-access';
import { LOCAL_KEYCHAIN, type LocalKeychain, SecurityCliKeychain } from './local-sources';
import { MacStartAtLogin, START_AT_LOGIN, type StartAtLoginGate } from './start-at-login';
import { TerminalGateway } from './terminal-gateway';
import { TerminalsController } from './terminals.controller';
import { TerminalsService } from './terminals.service';

/** Terminals behind an authenticated WebSocket. The Setup agent runs in the setup terminal; the Workspace adds more kinds. */
@Module({})
export class TerminalsModule {
  /**
   * `localKeychain` is where the setup agent finds other apps' saved passwords; `diskAccess` tells whether it may
   * read every folder; `startAtLogin` whether launchd starts the daemon at login. Tests pass fakes.
   */
  static forRoot(
    options: { localKeychain?: LocalKeychain; diskAccess?: DiskAccessGate; startAtLogin?: StartAtLoginGate } = {},
  ): DynamicModule {
    return {
      module: TerminalsModule,
      controllers: [TerminalsController],
      providers: [
        TerminalsService,
        TerminalGateway,
        { provide: LOCAL_KEYCHAIN, useValue: options.localKeychain ?? new SecurityCliKeychain() },
        { provide: DISK_ACCESS, useValue: options.diskAccess ?? new MacDiskAccess() },
        { provide: START_AT_LOGIN, useValue: options.startAtLogin ?? new MacStartAtLogin() },
      ],
      exports: [TerminalsService],
    };
  }
}
