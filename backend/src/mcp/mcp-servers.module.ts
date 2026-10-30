import { type DynamicModule, Module } from '@nestjs/common';
import { McpServersController } from './mcp-servers.controller';
import { ConnectionServers, MCP_CONFIG, type McpConfig, McpServersService } from './mcp-servers.service';
import { PROBE } from './probe';

/** Settings › MCP servers: the list across every Claude account, and add, edit, authenticate, disable and remove. */
@Module({})
export class McpServersModule {
  static forRoot(config: McpConfig): DynamicModule {
    return {
      module: McpServersModule,
      global: true,
      controllers: [McpServersController],
      providers: [
        { provide: MCP_CONFIG, useValue: config },
        { provide: PROBE, useValue: config.probe },
        ConnectionServers,
        McpServersService,
      ],
      exports: [McpServersService, ConnectionServers, MCP_CONFIG],
    };
  }
}
