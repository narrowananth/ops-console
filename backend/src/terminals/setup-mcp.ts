import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConnectorId } from '@ops-console/shared';
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
      inputSchema: { id: z.enum(ConnectorId) },
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
  server.registerTool(
    'list_connections',
    { description: 'The Connections the console has: name, type, env, access and non-secret config.', inputSchema: {} },
    () => call('list_connections', {}),
  );
  server.registerTool(
    'list_mcp_servers',
    {
      description:
        'The MCP Servers the console has, from every account and Repo: name, scope, transport and URL. No headers.',
      inputSchema: {},
    },
    () => call('list_mcp_servers', {}),
  );
  server.registerTool(
    'read_local_file',
    {
      description:
        "Reads a text file on the operator's machine, up to 512 KB. Secrets in it come back as `{{secret:<n>}}`. " +
        'For a big JSON file, `pick` returns one part of it, from a file of any size.',
      inputSchema: {
        path: z.string().describe('Absolute, or starting at the home folder: `~/.pgpass`'),
        pick: z
          .array(z.string())
          .optional()
          .describe('Keys down to the part of a JSON file to return: `["mcpServers"]` from `~/.claude.json`'),
      },
    },
    (args) => call('read_local_file', args),
  );
  server.registerTool(
    'list_local_folder',
    {
      description: "Lists a folder on the operator's machine: each entry's name, kind and size.",
      inputSchema: { path: z.string().describe('Absolute, or starting at the home folder: `~/Library`') },
    },
    (args) => call('list_local_folder', args),
  );
  server.registerTool(
    'fetch_url',
    {
      description: 'Fetches an http or https page as text, up to 1 MB. Secrets in it come back as `{{secret:<n>}}`.',
      inputSchema: { url: z.string() },
    },
    (args) => call('fetch_url', args),
  );
  server.registerTool(
    'list_keychain_items',
    {
      description: "Finds the operator's macOS Keychain items by service, account or label. Never returns a secret.",
      inputSchema: { filter: z.string().describe('Part of the name, such as "TablePlus" or a host') },
    },
    (args) => call('list_keychain_items', args),
  );
  server.registerTool(
    'read_keychain_secret',
    {
      description:
        "Reads one Keychain item's secret, after macOS asks the operator to allow it. Returns its `{{secret:<n>}}`.",
      inputSchema: {
        kind: z.enum(['generic', 'internet']).optional(),
        service: z.string(),
        account: z.string().optional(),
      },
    },
    (args) => call('read_keychain_secret', args),
  );
  server.registerTool(
    'add_mcp_server',
    {
      description:
        'Registers a remote MCP Server by URL for every account. Start its sign-in with authenticate_mcp_server.',
      inputSchema: {
        name: z.string(),
        url: z.string(),
        transport: z.enum(['http', 'sse']).optional(),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe('Such as Authorization; a secret goes in as its `{{secret:<n>}}`'),
      },
    },
    (args) => call('add_mcp_server', args),
  );
  await server.connect(new StdioServerTransport());
}
