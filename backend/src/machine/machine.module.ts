import { type DynamicModule, Module } from '@nestjs/common';
import { DISK_ACCESS, type DiskAccessGate, MacDiskAccess } from './disk-access';
import { MachineController } from './machine.controller';
import { RUN_SANDBOX, type RunSandboxGate, SeatbeltRunSandbox } from './run-sandbox-gate';
import { MacStartAtLogin, START_AT_LOGIN, type StartAtLoginGate } from './start-at-login';

/** What the daemon needs from this Mac: Full Disk Access, Start at login, and whether the Run sandbox works. */
@Module({})
export class MachineModule {
  /** Tests pass fakes. */
  static forRoot(
    options: { diskAccess?: DiskAccessGate; startAtLogin?: StartAtLoginGate; runSandbox?: RunSandboxGate } = {},
  ): DynamicModule {
    return {
      module: MachineModule,
      controllers: [MachineController],
      providers: [
        { provide: DISK_ACCESS, useValue: options.diskAccess ?? new MacDiskAccess() },
        { provide: RUN_SANDBOX, useValue: options.runSandbox ?? new SeatbeltRunSandbox() },
        { provide: START_AT_LOGIN, useValue: options.startAtLogin ?? new MacStartAtLogin() },
      ],
    };
  }
}
