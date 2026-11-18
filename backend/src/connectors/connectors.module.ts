import { type DynamicModule, Module } from '@nestjs/common';
import { CONNECTOR_TOOLS, type ConnectorTools, GOOGLE_CLIENT, type GoogleClient } from './connector-tools';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';

/** The Connectors in Settings › Integrations. Other specs call `ConnectorsService.require` before an action that needs a Connector. */
@Module({})
export class ConnectorsModule {
  static forRoot(config: { tools: ConnectorTools; googleClient?: GoogleClient | null }): DynamicModule {
    return {
      module: ConnectorsModule,
      global: true,
      controllers: [ConnectorsController],
      providers: [
        { provide: CONNECTOR_TOOLS, useValue: config.tools },
        { provide: GOOGLE_CLIENT, useValue: config.googleClient ?? null },
        ConnectorsService,
      ],
      exports: [ConnectorsService],
    };
  }
}
