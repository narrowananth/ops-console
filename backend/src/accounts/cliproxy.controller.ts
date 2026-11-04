import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put } from '@nestjs/common';
import { type CliProxy, cliProxyKeySchema } from '@ops-console/shared';
import { parseInput } from '../common/errors';
import { CliProxyService } from './cliproxy.service';

/** CLIProxy as the Claude account hub. Turning it on and its address go through `PATCH /settings` key `cliproxy`. */
@Controller('cliproxy')
export class CliProxyController {
  constructor(@Inject(CliProxyService) private readonly cliProxy: CliProxyService) {}

  @Get()
  async get(): Promise<{ data: CliProxy }> {
    return { data: await this.cliProxy.view() };
  }

  @Put('key')
  async saveKey(@Body() body: unknown): Promise<{ data: CliProxy }> {
    return { data: await this.cliProxy.saveKey(parseInput(cliProxyKeySchema, body, 'body').key) };
  }

  @Delete('key')
  async deleteKey(): Promise<{ data: CliProxy }> {
    return { data: await this.cliProxy.deleteKey() };
  }

  @Post('checks')
  @HttpCode(200)
  async check(): Promise<{ data: CliProxy }> {
    return { data: await this.cliProxy.check() };
  }
}
