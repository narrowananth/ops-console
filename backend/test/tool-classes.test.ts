import { describe, expect, it } from 'vitest';
import { askSummary, toolAsk, toolNote, toolRefusal, toolRefusals } from '../src/agent/tool-classes';

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
    ).toBe('notion-update-page, page_id 1f3a-9, "Release notes"');
    const long = askSummary(ask, { page_id: 'p', content: 'x'.repeat(5000) });
    expect(long.length).toBeLessThan(200);
    expect(long).toContain('…');
    expect(askSummary(ask, { page_id: 'p', content: 'use token=hunter2 for it' })).not.toContain('hunter2');
    expect(askSummary(ask, {})).toBe('notion-update-page');
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
