import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { DiskAccess, RunSandbox, StartAtLogin } from '@ops-console/shared';
import { DISK_ACCESS, type DiskAccessGate } from './disk-access';
import { RUN_SANDBOX, type RunSandboxGate } from './run-sandbox-gate';
import { START_AT_LOGIN, type StartAtLoginGate } from './start-at-login';

/** What the daemon needs from this Mac, shown on Accounts & Usage under On this machine. */
@Controller('terminals')
export class MachineController {
  constructor(
    @Inject(DISK_ACCESS) private readonly diskAccess: DiskAccessGate,
    @Inject(START_AT_LOGIN) private readonly startAtLogin: StartAtLoginGate,
    @Inject(RUN_SANDBOX) private readonly runSandbox: RunSandboxGate,
  ) {}

  @Get('disk-access')
  async checkDiskAccess(): Promise<{ data: DiskAccess }> {
    return { data: await this.diskAccess.check() };
  }

  @Post('disk-access/settings')
  @HttpCode(204)
  async openDiskAccessSettings(): Promise<void> {
    await this.diskAccess.openSettings();
  }

  @Get('start-at-login')
  async checkStartAtLogin(): Promise<{ data: StartAtLogin }> {
    return { data: await this.startAtLogin.check() };
  }

  @Post('start-at-login/settings')
  @HttpCode(204)
  async openLoginItemsSettings(): Promise<void> {
    await this.startAtLogin.openSettings();
  }

  @Get('run-sandbox')
  async checkRunSandbox(): Promise<{ data: RunSandbox }> {
    return { data: await this.runSandbox.check() };
  }
}
