import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  createTerminalSchema,
  type DiskAccess,
  type KeychainWait,
  type RunSandbox,
  type StartAtLogin,
  type TerminalKind,
  terminalSecretSchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { KEYCHAIN_WAIT, type KeychainWaitTracker } from '../keychain/keychain-wait';
import { DISK_ACCESS, type DiskAccessGate } from './disk-access';
import { RUN_SANDBOX, type RunSandboxGate } from './run-sandbox-gate';
import { START_AT_LOGIN, type StartAtLoginGate } from './start-at-login';
import { TerminalsService } from './terminals.service';

const idParams = z.object({ id: z.string().min(1) });
const toolParams = z.object({ id: z.string().min(1), tool: z.string().min(1) });

@Controller('terminals')
export class TerminalsController {
  constructor(
    @Inject(TerminalsService) private readonly terminals: TerminalsService,
    @Inject(DISK_ACCESS) private readonly diskAccess: DiskAccessGate,
    @Inject(START_AT_LOGIN) private readonly startAtLogin: StartAtLoginGate,
    @Inject(RUN_SANDBOX) private readonly runSandbox: RunSandboxGate,
    @Inject(KEYCHAIN_WAIT) private readonly keychainWait: KeychainWaitTracker,
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

  @Get('keychain-wait')
  readKeychainWait(): { data: KeychainWait } {
    return { data: this.keychainWait.state() };
  }

  @Get()
  list(): { data: { id: string; kind: TerminalKind }[] } {
    return { data: this.terminals.list() };
  }

  @Post()
  async create(@Body() body: unknown): Promise<{ data: { id: string } }> {
    return { data: await this.terminals.create(parseInput(createTerminalSchema, body, 'body').kind) };
  }

  /** Close: the only way the operator ends a running terminal. */
  @Delete(':id')
  @HttpCode(204)
  async end(@Param() params: unknown): Promise<void> {
    await this.terminals.end(parseInput(idParams, params, 'params').id);
  }

  @Post(':id/secrets')
  @HttpCode(204)
  answer(@Param() params: unknown, @Body() body: unknown): void {
    const { request_id, value } = parseInput(terminalSecretSchema, body, 'body');
    this.terminals.answerSecret(parseInput(idParams, params, 'params').id, request_id, value);
  }

  /** The setup agent's tools. They run the same code as the REST endpoints. */
  @Post(':id/tools/:tool')
  @HttpCode(200)
  async tool(@Param() params: unknown, @Body() body: unknown): Promise<{ data: unknown }> {
    const { id, tool } = parseInput(toolParams, params, 'params');
    return {
      data: await this.terminals.runTool(id, tool, parseInput(z.record(z.string(), z.unknown()), body ?? {}, 'body')),
    };
  }
}
