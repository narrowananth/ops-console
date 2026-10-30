import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { type Settings, settingsPatchSchema } from '@ops-console/shared';
import { parseInput } from '../common/errors';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get()
  get(): { data: Settings } {
    return { data: this.settings.read() };
  }

  @Patch()
  patch(@Body() body: unknown): { data: Settings } {
    return { data: this.settings.update(parseInput(settingsPatchSchema, body, 'body')) };
  }
}
