import { type DynamicModule, Module } from '@nestjs/common';
import { CONNECTOR_TOOLS, type ConnectorTools } from './connector-tools';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';

/** Settings › Connectors. Other specs call `ConnectorsService.require` before an action that needs a Connector. */
@Module({})
export class ConnectorsModule {
  static forRoot(config: { tools: ConnectorTools }): DynamicModule {
    return {
      module: ConnectorsModule,
      global: true,
      controllers: [ConnectorsController],
      providers: [{ provide: CONNECTOR_TOOLS, useValue: config.tools }, ConnectorsService],
      exports: [ConnectorsService],
    };
  }
}
