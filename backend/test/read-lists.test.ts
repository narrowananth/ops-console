import { describe, expect, it } from 'vitest';
import { readListDenial, readListNote, readListRefusals } from '../src/agent/read-lists';

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
  'generate_diagram',
  'generate_image',
  'generate_vector_illustration',
  'create_generative_plugin',
  'update_generative_plugin',
  'create_shader',
  'update_shader',
];

describe('the Read list of the Figma server', () => {
  it('lets each of the twenty read tools through', () => {
    for (const tool of FIGMA_READS) expect(readListDenial(`mcp__figma__${tool}`), tool).toBeNull();
  });

  it('refuses every write tool, and one Figma adds later, saying Figma is read only and nothing changed', () => {
    for (const tool of [...FIGMA_WRITES, 'a_tool_a_later_version_adds']) {
      expect(readListDenial(`mcp__figma__${tool}`), tool).toMatch(/Figma is read only here.*nothing was changed/i);
    }
  });

  it('leaves the tools of every other server and the agent’s own tools alone', () => {
    for (const tool of ['mcp__sentry__update_issue', 'mcp__figma-notes__get_notes', 'Bash', 'Edit']) {
      expect(readListDenial(tool), tool).toBeNull();
    }
  });

  it('holds under the other names Figma’s server can carry, whatever the case', () => {
    for (const server of ['Figma', 'figma-desktop', 'claude_ai_Figma', 'plugin_figma_figma']) {
      expect(readListDenial(`mcp__${server}__use_figma`), server).toMatch(/Figma is read only here/);
      expect(readListDenial(`mcp__${server}__get_design_context`), server).toBeNull();
    }
  });

  it('reads the server and the tool apart at the first double underscore after the server name', () => {
    // `figma` then `a__b`: a tool with a double underscore is still a tool of Figma and is not on the list.
    expect(readListDenial('mcp__figma__a__b')).toMatch(/read only/);
    // The server `my`, whose tool is `figma__use_figma`: another server, left alone.
    expect(readListDenial('mcp__my__figma__use_figma')).toBeNull();
  });

  it('names the known write tools for the run to leave out of its tool list', () => {
    expect(readListRefusals()).toEqual(FIGMA_WRITES.map((tool) => `mcp__figma__${tool}`));
  });

  it('tells the agent Figma is read only and lists its tools', () => {
    const note = readListNote('figma');
    expect(note).toMatch(/Figma is read only here/);
    for (const tool of FIGMA_READS) expect(note).toContain(`mcp__figma__${tool}`);
  });
});
