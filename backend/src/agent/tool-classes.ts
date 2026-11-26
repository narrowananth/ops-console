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
 * - `ask` (Notion, Shortcut, Render): a write asks the operator in every Access mode but `full`. A delete, and any tool no
 *   class places, asks in every Access mode. The classes are lists of tool names (Notion, Render), or for a server that
 *   publishes no names, `verbs`: words of the tool name, split at `-` and `_`. The first group with a word in the
 *   name wins: destructive, then write, then read.
 */
type Verbs = { destructive: string[]; write: string[]; read: string[] };

type ToolClasses = {
  service: string;
  /** Other names the same vendor's server arrives under: a plugin, a claude.ai connector, the desktop server. */
  alias: RegExp;
  /** What the agent does when the vendor refuses a call, told with the note. */
  onRefusal?: string;
} & (
  | { policy: 'read-only'; reads: string[]; writes: string[] }
  | { policy: 'ask'; reads: string[]; writes: string[]; destructive: string[] }
  | { policy: 'ask'; verbs: Verbs }
);

type ToolClass = 'read' | 'write' | 'destructive';

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
  [serverOf(ConnectorId.Shortcut)]: {
    service: 'Shortcut',
    policy: 'ask',
    alias: /^(claude_ai_shortcut|plugin_shortcut_shortcut)$/i,
    verbs: {
      destructive: ['delete', 'remove', 'archive', 'destroy'],
      write: [
        'create',
        'update',
        'add',
        'set',
        'assign',
        'unassign',
        'upload',
        'move',
        'merge',
        'link',
        'unlink',
        'start',
        'stop',
        'run',
        'cancel',
        'apply',
        'approve',
        'publish',
      ],
      read: ['get', 'search', 'list', 'find', 'read', 'whoami', 'current'],
    },
  },
  [serverOf(ConnectorId.Render)]: {
    service: 'Render',
    policy: 'ask',
    alias: /^(claude_ai_render|plugin_render_render)$/i,
    reads: [
      'list_workspaces',
      'get_selected_workspace',
      // The server holds the choice for the session; nothing is stored at Render.
      'select_workspace',
      'list_services',
      'get_service',
      'list_deploys',
      'get_deploy',
      'list_events',
      'list_logs',
      'list_log_label_values',
      'get_metrics',
      'list_postgres_instances',
      'get_postgres',
      'list_key_value',
      'get_key_value',
      'get_blueprint',
      'list_workflows',
      'get_workflow',
      'list_workflow_versions',
      'get_workflow_version',
      'list_workflow_tasks',
      'get_workflow_task',
      'list_workflow_runs',
      'get_workflow_run',
      'get_workflow_run_results',
      'list_flows',
      'get_flow',
      'list_flow_runs',
      'get_flow_run',
      'get_flow_run_results',
      'list_flow_run_steps',
      'get_flow_run_step',
    ],
    writes: [
      // Read-only SQL, but a query on a database: it asks.
      'query_render_postgres',
      'create_web_service',
      'create_static_site',
      'create_cron_job',
      'create_postgres',
      'create_key_value',
      'run_cron_job',
      'cancel_cron_job_run',
      'create_blueprint',
      'plan_blueprint',
      'update_blueprint',
      'create_workflow',
      'create_workflow_version',
      'start_flow_run',
      'cancel_flow_run',
    ],
    // `update_environment_variables` replaces the whole list. Render has no delete tool; one added later is unlisted.
    destructive: ['trigger_deploy', 'update_environment_variables', 'approve_blueprint'],
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

/** The class of a tool of an `ask` server. A name nothing places is destructive. */
function classOf(classes: Extract<ToolClasses, { policy: 'ask' }>, tool: string): ToolClass {
  if ('verbs' in classes) {
    const words = tool.toLowerCase().split(/[-_]+/);
    const has = (group: string[]) => words.some((word) => group.includes(word));
    if (has(classes.verbs.destructive)) return 'destructive';
    if (has(classes.verbs.write)) return 'write';
    return has(classes.verbs.read) ? 'read' : 'destructive';
  }
  if (classes.reads.includes(tool)) return 'read';
  return classes.writes.includes(tool) ? 'write' : 'destructive';
}

/** What `toolName` needs, when it is a tool of an `ask` server that is not a read; null otherwise. */
export function toolAsk(toolName: string): ToolAsk | null {
  const call = mcpTool(toolName);
  if (!call) return null;
  const classes = classesFor(call.server);
  if (classes?.policy !== 'ask') return null;
  const toolClass = classOf(classes, call.tool);
  if (toolClass === 'read') return null;
  return { service: classes.service, tool: call.tool, destructive: toolClass === 'destructive' };
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
  if ('verbs' in classes) {
    const { read, write, destructive } = classes.verbs;
    return [
      `${classes.service} can be read and changed. Its tools are sorted by the words of their names, split at - and _.`,
      `A name with ${destructive.join(', ')} in it deletes or archives and always asks the operator, in every Access mode.`,
      `Else a name with ${write.join(', ')} in it changes things and asks the operator first, unless the Session has Full access.`,
      `Else a name with ${read.join(', ')} in it reads and runs.`,
      `A tool the console cannot place always asks too.`,
    ].join(' ');
  }
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
const MAIN_INPUT = /^(?:.*_ids?|.*[a-z]Ids?|ids?|title|name|text|content|new_str|comment|rich_text|query|sql)$/;
const IS_ID = /(?:^|_)ids?$|[a-z]Ids?$/;

const cap = (text: string) => (text.length > CAP ? `${text.slice(0, CAP)}…` : text);

/** The names of a list of `{ key, value }` pairs, such as environment variables; null for any other value. */
function pairNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const names: string[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || !('value' in item) || !('key' in item)) return null;
    if (typeof item.key !== 'string') return null;
    names.push(item.key);
  }
  return names;
}

function mainInputs(value: unknown, key: string, depth: number, out: string[]): void {
  if (out.length >= PIECES) return;
  const names = pairNames(value);
  if (names) {
    // A list of pairs shows its names only: the values are the secrets.
    out.push(`${key} ${cap(redact(names.join(', ')))}`);
  } else if (typeof value === 'string' || typeof value === 'number') {
    if (MAIN_INPUT.test(key))
      out.push(IS_ID.test(key) ? `${key} ${cap(redact(String(value)))}` : `"${cap(redact(String(value)))}"`);
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
