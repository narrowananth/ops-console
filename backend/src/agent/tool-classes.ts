import { CONNECTOR_SERVERS, ConnectorId } from '@ops-console/shared';
import { mcpTool } from '../action-log/classify';
import { redact } from '../action-log/redact';

/**
 * A Connector's MCP server has no read-only mode of its own, so the console sorts its tools into classes. A run may
 * call the `reads` freely. What else happens to a tool depends on the server's policy:
 *
 * - `read-only` (Figma): every tool off the list is refused with no Approval. `writes` are the tools known to change
 *   things, left out of the run's tool list; the list of reads is what refuses the rest, so a tool the vendor adds
 *   later is refused until the list names it.
 * - `ask` (Notion): a `writes` tool asks the operator in every Access mode but `full`. A `destructive` tool, and any tool
 *   no list names, asks in every Access mode.
 */
type ToolClasses = {
  service: string;
  /** Other names the same vendor's server arrives under: a plugin, a claude.ai connector, the desktop server. */
  alias: RegExp;
  reads: string[];
  writes: string[];
  /** What the agent does when the vendor refuses a call, told with the note. */
  onRefusal?: string;
} & ({ policy: 'read-only' } | { policy: 'ask'; destructive: string[] });

const serverOf = (id: ConnectorId): string => (CONNECTOR_SERVERS[id] as { name: string }).name;

const CLASSES: Record<string, ToolClasses> = {
  [serverOf(ConnectorId.Figma)]: {
    service: 'Figma',
    policy: 'read-only',
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
      'create_session',
      'weave_find_model',
      'weave_get_model_run_output',
      'weave_get_node_catalog',
      'weave_get_tool_inputs',
      'weave_get_tool_run_output',
      'weave_get_workflow',
      'weave_list_tools',
      'weave_search_workspace',
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
      'create_branch',
      'generate_diagram',
      'generate_image',
      'generate_vector_illustration',
      'create_generative_plugin',
      'update_generative_plugin',
      'create_shader',
      'update_shader',
      'weave_build_workflow',
      'weave_run_tool',
      'weave_run_model',
      'weave_upload_asset',
      'weave_cancel_tool_run',
      'weave_request_report',
    ],
    onRefusal:
      'If Figma refuses a call (no edit access, a plan or seat without access, a rate limit), call mcp__figma__whoami once and tell the operator the account, plan, tier and seat it reports, and that Starter plans get no calls and View and Collab seats 20 a month. Do not retry the refused call.',
  },
  [serverOf(ConnectorId.Notion)]: {
    service: 'Notion',
    policy: 'ask',
    alias: /^(claude_ai_notion|plugin_notion_notion)$/i,
    reads: [
      'notion-search',
      'notion-fetch',
      'notion-connector-search',
      'notion-list-private-pages',
      'notion-list-shared-pages',
      'notion-list-favorite-pages',
      'notion-list-recent-pages',
      'notion-list-page-backlinks',
      'notion-query-meeting-notes',
      'notion-query-data-sources',
      'notion-query-multiple-data-sources',
      'notion-get-comments',
      'notion-get-version-changes',
      'notion-view-version',
      'notion-get-suggested-edit',
      'notion-get-async-task',
      'notion-get-self',
      'notion-get-teams',
      'notion-get-groups',
      'notion-get-users',
      'notion-get-tool-access',
    ],
    writes: [
      'notion-create-pages',
      'notion-update-page',
      'notion-move-pages',
      'notion-duplicate-page',
      'notion-create-database',
      'notion-update-data-source',
      'notion-create-view',
      'notion-update-view',
      'notion-create-comment',
      'notion-update-comment',
      'notion-set-discussion-resolved',
      'notion-set-comment-reaction',
      'notion-create-suggested-edit',
      'notion-resolve-suggested-edit',
      'notion-restore-version',
      'notion-restore-pages',
    ],
    destructive: ['notion-delete-pages', 'notion-delete-databases', 'notion-delete-comment'],
  },
};

const full = (server: string, tool: string) => `mcp__${server}__${tool}`;

/** The classes that govern a server: the console's own, or one arriving under a name of the same vendor, in any case. */
function classesFor(server: string): ToolClasses | null {
  const own = Object.entries(CLASSES).find(([name]) => name === server.toLowerCase());
  return own ? own[1] : (Object.values(CLASSES).find((classes) => classes.alias.test(server)) ?? null);
}

/** Why a run may not call `toolName`, when it is a tool of a read-only server that its Read list does not name; null otherwise. */
export function toolRefusal(toolName: string): string | null {
  const call = mcpTool(toolName);
  if (!call) return null;
  const classes = classesFor(call.server);
  if (classes?.policy !== 'read-only' || classes.reads.includes(call.tool)) return null;
  return `${classes.service} is read only here: ${call.tool} is not allowed and nothing was changed. Use the read tools: ${classes.reads.join(', ')}.`;
}

/** A call that needs the operator's yes: `destructive` asks in every Access mode, a write in every mode but `full`. */
export type ToolAsk = { service: string; tool: string; destructive: boolean };

/** What `toolName` needs, when it is a tool of an `ask` server that is not a read; null otherwise. */
export function toolAsk(toolName: string): ToolAsk | null {
  const call = mcpTool(toolName);
  if (!call) return null;
  const classes = classesFor(call.server);
  if (classes?.policy !== 'ask' || classes.reads.includes(call.tool)) return null;
  return { service: classes.service, tool: call.tool, destructive: !classes.writes.includes(call.tool) };
}

/** The known write tools of every read-only server, for `disallowedTools`. */
export function toolRefusals(): string[] {
  return Object.entries(CLASSES).flatMap(([server, classes]) =>
    classes.policy === 'read-only' ? classes.writes.map((tool) => full(server, tool)) : [],
  );
}

/** What the agent is told about a server with classes. */
export function toolNote(server: string): string {
  const classes = CLASSES[server] as ToolClasses;
  const names = (tools: string[]) => tools.map((tool) => full(server, tool)).join(', ');
  const reads = `Read it with ${names(classes.reads)}.`;
  if (classes.policy === 'read-only') {
    return `${classes.service} is read only here. ${reads} Any other ${classes.service} tool is refused and changes nothing.${classes.onRefusal ? ` ${classes.onRefusal}` : ''}`;
  }
  return [
    `${classes.service} can be read and changed. ${reads}`,
    `These change things and ask the operator first, unless the Session has Full access: ${names(classes.writes)}.`,
    `These delete and always ask, in every Access mode: ${names(classes.destructive)}. Any other ${classes.service} tool always asks too.`,
  ].join(' ');
}

/** The servers with classes. */
export const CLASSED_SERVERS = Object.keys(CLASSES);

const CAP = 120;
const PIECES = 5;
/** The inputs that say what a call acts on and what it writes: ids, titles and text. */
const MAIN_INPUT = /^(?:.*_ids?|ids?|title|name|text|content|new_str|comment|rich_text|query)$/;

const cap = (text: string) => (text.length > CAP ? `${text.slice(0, CAP)}…` : text);

function mainInputs(value: unknown, key: string, depth: number, out: string[]): void {
  if (out.length >= PIECES) return;
  if (typeof value === 'string' || typeof value === 'number') {
    if (MAIN_INPUT.test(key))
      out.push(/(?:^|_)ids?$/.test(key) ? `${key} ${cap(redact(String(value)))}` : `"${cap(redact(String(value)))}"`);
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, PIECES)) mainInputs(item, key, depth, out);
  } else if (value !== null && typeof value === 'object' && depth < 3) {
    for (const [name, item] of Object.entries(value)) mainInputs(item, name, depth + 1, out);
  }
}

/** The tool and its main inputs for an Approval and the Action Log: capped and redacted, never the whole call. */
export function askSummary(ask: ToolAsk, input: Record<string, unknown>): string {
  const inputs: string[] = [];
  mainInputs(input, '', 0, inputs);
  return [ask.tool, ...inputs].join(', ');
}
