import { tool } from '@anthropic-ai/claude-agent-sdk';
import { ConnectionEnv, ConnectionType, ConnectorId } from '@ops-console/shared';
import { z } from 'zod';
import { CONSOLE_TOOLS_SERVER, guarded, type ToolResult } from './session-tools';

const connectionFields = {
  type: z.enum(ConnectionType),
  config: z
    .record(z.string(), z.unknown())
    .describe("The type's non-secret fields, such as host, port, database, user"),
  secret: z.string().optional().describe('A `{{secret:<n>}}` placeholder, never a real secret'),
};

/** What each of an Anonymous Session's console tools takes. */
export const anonymousToolSchemas = {
  test_connection: z.object(connectionFields),
  save_connection: z.object({
    name: z.string(),
    env: z.enum(ConnectionEnv),
    access: z.enum(['none', 'read', 'write']).optional(),
    ...connectionFields,
  }),
  connect_connector: z.object({ id: z.enum(ConnectorId) }),
  authenticate_mcp_server: z.object({ name: z.string() }),
  request_secret: z.object({
    label: z.string().min(1).describe('What the secret is, such as "Postgres password for orders"'),
  }),
  list_connections: z.object({}),
  list_mcp_servers: z.object({}),
  read_local_file: z.object({
    path: z.string().describe('Absolute, or starting at the home folder: `~/.pgpass`'),
    pick: z
      .array(z.string())
      .optional()
      .describe('Keys down to the part of a JSON file to return: `["mcpServers"]` from `~/.claude.json`'),
  }),
  list_local_folder: z.object({ path: z.string().describe('Absolute, or starting at the home folder: `~/Library`') }),
  fetch_url: z.object({ url: z.string() }),
  list_keychain_items: z.object({ filter: z.string().describe('Part of the name, such as "TablePlus" or a host') }),
  read_keychain_secret: z.object({
    kind: z.enum(['generic', 'internet']).optional(),
    service: z.string(),
    account: z.string().optional(),
  }),
  add_mcp_server: z.object({
    name: z.string(),
    url: z.string(),
    transport: z.enum(['http', 'sse']).optional(),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Such as Authorization; a secret goes in as its `{{secret:<n>}}`'),
  }),
} as const;

export type AnonymousToolName = keyof typeof anonymousToolSchemas;

export const ANONYMOUS_TOOL_NAMES = Object.keys(anonymousToolSchemas) as AnonymousToolName[];

/** One call of one tool, its input already checked. */
export type AnonymousCall = {
  [Name in AnonymousToolName]: { tool: Name; input: z.infer<(typeof anonymousToolSchemas)[Name]> };
}[AnonymousToolName];

/** The tool's name as Claude Code reports it, and the name back from it; undefined for any other tool. */
export const anonymousToolId = (name: AnonymousToolName): string => `mcp__${CONSOLE_TOOLS_SERVER}__${name}`;

export function anonymousToolOf(toolName: string): AnonymousToolName | undefined {
  return ANONYMOUS_TOOL_NAMES.find((name) => anonymousToolId(name) === toolName);
}

/** The call a tool name and its raw input make, or why the input is wrong. */
export function parseAnonymousCall(
  name: AnonymousToolName,
  input: unknown,
): { call: AnonymousCall } | { error: string } {
  const parsed = anonymousToolSchemas[name].safeParse(input);
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => issue.path.join('.') || 'input').join(', ');
    return { error: `${name} was not given valid input (${where}).` };
  }
  return { call: { tool: name, input: parsed.data } as AnonymousCall };
}

/** What the operator's Approval says, and what the Action Log row records. Neither holds a secret. */
export type ToolPlan = {
  /** Where the call reaches, for the Action Log. */
  target: string;
  /** The Action Log's command text. */
  command: string;
  /** The Approval's wording. Null for a tool that asks for none. */
  approval: string | null;
};

/** What an Anonymous Session's tools call. The Anonymous tools module provides it. */
export interface AnonymousTools {
  /** Whether this run gets the tools: an Anonymous Session the operator started, with no Alert behind it. */
  offers(sessionId: string): boolean;
  /** Checks the call and says what it will do. Throws an `ApiError` the agent is told when it cannot run. */
  plan(sessionId: string, call: AnonymousCall): ToolPlan;
  /** Runs the call. A secret in the answer is a `{{secret:<n>}}` placeholder: only the daemon holds the value. */
  run(sessionId: string, call: AnonymousCall, signal: AbortSignal | undefined): Promise<unknown>;
}

const DESCRIPTIONS: Record<AnonymousToolName, string> = {
  test_connection:
    'Starts the database server with the given secret and runs one read. Stores nothing. The operator approves each test.',
  save_connection:
    'Saves a new Connection and registers its MCP Server, after the operator approves. Fails if the name is taken. Test it first with test_connection.',
  connect_connector:
    'Starts the sign-in of a Connector, after the operator approves. The operator finishes it in the browser.',
  authenticate_mcp_server:
    'Starts the browser sign-in of a registered MCP Server, after the operator approves. The operator finishes it in the browser.',
  request_secret:
    'Asks the operator for a secret in a masked field in this Session. Returns the `{{secret:<n>}}` placeholder to pass on as a secret. You never see the value. Use it instead of asking the operator to type a password into the chat.',
  list_connections: 'The Connections the console has: name, type, env, access and non-secret config.',
  list_mcp_servers:
    'The MCP Servers the console has, from every account and Repo: name, scope, transport and URL. No headers.',
  read_local_file:
    "Reads a text file on the operator's machine, up to 512 KB. Secrets in it come back as `{{secret:<n>}}`. For a big JSON file, `pick` returns one part of it, from a file of any size.",
  list_local_folder: "Lists a folder on the operator's machine: each entry's name, kind and size.",
  fetch_url: 'Fetches an http or https page as text, up to 1 MB. Secrets in it come back as `{{secret:<n>}}`.',
  list_keychain_items:
    "Finds the operator's macOS Keychain items by service, account or label. Never returns a secret.",
  read_keychain_secret:
    "Reads one Keychain item's secret, after the operator approves and macOS asks to allow it. Returns its `{{secret:<n>}}` placeholder.",
  add_mcp_server:
    'Registers a remote MCP Server by URL for every account, after the operator approves. Start its sign-in with authenticate_mcp_server.',
};

const asText = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});

/** The tools themselves. The runtime's PreToolUse hook gates each call before it gets here. */
export function anonymousSessionTools(tools: AnonymousTools, sessionId: string, runSignal?: AbortSignal) {
  const make = <Name extends AnonymousToolName>(name: Name) =>
    tool(name, DESCRIPTIONS[name], anonymousToolSchemas[name].shape, (args, extra) =>
      guarded(
        async () => asText(await tools.run(sessionId, { tool: name, input: args } as AnonymousCall, runSignal)),
        `${name} failed.`,
        extra,
        runSignal,
      ),
    );
  return [
    make('list_connections'),
    make('test_connection'),
    make('save_connection'),
    make('connect_connector'),
    make('list_mcp_servers'),
    make('add_mcp_server'),
    make('authenticate_mcp_server'),
    make('request_secret'),
    make('read_local_file'),
    make('list_local_folder'),
    make('fetch_url'),
    make('list_keychain_items'),
    make('read_keychain_secret'),
  ];
}
