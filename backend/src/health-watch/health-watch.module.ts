import { type DynamicModule, Module } from '@nestjs/common';
import { HealthWatchController } from './health-watch.controller';
import { HealthWatch } from './health-watch.service';

/** Automatic checks of Connections, Connectors and MCP servers, their history, and the alert when one breaks. */
@Module({})
export class HealthWatchModule {
  static forRoot(): DynamicModule {
    return {
      module: HealthWatchModule,
      global: true,
      controllers: [HealthWatchController],
      providers: [HealthWatch],
      exports: [HealthWatch],
    };
  }
}
