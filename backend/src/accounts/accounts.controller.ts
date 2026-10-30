import { Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { ClaudeAccount } from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { AccountsService } from './accounts.service';

const idParams = z.object({ id: z.string().min(1) });

@Controller('agent-accounts')
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  @Get()
  list() {
    return this.accounts.list();
  }

  @Post()
  async add() {
    return { data: await this.accounts.add() };
  }

  @Post(':id/checks')
  @HttpCode(200)
  async check(@Param() params: unknown): Promise<{ data: ClaudeAccount }> {
    return { data: await this.accounts.check(parseInput(idParams, params, 'params').id) };
  }

  @Post(':id/logout')
  @HttpCode(200)
  async logout(@Param() params: unknown): Promise<{ data: ClaudeAccount }> {
    return { data: await this.accounts.logout(parseInput(idParams, params, 'params').id) };
  }

  @Post(':id/logins')
  @HttpCode(200)
  login(@Param() params: unknown): { data: ClaudeAccount } {
    return { data: this.accounts.startLogin(parseInput(idParams, params, 'params').id) };
  }

  @Delete(':id/logins')
  @HttpCode(204)
  async cancelLogin(@Param() params: unknown): Promise<void> {
    await this.accounts.cancelLogin(parseInput(idParams, params, 'params').id);
  }

  @Post(':id/activate')
  @HttpCode(200)
  activate(@Param() params: unknown): { data: ClaudeAccount } {
    return { data: this.accounts.activate(parseInput(idParams, params, 'params').id) };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param() params: unknown): Promise<void> {
    await this.accounts.remove(parseInput(idParams, params, 'params').id);
  }
}
