import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type CallToolResult, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '@ops-console/shared';
import type { ClaudeCli, McpServerConfig } from '../claude-cli/claude-cli';
import { ApiError } from '../common/errors';

export const MCP_CLIENT = Symbol('MCP_CLIENT');

/**
 * Calls a tool on a server registered with Claude Code, with the config `claude mcp get` returns, for a
 * fixed read with no model turn (ADR 0005). One connection per call.
 */
export class McpClient {
  constructor(
    private readonly claude: ClaudeCli,
    private readonly version: string,
  ) {}

  async callTool(server: string, tool: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const config = await this.claude.mcpGet(server);
    const client = new Client({ name: 'ops-console', version: this.version });
    let result: CallToolResult;
    try {
      await client.connect(transportFor(config));
      result = CallToolResultSchema.parse(await client.callTool({ name: tool, arguments: args }));
    } catch {
      throw new ApiError(502, ErrorCode.UpstreamFailed, `MCP server ${server} failed on ${tool}`);
    } finally {
      await client.close();
    }
    if (result.isError) {
      throw new ApiError(502, ErrorCode.UpstreamFailed, `MCP server ${server} returned an error from ${tool}`);
    }
    return result;
  }
}

function transportFor(config: McpServerConfig): Transport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: 'ignore',
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
}
