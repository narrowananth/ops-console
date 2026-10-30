import { type DynamicModule, Module } from '@nestjs/common';
import { CLAUDE_CLI, type ClaudeCli } from '../claude-cli/claude-cli';
import { MCP_CLIENT, McpClient } from './mcp-client';

@Module({})
export class McpClientModule {
  static forRoot(version: string): DynamicModule {
    return {
      module: McpClientModule,
      global: true,
      providers: [
        {
          provide: MCP_CLIENT,
          inject: [CLAUDE_CLI],
          useFactory: (claude: ClaudeCli) => new McpClient(claude, version),
        },
      ],
      exports: [MCP_CLIENT],
    };
  }
}
