import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { installUpdateSchema, type UpdateState } from '@ops-console/shared';
import { parseInput } from '../common/errors';
import { UpdatesService } from './updates.service';

@Controller('updates')
export class UpdatesController {
  constructor(@Inject(UpdatesService) private readonly updates: UpdatesService) {}

  @Get()
  get(): { data: UpdateState } {
    return { data: this.updates.state() };
  }

  @Post('checks')
  @HttpCode(200)
  async check(): Promise<{ data: UpdateState }> {
    return { data: await this.updates.check() };
  }

  @Post()
  @HttpCode(202)
  async install(@Body() body: unknown): Promise<{ data: UpdateState }> {
    return { data: await this.updates.install(parseInput(installUpdateSchema, body, 'body').when) };
  }
}
