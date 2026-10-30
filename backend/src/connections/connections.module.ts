import { type DynamicModule, Module } from '@nestjs/common';
import { CONNECTION_TESTER, type ConnectionTester } from './connection-tester';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';

/** Settings › Dev tools: database Connections and the MCP Servers registered for them. */
@Module({})
export class ConnectionsModule {
  static forRoot(config: { tester: ConnectionTester }): DynamicModule {
    return {
      module: ConnectionsModule,
      global: true,
      controllers: [ConnectionsController],
      providers: [{ provide: CONNECTION_TESTER, useValue: config.tester }, ConnectionsService],
      exports: [ConnectionsService],
    };
  }
}
