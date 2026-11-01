import { type DynamicModule, Module } from '@nestjs/common';
import { DISK_ACCESS, type DiskAccessGate, MacDiskAccess } from './disk-access';
import { LOCAL_KEYCHAIN, type LocalKeychain, SecurityCliKeychain } from './local-sources';
import { TerminalGateway } from './terminal-gateway';
import { TerminalsController } from './terminals.controller';
import { TerminalsService } from './terminals.service';

/** Terminals behind an authenticated WebSocket. The Setup agent runs in the setup terminal; the Workspace adds more kinds. */
@Module({})
export class TerminalsModule {
  /**
   * `localKeychain` is where the setup agent finds other apps' saved passwords; `diskAccess` tells whether it may
   * read every folder. Tests pass fakes.
   */
  static forRoot(options: { localKeychain?: LocalKeychain; diskAccess?: DiskAccessGate } = {}): DynamicModule {
    return {
      module: TerminalsModule,
      controllers: [TerminalsController],
      providers: [
        TerminalsService,
        TerminalGateway,
        { provide: LOCAL_KEYCHAIN, useValue: options.localKeychain ?? new SecurityCliKeychain() },
        { provide: DISK_ACCESS, useValue: options.diskAccess ?? new MacDiskAccess() },
      ],
      exports: [TerminalsService],
    };
  }
}
