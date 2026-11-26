import { CONNECTOR_SERVERS, ConnectorId } from '@ops-console/shared';
import { mcpTool } from '../action-log/classify';

/**
 * A Connector's MCP server with no read-only mode of its own stays read only here: a run may call the tools on its Read
 * list and no other. `writes` are the tools known to change things, left out of the run's tool list; the list of reads
 * is what refuses the rest, so a tool the vendor adds later is refused until the list names it.
 */
type ReadList = {
  service: string;
  /** Other names the same vendor's server arrives under: a plugin, a claude.ai connector, the desktop server. */
  alias: RegExp;
  reads: string[];
  writes: string[];
};

const serverOf = (id: ConnectorId): string => (CONNECTOR_SERVERS[id] as { name: string }).name;

const READ_LISTS: Record<string, ReadList> = {
  [serverOf(ConnectorId.Figma)]: {
    service: 'Figma',
    alias: /^(figma-desktop|claude_ai_figma|plugin_figma_figma)$/i,
    reads: [
      'get_design_context',
      'get_screenshot',
      'get_metadata',
      'get_variable_defs',
      'get_figjam',
      'get_comments',
      'get_code_connect_map',
      'get_code_connect_suggestions',
      'get_context_for_code_connect',
      'get_libraries',
      'search_design_system',
      'get_motion_context',
      'get_shader',
      'list_shaders',
      'list_file_shaders',
      'get_generative_plugin',
      'list_generative_plugins',
      'download_assets',
      'export_video',
      'whoami',
    ],
    writes: [
      'use_figma',
      'generate_figma_design',
      'html_to_figma',
      'send_code_to_figma',
      'upload_assets',
      'add_code_connect_map',
      'send_code_connect_mappings',
      'create_new_file',
      'generate_diagram',
      'generate_image',
      'generate_vector_illustration',
      'create_generative_plugin',
      'update_generative_plugin',
      'create_shader',
      'update_shader',
    ],
  },
};

const full = (server: string, tool: string) => `mcp__${server}__${tool}`;

/** The Read list that governs a server: the console's own, or one arriving under a name of the same vendor, in any case. */
function listFor(server: string): ReadList | null {
  const own = Object.entries(READ_LISTS).find(([name]) => name === server.toLowerCase());
  return own ? own[1] : (Object.values(READ_LISTS).find((list) => list.alias.test(server)) ?? null);
}

/** Why a run may not call `toolName`, when it is a tool of a server with a Read list that the list does not name; null otherwise. */
export function readListDenial(toolName: string): string | null {
  const call = mcpTool(toolName);
  const list = call && listFor(call.server);
  if (!list || list.reads.includes(call.tool)) return null;
  return `${list.service} is read only here: ${call.tool} is not allowed and nothing was changed. Use the read tools: ${list.reads.join(', ')}.`;
}

/** The known write tools of every server with a Read list, for `disallowedTools`. */
export function readListRefusals(): string[] {
  return Object.entries(READ_LISTS).flatMap(([server, list]) => list.writes.map((tool) => full(server, tool)));
}

/** What the agent is told about a server with a Read list. */
export function readListNote(server: string): string {
  const list = READ_LISTS[server] as ReadList;
  return `${list.service} is read only here. Read it with ${list.reads.map((tool) => full(server, tool)).join(', ')}. Any other ${list.service} tool is refused and changes nothing.`;
}

/** The servers with a Read list. */
export const READ_LIST_SERVERS = Object.keys(READ_LISTS);
