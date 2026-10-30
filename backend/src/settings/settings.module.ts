import { Global, Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsRegistry } from './settings.registry';
import { SettingsService } from './settings.service';

@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsRegistry, SettingsService],
  exports: [SettingsRegistry, SettingsService],
})
export class SettingsModule {}
