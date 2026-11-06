import { link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessMode } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { OutputFiles, runSaveFile } from '../src/agent/output-files';
import { SAVE_FILE_TOOL } from '../src/agent/pull-request-tool';
import { type AgentDaemon, api, converse, gate, startAgentDaemon, until } from './agent-fixtures';
import { tempDir } from './helpers';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

async function start() {
  const daemon = await startAgentDaemon();
  running.push(daemon);
  const id = daemon.createSession();
  const folder = path.join(daemon.dataDir, 'outputs', id);
  return { daemon, http: api(daemon), id, folder };
}

describe('Output files (agent-output-files)', () => {
  it('gives a run its output folder: told to the agent, writable and readable in the sandbox', async () => {
    const ctx = await start();
    ctx.daemon.sdk.script({ text: 'ok' });
    await converse(ctx.daemon, ctx.id, 'make a pdf');
    const call = ctx.daemon.sdk.calls[0];
    expect(call?.options.sandbox?.filesystem?.allowWrite).toContain(ctx.folder);
    expect(call?.options.sandbox?.filesystem?.allowRead).toContain(ctx.folder);
    expect(call?.options.additionalDirectories).toContain(ctx.folder);
    const prompt = JSON.stringify(call?.options.systemPrompt);
    expect(prompt).toContain(ctx.folder);
    expect(prompt).toContain(SAVE_FILE_TOOL);
    expect(Object.keys(call?.options.mcpServers ?? {})).toEqual(['ops-console']);
  });

  it('lists plain files A to Z and leaves out subfolders, symlinks and dot files', async () => {
    const ctx = await start();
    expect((await ctx.http.get(`/sessions/${ctx.id}/outputs`)).body.data).toEqual([]);
    await mkdir(path.join(ctx.folder, 'sub'), { recursive: true });
    await writeFile(path.join(ctx.folder, 'b.pdf'), 'pdf');
    await writeFile(path.join(ctx.folder, 'a.xlsx'), 'sheet!');
    await writeFile(path.join(ctx.folder, '.hidden'), 'x');
    await writeFile(path.join(ctx.folder, 'sub', 'deep.txt'), 'x');
    await symlink(path.join(ctx.daemon.dataDir, 'runtime.json'), path.join(ctx.folder, 'link.txt'));
    const listed = (await ctx.http.get(`/sessions/${ctx.id}/outputs`)).body.data as { name: string; size: number }[];
    expect(listed.map(({ name, size }) => [name, size])).toEqual([
      ['a.xlsx', 6],
      ['b.pdf', 3],
    ]);
  });

  it('serves a file with the viewer’s type: PDF as itself, HTML and SVG as a download type', async () => {
    const ctx = await start();
    await mkdir(ctx.folder, { recursive: true });
    await writeFile(path.join(ctx.folder, 'a.pdf'), 'pdf');
    await writeFile(path.join(ctx.folder, 'page.html'), '<script>alert(1)</script>');
    await writeFile(path.join(ctx.folder, 'pic.svg'), '<svg onload="alert(1)"/>');
    const pdf = await ctx.http.get(`/sessions/${ctx.id}/outputs/a.pdf`);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.toString()).toBe('pdf');
    for (const name of ['page.html', 'pic.svg'])
      expect((await ctx.http.get(`/sessions/${ctx.id}/outputs/${name}`)).headers['content-type']).toContain(
        'application/octet-stream',
      );
  });

  it('serves nothing outside the folder: a path, a symlink, a dot file, a missing file, another Session', async () => {
    const ctx = await start();
    const other = ctx.daemon.createSession();
    await mkdir(ctx.folder, { recursive: true });
    await writeFile(path.join(ctx.folder, 'a.txt'), 'mine');
    await writeFile(path.join(ctx.folder, '.hidden'), 'x');
    await symlink(path.join(ctx.daemon.dataDir, 'runtime.json'), path.join(ctx.folder, 'link.txt'));
    for (const name of ['..%2F..%2Fruntime.json', 'link.txt', '.hidden', 'nope.txt'])
      expect((await ctx.http.get(`/sessions/${ctx.id}/outputs/${name}`)).status).toBe(404);
    expect((await ctx.http.get(`/sessions/${other}/outputs/a.txt`)).status).toBe(404);
    expect((await ctx.http.get('/sessions/nope/outputs')).status).toBe(404);
  });

  it('deletes the folder with the Session', async () => {
    const ctx = await start();
    ctx.daemon.sdk.script({ text: 'ok' });
    await converse(ctx.daemon, ctx.id, 'hi');
    await writeFile(path.join(ctx.folder, 'a.txt'), 'x');
    expect((await ctx.http.delete(`/sessions/${ctx.id}`)).status).toBe(204);
    await expect(readFile(path.join(ctx.folder, 'a.txt'))).rejects.toThrow();
  });
});

describe('save_file', () => {
  const approvals = (ctx: Awaited<ReturnType<typeof start>>) =>
    until(
      async () => (await ctx.http.get('/approvals?status=pending')).body.data as { id: string; summary: string }[],
      (list) => list.length === 1,
      'an Approval',
    );

  async function ask(
    ctx: Awaited<ReturnType<typeof start>>,
    input: { name: string; folder: string },
    hold?: Promise<void>,
  ) {
    await mkdir(ctx.folder, { recursive: true });
    ctx.daemon.sdk.script({ tool: SAVE_FILE_TOOL, input, ...(hold ? { hold } : {}) });
    await ctx.http.post(`/sessions/${ctx.id}/messages`, { text: 'put it in downloads' });
  }

  it('asks in every Access mode with the file, its size and the folder, and copies only on a yes', async () => {
    for (const mode of Object.values(AccessMode)) {
      const ctx = await start();
      await ctx.http.patch(`/sessions/${ctx.id}`, { access_mode: mode });
      const downloads = await tempDir('ops-console-downloads-');
      await mkdir(ctx.folder, { recursive: true });
      await writeFile(path.join(ctx.folder, 'flow.pdf'), 'pdf!');
      const hold = gate();
      await ask(ctx, { name: 'flow.pdf', folder: downloads }, hold.promise);
      const [approval] = await approvals(ctx);
      expect(approval?.summary).toBe(`Save flow.pdf (4 B) to ${path.resolve(downloads)}${path.sep}`);
      await ctx.http.post(`/approvals/${approval?.id}/decision`, { decision: 'approved' });
      // The tool runs in the daemon; the fake SDK does not run it, so the test calls it as the tool would.
      const answer = await runSaveFile(ctx.daemon.app.get(OutputFiles), ctx.id, {
        name: 'flow.pdf',
        folder: downloads,
      });
      expect(answer.content[0]?.text).toBe(`Saved the file to ${path.join(path.resolve(downloads), 'flow.pdf')}`);
      hold.open();
      expect(await readFile(path.join(downloads, 'flow.pdf'), 'utf8')).toBe('pdf!');
      // The output file stays, so its chip still opens.
      expect((await ctx.http.get(`/sessions/${ctx.id}/outputs/flow.pdf`)).status).toBe(200);
    }
  });

  it('copies nothing on a no, and tells the agent not to retry', async () => {
    const ctx = await start();
    const downloads = await tempDir('ops-console-downloads-');
    await mkdir(ctx.folder, { recursive: true });
    await writeFile(path.join(ctx.folder, 'flow.pdf'), 'pdf');
    await ask(ctx, { name: 'flow.pdf', folder: downloads });
    const [approval] = await approvals(ctx);
    await ctx.http.post(`/approvals/${approval?.id}/decision`, { decision: 'denied' });
    await until(
      async () => (await ctx.http.get(`/sessions/${ctx.id}`)).body.data.state,
      (state) => state === 'idle',
      'the run to end',
    );
    await expect(readFile(path.join(downloads, 'flow.pdf'))).rejects.toThrow();
  });

  it('refuses before it asks: a file not in the output folder, a path for a name, a missing or relative folder', async () => {
    const ctx = await start();
    const downloads = await tempDir('ops-console-downloads-');
    await mkdir(ctx.folder, { recursive: true });
    await writeFile(path.join(ctx.folder, 'a.txt'), 'x');
    await writeFile(path.join(downloads, 'elsewhere.txt'), 'x');
    const outputs = ctx.daemon.app.get(OutputFiles);
    const refused = (input: { name: string; folder: string }) =>
      outputs.describe(ctx.id, input).catch((e: Error) => e.message);
    expect(await refused({ name: 'nope.txt', folder: downloads })).toMatch(/No file nope.txt/);
    expect(await refused({ name: path.join(downloads, 'elsewhere.txt'), folder: downloads })).toMatch(/No file/);
    expect(await refused({ name: '../a.txt', folder: downloads })).toMatch(/No file/);
    expect(await refused({ name: 'a.txt', folder: path.join(downloads, 'missing') })).toMatch(/No folder/);
    expect(await refused({ name: 'a.txt', folder: downloads })).toMatch(/^Save a.txt/);
    expect(await refused({ name: 'a.txt', folder: 'relative/dir' })).toMatch(/absolute/);
    expect((await ctx.http.get('/approvals?status=pending')).body.data).toEqual([]);
  });

  it('answers the agent with why, and writes nothing, for a folder that is a file or a link in the way', async () => {
    const ctx = await start();
    const downloads = await tempDir('ops-console-downloads-');
    await mkdir(ctx.folder, { recursive: true });
    await writeFile(path.join(ctx.folder, 'a.txt'), 'new');
    await writeFile(path.join(downloads, 'plain'), 'x');
    const outputs = ctx.daemon.app.get(OutputFiles);
    const asFolder = await runSaveFile(outputs, ctx.id, { name: 'a.txt', folder: path.join(downloads, 'plain') });
    expect(asFolder).toMatchObject({ isError: true });
    expect(asFolder.content[0]?.text).toMatch(/No folder/);
    // A link already at the destination is not followed.
    await symlink(path.join(ctx.daemon.dataDir, 'runtime.json'), path.join(downloads, 'a.txt'));
    expect(await runSaveFile(outputs, ctx.id, { name: 'a.txt', folder: downloads })).toMatchObject({ isError: true });
    // A file of the same name is replaced, and `~/` means the home folder.
    await writeFile(path.join(downloads, 'b.txt'), 'old');
    await writeFile(path.join(ctx.folder, 'b.txt'), 'new');
    await runSaveFile(outputs, ctx.id, { name: 'b.txt', folder: downloads });
    expect(await readFile(path.join(downloads, 'b.txt'), 'utf8')).toBe('new');
    expect(await outputs.describe(ctx.id, { name: 'b.txt', folder: '~/' })).toMatch(/^Save b.txt \(3 B\) to \//);
  });

  it('never serves a file swapped for a link or sharing a hard link with a hidden file', async () => {
    const ctx = await start();
    await mkdir(ctx.folder, { recursive: true });
    const secret = path.join(ctx.daemon.dataDir, 'secret.txt');
    await writeFile(secret, 'token');
    await link(secret, path.join(ctx.folder, 'hard.txt'));
    expect((await ctx.http.get(`/sessions/${ctx.id}/outputs/hard.txt`)).status).toBe(404);
    expect((await ctx.http.get(`/sessions/${ctx.id}/outputs`)).body.data).toEqual([]);
  });
});
