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
