import { describe, expect, it } from 'vitest';
import { askSummary, isClassedTool, toolAsk, toolNote, toolRefusal, toolRefusals } from '../src/agent/tool-classes';

const FIGMA_READS = [
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
];

const FIGMA_WRITES = [
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
];

describe('the Read list of the Figma server (read only)', () => {
  it('lets each of the 29 read tools through', () => {
    for (const tool of FIGMA_READS) expect(toolRefusal(`mcp__figma__${tool}`), tool).toBeNull();
  });

  it('refuses every write tool, and one Figma adds later, saying Figma is read only and nothing changed', () => {
    for (const tool of [...FIGMA_WRITES, 'a_tool_a_later_version_adds']) {
      expect(toolRefusal(`mcp__figma__${tool}`), tool).toMatch(/Figma is read only here.*nothing was changed/i);
    }
  });

  it('leaves the tools of every other server and the agent’s own tools alone', () => {
    for (const tool of ['mcp__sentry__update_issue', 'mcp__figma-notes__get_notes', 'Bash', 'Edit']) {
      expect(toolRefusal(tool), tool).toBeNull();
    }
  });

  it('holds under the other names Figma’s server can carry, whatever the case', () => {
    for (const server of ['Figma', 'figma-desktop', 'claude_ai_Figma', 'plugin_figma_figma']) {
      expect(toolRefusal(`mcp__${server}__use_figma`), server).toMatch(/Figma is read only here/);
      expect(toolRefusal(`mcp__${server}__get_design_context`), server).toBeNull();
    }
  });

  it('reads the server and the tool apart at the first double underscore after the server name', () => {
    // `figma` then `a__b`: a tool with a double underscore is still a tool of Figma and is not on the list.
    expect(toolRefusal('mcp__figma__a__b')).toMatch(/read only/);
    // The server `my`, whose tool is `figma__use_figma`: another server, left alone.
    expect(toolRefusal('mcp__my__figma__use_figma')).toBeNull();
  });

  it('names the known write tools of read only servers for the run to leave out of its tool list', () => {
    // Notion's writes ask instead: they stay in the tool list.
    expect(toolRefusals()).toEqual(FIGMA_WRITES.map((tool) => `mcp__figma__${tool}`));
  });

  it('never asks about a Figma tool: read or not, it runs or is refused', () => {
    for (const tool of [...FIGMA_READS, ...FIGMA_WRITES, 'a_later_tool'])
      expect(toolAsk(`mcp__figma__${tool}`)).toBeNull();
  });

  it('tells the agent Figma is read only and lists its tools', () => {
    const note = toolNote('figma');
    expect(note).toMatch(/Figma is read only here/);
    for (const tool of FIGMA_READS) expect(note).toContain(`mcp__figma__${tool}`);
  });

  it('tells the agent to name the account and seat with whoami when Figma refuses a call', () => {
    expect(toolNote('figma')).toMatch(/refuses a call.*mcp__figma__whoami.*account, plan, tier and seat/);
  });
});

const NOTION_READS = [
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
];

const NOTION_WRITES = [
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
];

const NOTION_DELETES = ['notion-delete-pages', 'notion-delete-databases', 'notion-delete-comment'];

describe('the tool classes of the Notion server (ask)', () => {
  it('lets a read through and asks about nothing', () => {
    for (const tool of NOTION_READS) {
      expect(toolRefusal(`mcp__notion__${tool}`), tool).toBeNull();
      expect(toolAsk(`mcp__notion__${tool}`), tool).toBeNull();
    }
  });

  it('asks about a write, which full access skips, and never refuses it', () => {
    for (const tool of NOTION_WRITES) {
      expect(toolAsk(`mcp__notion__${tool}`), tool).toEqual({ service: 'Notion', tool, destructive: false });
      expect(toolRefusal(`mcp__notion__${tool}`), tool).toBeNull();
    }
  });

  it('asks about a delete in every mode, and so does a tool no list names', () => {
    for (const tool of [...NOTION_DELETES, 'notion-a-later-tool', 'notion-get-files', 'x']) {
      expect(toolAsk(`mcp__notion__${tool}`), tool).toEqual({ service: 'Notion', tool, destructive: true });
      expect(toolRefusal(`mcp__notion__${tool}`), tool).toBeNull();
    }
  });

  it('holds under the other names Notion’s server can carry, whatever the case', () => {
    for (const server of ['Notion', 'claude_ai_Notion', 'plugin_notion_notion']) {
      expect(toolAsk(`mcp__${server}__notion-update-page`), server).toMatchObject({ destructive: false });
      expect(toolAsk(`mcp__${server}__notion-delete-pages`), server).toMatchObject({ destructive: true });
      expect(toolAsk(`mcp__${server}__notion-fetch`), server).toBeNull();
    }
  });

  it('reads the server and the tool apart at the first double underscore after the server name', () => {
    expect(toolAsk('mcp__notion__a__b')).toEqual({ service: 'Notion', tool: 'a__b', destructive: true });
    expect(toolAsk('mcp__my__notion__notion-delete-pages')).toBeNull();
  });

  it('leaves the tools of every other server and the agent’s own tools alone', () => {
    for (const tool of ['mcp__sentry__update_issue', 'mcp__notion-notes__create', 'mcp__notionx__a', 'Bash', 'Edit']) {
      expect(toolAsk(tool), tool).toBeNull();
    }
  });

  it('tells the agent which tools read, which change things and ask, and that deletes always ask', () => {
    const note = toolNote('notion');
    for (const tool of [...NOTION_READS, ...NOTION_WRITES, ...NOTION_DELETES])
      expect(note).toContain(`mcp__notion__${tool}`);
    expect(note).toMatch(/ask the operator first, unless the Session has Full access/);
    expect(note).toMatch(/always ask, in every Access mode/);
  });

  it('summarises a call with its tool and its main inputs, capped and redacted', () => {
    const ask = { service: 'Notion', tool: 'notion-update-page', destructive: false };
    expect(
      askSummary(ask, { page_id: '1f3a-9', command: 'update_properties', properties: { title: 'Release notes' } }),
    ).toBe('notion-update-page, page_id 1f3a-9, "update_properties", "Release notes"');
    const long = askSummary(ask, { page_id: 'p', content: 'x'.repeat(5000) });
    expect(long.length).toBeLessThan(200);
    expect(long).toContain('…');
    expect(askSummary(ask, { page_id: 'p', content: 'use token=hunter2 for it' })).not.toContain('hunter2');
    expect(askSummary(ask, {})).toBe('notion-update-page');
  });

  it('shows what an update does: its command and whether it archives', () => {
    const ask = { service: 'Notion', tool: 'notion-update-page', destructive: false };
    expect(askSummary(ask, { page_id: 'p1', command: 'replace_content', new_str: 'x' })).toBe(
      'notion-update-page, page_id p1, "replace_content", "x"',
    );
    expect(askSummary({ ...ask, service: 'Shortcut', tool: 'stories-update' }, { story_id: 7, archived: true })).toBe(
      'stories-update, story_id 7, "true"',
    );
  });
});

const SHORTCUT_READS = [
  'stories-get-by-id',
  'stories-search',
  'stories-get-history',
  'stories-get-branch-name',
  'epics-get-by-id',
  'whoami',
  'get_story',
  'search_stories',
  'iterations-list',
];

const SHORTCUT_WRITES = [
  'stories-create',
  'stories-update',
  'stories-create-comment',
  'stories-upload-file',
  // `assign` is a write word and comes before the read word `current`.
  'stories-assign-current-user',
  'stories-add-task',
  'stories-add-relation',
  'epics-create-comment',
  'create_story',
  'update_story',
];

const SHORTCUT_DELETES = [
  'epics-delete',
  'stories-remove-subtask',
  'stories-remove-external-link',
  'stories-archive',
  'stories-update-and-archive',
  'delete_story',
  // A delete word wins over a read word.
  'stories-get-and-delete',
];

describe('the tool classes of the Shortcut server (ask, by the words of the name)', () => {
  it('lets a read through and asks about nothing', () => {
    for (const tool of SHORTCUT_READS) {
      expect(toolAsk(`mcp__shortcut__${tool}`), tool).toBeNull();
      expect(toolRefusal(`mcp__shortcut__${tool}`), tool).toBeNull();
    }
  });

  it('asks about a write, which full access skips', () => {
    for (const tool of SHORTCUT_WRITES) {
      expect(toolAsk(`mcp__shortcut__${tool}`), tool).toEqual({ service: 'Shortcut', tool, destructive: false });
    }
  });

  it('asks about a delete in every mode, and so does a name no group places', () => {
    for (const tool of [...SHORTCUT_DELETES, 'iterations-frobnicate', 'x', 'stories', 'getstory']) {
      expect(toolAsk(`mcp__shortcut__${tool}`), tool).toEqual({ service: 'Shortcut', tool, destructive: true });
    }
  });

  it('asks about a name that holds a read word and a word no group places, since the unknown word may change things', () => {
    for (const tool of [
      'notifications-mark-read',
      'stories-find-and-replace',
      'stories-list-and-reorder',
      'stories-get-and-complete',
      'stories-get-and-transition',
    ]) {
      expect(toolAsk(`mcp__shortcut__${tool}`), tool).not.toBeNull();
    }
    // The change verbs a tool can carry are write words, so they ask, and Full access skips the question.
    for (const tool of ['stories-mark-complete', 'stories-reorder', 'stories-close', 'iterations-rename']) {
      expect(toolAsk(`mcp__shortcut__${tool}`), tool).toEqual({ service: 'Shortcut', tool, destructive: false });
    }
    // The nouns a read names stay reads.
    for (const tool of ['workflows-list', 'objectives-get-by-id', 'documents-search', 'teams-list', 'members-list']) {
      expect(toolAsk(`mcp__shortcut__${tool}`), tool).toBeNull();
    }
  });

  it('splits at hyphens and underscores only, whatever the case, so a word inside another word is no match', () => {
    expect(toolAsk('mcp__shortcut__Stories-GET-By-Id')).toBeNull();
    expect(toolAsk('mcp__shortcut__STORIES_CREATE')).toMatchObject({ destructive: false });
    // `getter` and `updated` are not the words `get` and `update`.
    expect(toolAsk('mcp__shortcut__stories-getter')).toMatchObject({ destructive: true });
    expect(toolAsk('mcp__shortcut__stories-updated')).toMatchObject({ destructive: true });
  });

  it('holds under the other names Shortcut’s server can carry, whatever the case', () => {
    for (const server of ['Shortcut', 'claude_ai_Shortcut', 'plugin_shortcut_shortcut']) {
      expect(toolAsk(`mcp__${server}__stories-create`), server).toMatchObject({ destructive: false });
      expect(toolAsk(`mcp__${server}__epics-delete`), server).toMatchObject({ destructive: true });
      expect(toolAsk(`mcp__${server}__stories-search`), server).toBeNull();
    }
  });

  it('reads the server and the tool apart at the first double underscore after the server name', () => {
    expect(toolAsk('mcp__shortcut__stories__create')).toEqual({
      service: 'Shortcut',
      tool: 'stories__create',
      destructive: false,
    });
    expect(toolAsk('mcp__my__shortcut__epics-delete')).toBeNull();
  });

  it('leaves the tools of every other server and the agent’s own tools alone, and Notion keeps its lists', () => {
    for (const tool of ['mcp__sentry__update_issue', 'mcp__shortcut-notes__create', 'mcp__shortcutx__a', 'Bash']) {
      expect(toolAsk(tool), tool).toBeNull();
    }
    // The words of the Shortcut rule do not reach Notion: a name outside its lists asks as a delete, a listed read runs.
    expect(toolAsk('mcp__notion__notion-get-files')).toMatchObject({ destructive: true });
    expect(toolAsk('mcp__notion__notion-fetch')).toBeNull();
  });

  it('is never refused, and is not left out of the run’s tool list', () => {
    expect(toolRefusal('mcp__shortcut__epics-delete')).toBeNull();
    expect(toolRefusals().filter((rule) => rule.startsWith('mcp__shortcut__'))).toEqual([]);
  });

  it('tells the agent the rule in words, with no tool names', () => {
    const note = toolNote('shortcut');
    expect(note).toMatch(
      /delete, remove, archive, destroy in it deletes or archives and always asks.*every Access mode/,
    );
    expect(note).toMatch(
      /create, update, add.*changes things and asks the operator first, unless the Session has Full access/,
    );
    expect(note).toMatch(/get, search, list.*reads and runs/);
    expect(note).toMatch(/cannot place.*always asks/);
    expect(note).not.toContain('mcp__shortcut__stories');
  });

  it('summarises a call by the story, epic or iteration it acts on, in either id style', () => {
    const ask = { service: 'Shortcut', tool: 'stories-update', destructive: false };
    expect(askSummary(ask, { story_id: 1234, name: 'Fix the cart', description: 'long body' })).toBe(
      'stories-update, story_id 1234, "Fix the cart"',
    );
    expect(askSummary(ask, { storyPublicId: 1234, epicPublicId: 7, text: 'Looks good' })).toBe(
      'stories-update, storyPublicId 1234, epicPublicId 7, "Looks good"',
    );
    expect(askSummary(ask, { iteration_id: 9, comment: 'x'.repeat(5000) }).length).toBeLessThan(200);
  });
});

const RENDER_READS = [
  'list_workspaces',
  'get_selected_workspace',
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
];

const RENDER_WRITES = [
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
];

const RENDER_DESTRUCTIVE = ['trigger_deploy', 'update_environment_variables', 'approve_blueprint'];

describe('which tools belong to a server with classes', () => {
  it('names a tool of a classed server under any of its names, so a job can be refused it', () => {
    for (const tool of [
      'mcp__notion__notion-search',
      'mcp__claude_ai_Notion__notion-search',
      'mcp__plugin_notion_notion__notion-fetch',
      'mcp__Shortcut__stories-get-by-id',
      'mcp__claude_ai_Render__list_services',
      'mcp__figma__whoami',
      'mcp__figma-desktop__get_metadata',
    ]) {
      expect(isClassedTool(tool), tool).toBe(true);
    }
    for (const tool of ['mcp__sentry__get_issue', 'mcp__my__notion__x', 'Bash', 'mcp__github__list_issues']) {
      expect(isClassedTool(tool), tool).toBe(false);
    }
  });
});

/** The tools Shortcut's hosted server offers, as its MCP server listed them. */
const SHORTCUT_REAL = {
  read: `get_current_iterations get_doc get_epic get_file get_iteration get_member get_objective get_project get_story
    get_story_history get_team get_upcoming_iterations get_whoami get_workflow list_custom_fields list_docs
    list_epic_comment_replies list_epic_comments list_epic_stories list_epics list_iteration_stories list_iterations
    list_label_stories list_labels list_members list_objectives list_project_stories list_projects list_stories
    list_story_comments list_teams list_workflow_states list_workflows read_file search_docs search_epics
    search_iterations search_objectives search_stories`.split(/\s+/),
  write: `create_doc create_epic create_epic_comment create_iteration create_label create_story
    create_story_checklist_item create_story_comment create_story_link update_doc update_epic update_iteration
    update_story update_story_checklist_item`.split(/\s+/),
  destructive: ['delete_epic', 'delete_iteration', 'delete_workspace_token'],
  // A read of the workspace's tokens: it asks, since `tokens` is no noun the rule trusts.
  asksAsRead: ['list_workspace_tokens'],
};

describe('the tool classes of the Shortcut server against the names its hosted server offers', () => {
  it('runs every read, asks about every create and update, and always asks about every delete', () => {
    for (const tool of SHORTCUT_REAL.read) expect(toolAsk(`mcp__shortcut__${tool}`), tool).toBeNull();
    for (const tool of SHORTCUT_REAL.write) {
      expect(toolAsk(`mcp__shortcut__${tool}`), tool).toEqual({ service: 'Shortcut', tool, destructive: false });
    }
    for (const tool of SHORTCUT_REAL.destructive) {
      expect(toolAsk(`mcp__shortcut__${tool}`), tool).toEqual({ service: 'Shortcut', tool, destructive: true });
    }
  });

  it('asks about a read of the workspace tokens, as an unknown word', () => {
    for (const tool of SHORTCUT_REAL.asksAsRead) {
      expect(toolAsk(`mcp__shortcut__${tool}`), tool).toEqual({ service: 'Shortcut', tool, destructive: true });
    }
  });
});

describe('the tool classes of the Render server (ask, by lists)', () => {
  it('lets a read through, workflow reads and select_workspace included, and asks about nothing', () => {
    for (const tool of RENDER_READS) {
      expect(toolAsk(`mcp__render__${tool}`), tool).toBeNull();
      expect(toolRefusal(`mcp__render__${tool}`), tool).toBeNull();
    }
  });

  it('asks about a write, which full access skips, and treats SQL on a database as a write', () => {
    for (const tool of RENDER_WRITES) {
      expect(toolAsk(`mcp__render__${tool}`), tool).toEqual({ service: 'Render', tool, destructive: false });
      expect(toolRefusal(`mcp__render__${tool}`), tool).toBeNull();
    }
  });

  it('asks in every mode about a deploy, an environment change and a blueprint approval, and about any tool no list names', () => {
    for (const tool of [...RENDER_DESTRUCTIVE, 'delete_service', 'suspend_service', 'a_later_tool', 'x']) {
      expect(toolAsk(`mcp__render__${tool}`), tool).toEqual({ service: 'Render', tool, destructive: true });
    }
  });

  it('holds under the other names Render’s server can carry, whatever the case', () => {
    for (const server of ['Render', 'claude_ai_Render', 'plugin_render_render']) {
      expect(toolAsk(`mcp__${server}__list_services`), server).toBeNull();
      expect(toolAsk(`mcp__${server}__create_cron_job`), server).toMatchObject({ destructive: false });
      expect(toolAsk(`mcp__${server}__trigger_deploy`), server).toMatchObject({ destructive: true });
    }
    for (const tool of ['mcp__render-docs__trigger_deploy', 'mcp__renderer__trigger_deploy', 'Bash']) {
      expect(toolAsk(tool), tool).toBeNull();
    }
  });

  it('is never refused, and is not left out of the run’s tool list', () => {
    expect(toolRefusal('mcp__render__trigger_deploy')).toBeNull();
    expect(toolRefusals().filter((rule) => rule.startsWith('mcp__render__'))).toEqual([]);
  });

  it('tells the agent which tools read, which change things and ask, and which always ask', () => {
    const note = toolNote('render');
    for (const tool of [...RENDER_READS, ...RENDER_WRITES, ...RENDER_DESTRUCTIVE])
      expect(note).toContain(`mcp__render__${tool}`);
    expect(note).toMatch(/ask the operator first, unless the Session has Full access/);
    expect(note).toMatch(/always ask, in every Access mode/);
  });

  it('summarises an environment change by the variable names and never the values', () => {
    const ask = { service: 'Render', tool: 'update_environment_variables', destructive: true };
    const summary = askSummary(ask, {
      serviceId: 'srv-abc123',
      envVars: [
        { key: 'DATABASE_URL', value: 'postgres://u:marker-value-1@db.example.com/app' },
        { key: 'STRIPE_KEY', value: 'marker-value-2' },
      ],
    });
    expect(summary).toBe('update_environment_variables, serviceId srv-abc123, envVars DATABASE_URL, STRIPE_KEY');
    expect(summary).not.toContain('marker-value');
    // Any array of key and value pairs reads the same, whatever the other fields are called.
    expect(
      askSummary(ask, { variables: [{ key: 'A', value: 'marker-value-3', name: 'ignored-marker-name' }] }),
    ).not.toContain('marker-value-3');
    expect(askSummary(ask, { envVars: [{ key: 'A', value: 'marker-value-4' }], replace: true })).not.toContain(
      'marker-value-4',
    );
  });

  it('caps the variable names and the SQL, and redacts a secret in the SQL', () => {
    const ask = { service: 'Render', tool: 'query_render_postgres', destructive: false };
    const sql = askSummary(ask, { postgresId: 'dpg-1', sql: `SELECT * FROM users WHERE note = '${'x'.repeat(5000)}'` });
    expect(sql.startsWith('query_render_postgres, postgresId dpg-1, "SELECT * FROM users')).toBe(true);
    expect(sql.length).toBeLessThan(220);
    expect(sql).toContain('…');
    expect(askSummary(ask, { sql: 'SELECT 1 /* token=hunter2 */' })).not.toContain('hunter2');
    const many = Array.from({ length: 200 }, (_, index) => ({ key: `VARIABLE_${index}`, value: 'v' }));
    expect(askSummary({ ...ask, tool: 'update_environment_variables' }, { envVars: many }).length).toBeLessThan(220);
  });
});
