import { type DynamicModule, Module } from '@nestjs/common';
import { ConnectionGuard } from './connection-guard';
import { DevtoolsSessionsService } from './devtools-sessions.service';

/** Dev tools: `devtools` Sessions scoped to Connections, and the PROD-write rule on them. */
@Module({})
export class DevtoolsModule {
  static forRoot(): DynamicModule {
    return {
      module: DevtoolsModule,
      global: true,
      providers: [ConnectionGuard, DevtoolsSessionsService],
      exports: [DevtoolsSessionsService],
    };
  }
}
