import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { addAccountSchema, type ClaudeAccount } from '@ops-console/shared';
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
  async add(@Body() body: unknown) {
    return { data: await this.accounts.add(parseInput(addAccountSchema, body, 'body').label) };
  }

  @Post(':id/checks')
  @HttpCode(200)
  async check(@Param() params: unknown): Promise<{ data: ClaudeAccount }> {
    return { data: await this.accounts.check(parseInput(idParams, params, 'params').id) };
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
