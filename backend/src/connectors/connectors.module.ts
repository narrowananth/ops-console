import { type DynamicModule, Module } from '@nestjs/common';
import { CONNECTOR_TOOLS, type ConnectorTools } from './connector-tools';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import { GOOGLE_AUTH, type GoogleAuth, LoopbackGoogleAuth } from './google-auth';

/** The Connectors in Settings › Integrations. Other specs call `ConnectorsService.require` before an action that needs a Connector. */
@Module({})
export class ConnectorsModule {
  static forRoot(config: { tools: ConnectorTools; google?: GoogleAuth }): DynamicModule {
    return {
      module: ConnectorsModule,
      global: true,
      controllers: [ConnectorsController],
      providers: [
        { provide: CONNECTOR_TOOLS, useValue: config.tools },
        { provide: GOOGLE_AUTH, useValue: config.google ?? new LoopbackGoogleAuth(null) },
        ConnectorsService,
      ],
      exports: [ConnectorsService],
    };
  }
}
