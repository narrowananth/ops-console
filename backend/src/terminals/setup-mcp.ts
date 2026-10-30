import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const connectionFields = {
  type: z.enum(['postgres', 'mongodb', 'redis', 'clickhouse', 'firebase', 'kafka']),
  config: z
    .record(z.string(), z.unknown())
    .describe("The type's non-secret fields, such as host, port, database, user"),
  secret: z.string().optional().describe('A `{{secret:<n>}}` placeholder, never a real secret'),
};

/**
 * `ops-console mcp-setup`: the MCP Server the setup agent runs. Each tool posts to the daemon, which resolves
 * `{{secret:<n>}}` placeholders itself; the secret never passes through here or Claude's transcript.
 */
export async function runSetupMcp(env: NodeJS.ProcessEnv): Promise<void> {
  const url = env.OPS_CONSOLE_URL;
  const token = env.OPS_CONSOLE_TOKEN;
  const terminal = env.OPS_CONSOLE_TERMINAL;
  if (!url || !token || !terminal)
    throw new Error('mcp-setup needs OPS_CONSOLE_URL, OPS_CONSOLE_TOKEN and OPS_CONSOLE_TERMINAL');

  const call = async (tool: string, args: unknown) => {
    const response = await fetch(`${url}/api/terminals/${terminal}/tools/${tool}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = (await response.json().catch(() => ({}))) as { data?: unknown; error?: { message?: string } };
    if (!response.ok) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: body.error?.message ?? `HTTP ${response.status}` }],
      };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(body.data) }] };
  };

  const server = new McpServer({ name: 'ops-console', version: '1' });
  server.registerTool(
    'test_connection',
    {
      description: 'Starts the database server with the given secret and runs one read. Stores nothing.',
      inputSchema: connectionFields,
    },
    (args) => call('test_connection', args),
  );
  server.registerTool(
    'save_connection',
    {
      description: 'Saves a new Connection and registers its MCP Server. Fails if the name is taken.',
      inputSchema: {
        name: z.string(),
        env: z.enum(['local', 'dev', 'staging', 'prod']),
        access: z.enum(['none', 'read', 'write']).optional(),
        ...connectionFields,
      },
    },
    (args) => call('save_connection', args),
  );
  server.registerTool(
    'connect_connector',
    {
      description: 'Starts the sign-in of a Connector. The operator finishes it in the browser.',
      inputSchema: {
        id: z.enum(['datadog', 'jira', 'github', 'gitlab', 'bitbucket', 'slack', 'sentry']),
        secret: z.string().optional(),
      },
    },
    (args) => call('connect_connector', args),
  );
  server.registerTool(
    'authenticate_mcp_server',
    { description: 'Starts the browser sign-in of a registered MCP Server.', inputSchema: { name: z.string() } },
    (args) => call('authenticate_mcp_server', args),
  );
  server.registerTool(
    'request_secret',
    {
      description: 'Asks the operator for a secret in a masked field. Returns the `{{secret:<n>}}` placeholder to use.',
      inputSchema: { label: z.string().describe('What the secret is, such as "Postgres password for orders"') },
    },
    (args) => call('request_secret', args),
  );
  await server.connect(new StdioServerTransport());
}
