// A stdio MCP server with one tool, standing in for a server registered with Claude Code.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake', version: '1.0.0' });
server.registerTool('count_open_prs', { inputSchema: { repo: z.string() } }, ({ repo }) => ({
  content: [{ type: 'text', text: `${process.env.GREETING}: ${repo} has 3 open PRs` }],
}));
server.registerTool('broken', {}, () => ({ isError: true, content: [{ type: 'text', text: 'nope' }] }));
await server.connect(new StdioServerTransport());
