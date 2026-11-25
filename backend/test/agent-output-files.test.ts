import { link, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessMode } from '@ops-console/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutputFiles, runSaveFile } from '../src/agent/output-files';
import { SAVE_FILE_TOOL } from '../src/agent/pull-request-tool';
import { type AgentDaemon, api, converse, gate, startAgentDaemon, until } from './agent-fixtures';
import { tempDir } from './helpers';

const running: AgentDaemon[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
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
  it('gives a run its output folder: told to the agent', async () => {
    const ctx = await start();
    ctx.daemon.sdk.script({ text: 'ok' });
    await converse(ctx.daemon, ctx.id, 'make a pdf');
    const call = ctx.daemon.sdk.calls[0];
    expect(call?.options.additionalDirectories).toContain(ctx.folder);
    const prompt = JSON.stringify(call?.options.systemPrompt);
    expect(prompt).toContain(ctx.folder);
    expect(prompt).toContain(SAVE_FILE_TOOL);
    expect(Object.keys(call?.options.mcpServers ?? {})).toEqual(['ops-console']);
  });

  it('tells the agent which file types the Viewer draws', async () => {
    const ctx = await start();
    ctx.daemon.sdk.script({ text: 'ok' });
    await converse(ctx.daemon, ctx.id, 'chart the flow');
    const prompt = JSON.stringify(ctx.daemon.sdk.calls[0]?.options.systemPrompt);
    for (const extension of ['.csv', '.json', '.md', '.mmd', '.dot']) expect(prompt).toContain(extension);
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

  it('saves with no Approval in full access', async () => {
    const ctx = await start();
    await ctx.http.patch(`/sessions/${ctx.id}`, { access_mode: AccessMode.Full });
    const downloads = await tempDir('ops-console-downloads-');
    await mkdir(ctx.folder, { recursive: true });
    await writeFile(path.join(ctx.folder, 'flow.pdf'), 'pdf!');
    await ask(ctx, { name: 'flow.pdf', folder: downloads });
    await until(
      async () => (await ctx.http.get(`/sessions/${ctx.id}`)).body.data.state,
      (state) => state === 'idle',
      'the run to end',
    );
    expect((await ctx.http.get('/approvals')).body.data).toEqual([]);
    expect(ctx.daemon.sdk.ran.map((call) => call.tool)).toEqual([SAVE_FILE_TOOL]);
  });

  it('asks in every Access mode but full with the file, its size and the folder, and copies only on a yes', async () => {
    for (const mode of Object.values(AccessMode).filter((value) => value !== AccessMode.Full)) {
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

  describe('a folder', () => {
    async function project(ctx: Awaited<ReturnType<typeof start>>) {
      const dir = path.join(ctx.folder, 'sample-project');
      await mkdir(path.join(dir, 'css'), { recursive: true });
      await writeFile(path.join(dir, 'index.html'), '<h1>hi</h1>');
      await writeFile(path.join(dir, 'css', 'styles.css'), 'a{}');
      await writeFile(path.join(dir, '.gitignore'), 'x');
      return dir;
    }
    const refusal = (ctx: Awaited<ReturnType<typeof start>>, input: { name: string; folder: string }) =>
      ctx.daemon.app
        .get(OutputFiles)
        .describe(ctx.id, input)
        .then(
          () => 'asked',
          (e: Error) => e.message,
        );

    it('asks once for the whole folder, listing its files and total size, and copies the tree only on a yes', async () => {
      const ctx = await start();
      await project(ctx);
      const documents = await tempDir('ops-console-documents-');
      const hold = gate();
      await ctx.http.patch(`/sessions/${ctx.id}`, { access_mode: AccessMode.Supervised });
      ctx.daemon.sdk.script({
        tool: SAVE_FILE_TOOL,
        input: { name: 'sample-project', folder: documents },
        hold: hold.promise,
      });
      await ctx.http.post(`/sessions/${ctx.id}/messages`, { text: 'make sample-project in documents' });
      const [approval] = await approvals(ctx);
      expect(approval?.summary).toBe(
        `Save sample-project/ (3 files, 15 B) to ${path.resolve(documents)}${path.sep}\n.gitignore\ncss/styles.css\nindex.html`,
      );
      expect(await readdir(documents)).toEqual([]);
      await ctx.http.post(`/approvals/${approval?.id}/decision`, { decision: 'approved' });
      const answer = await runSaveFile(ctx.daemon.app.get(OutputFiles), ctx.id, {
        name: 'sample-project',
        folder: documents,
      });
      expect(answer.content[0]?.text).toBe(`Saved the file to ${path.join(path.resolve(documents), 'sample-project')}`);
      hold.open();
      const copy = path.join(documents, 'sample-project');
      expect(await readFile(path.join(copy, 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
      expect(await readFile(path.join(copy, 'css', 'styles.css'), 'utf8')).toBe('a{}');
      expect(await readFile(path.join(copy, '.gitignore'), 'utf8')).toBe('x');
      // The source stays in the output folder.
      expect(await readFile(path.join(ctx.folder, 'sample-project', 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
    });

    it('copies at once in full access', async () => {
      const ctx = await start();
      await ctx.http.patch(`/sessions/${ctx.id}`, { access_mode: AccessMode.Full });
      await project(ctx);
      const documents = await tempDir('ops-console-documents-');
      await ask(ctx, { name: 'sample-project', folder: documents });
      await until(
        async () => (await ctx.http.get(`/sessions/${ctx.id}`)).body.data.state,
        (state) => state === 'idle',
        'the run to end',
      );
      expect((await ctx.http.get('/approvals')).body.data).toEqual([]);
      expect(ctx.daemon.sdk.ran.map((call) => call.tool)).toEqual([SAVE_FILE_TOOL]);
    });

    it('refuses before it asks when the name is taken in the destination, and leaves what is there as it was', async () => {
      const ctx = await start();
      await project(ctx);
      const documents = await tempDir('ops-console-documents-');
      await mkdir(path.join(documents, 'sample-project'));
      await writeFile(path.join(documents, 'sample-project', 'index.html'), 'mine');
      const outputs = ctx.daemon.app.get(OutputFiles);
      expect(await refusal(ctx, { name: 'sample-project', folder: documents })).toMatch(/already/);
      const answer = await runSaveFile(outputs, ctx.id, { name: 'sample-project', folder: documents });
      expect(answer).toMatchObject({ isError: true });
      expect(await readFile(path.join(documents, 'sample-project', 'index.html'), 'utf8')).toBe('mine');
      expect(await readdir(path.join(documents, 'sample-project'))).toEqual(['index.html']);
    });

    it('refuses a tree with a link, a second hard link or no file, and copies nothing', async () => {
      const ctx = await start();
      const dir = await project(ctx);
      const documents = await tempDir('ops-console-documents-');
      const outputs = ctx.daemon.app.get(OutputFiles);
      await mkdir(path.join(ctx.folder, 'empty', 'sub'), { recursive: true });
      expect(await refusal(ctx, { name: 'empty', folder: documents })).toMatch(/no files/);
      const secret = path.join(ctx.daemon.dataDir, 'secret.txt');
      await writeFile(secret, 'token');
      await symlink(secret, path.join(dir, 'css', 'soft.txt'));
      expect(await refusal(ctx, { name: 'sample-project', folder: documents })).toMatch(/css\/soft.txt/);
      await rm(path.join(dir, 'css', 'soft.txt'));
      await link(secret, path.join(dir, 'hard.txt'));
      expect(await refusal(ctx, { name: 'sample-project', folder: documents })).toMatch(/hard.txt/);
      expect(await runSaveFile(outputs, ctx.id, { name: 'sample-project', folder: documents })).toMatchObject({
        isError: true,
      });
      expect(await readdir(documents)).toEqual([]);
    });

    it('refuses a folder that is a link, a dot name or a path, as for a file', async () => {
      const ctx = await start();
      await project(ctx);
      const documents = await tempDir('ops-console-documents-');
      await symlink(path.join(ctx.daemon.dataDir), path.join(ctx.folder, 'data-link'));
      await mkdir(path.join(ctx.folder, '.ssh'));
      await writeFile(path.join(ctx.folder, '.ssh', 'keys'), 'x');
      for (const name of ['data-link', '.ssh', 'sample-project/css', '../outputs'])
        expect(await refusal(ctx, { name, folder: documents })).toMatch(/No file/);
      expect(await readdir(documents)).toEqual([]);
    });

    it('copies nothing from a folder swapped for a link', async () => {
      const ctx = await start();
      const dir = await project(ctx);
      const documents = await tempDir('ops-console-documents-');
      const outputs = ctx.daemon.app.get(OutputFiles);
      const outside = await tempDir('ops-console-outside-');
      await writeFile(path.join(outside, 'styles.css'), 'secret');
      await rm(path.join(dir, 'css'), { recursive: true });
      await symlink(outside, path.join(dir, 'css'));
      const answer = await runSaveFile(outputs, ctx.id, { name: 'sample-project', folder: documents });
      expect(answer).toMatchObject({ isError: true });
      expect(await readdir(documents)).toEqual([]);
    });
  });

  describe('destinations that stay closed', () => {
    async function closed() {
      const ctx = await start();
      const home = await tempDir('ops-console-home-');
      vi.stubEnv('HOME', home);
      await mkdir(ctx.folder, { recursive: true });
      await writeFile(path.join(ctx.folder, 'a.txt'), 'x');
      await mkdir(path.join(ctx.folder, 'proj'));
      await writeFile(path.join(ctx.folder, 'proj', 'b.txt'), 'x');
      return { ctx, home, outputs: ctx.daemon.app.get(OutputFiles) };
    }
    const places = (home: string, dataDir: string) => [
      path.join(home, '.ssh'),
      path.join(home, '.gnupg'),
      path.join(home, '.aws'),
      path.join(home, 'Library', 'LaunchAgents'),
      path.join(home, 'Library', 'LaunchDaemons'),
      path.join(home, 'Library', 'Keychains'),
      path.join(home, 'Library', 'Application Support', 'ops-console'),
      dataDir,
    ];

    it('refuses each, and a folder inside it, in every Access mode, and copies nothing', async () => {
      const { ctx, home, outputs } = await closed();
      for (const root of places(home, ctx.daemon.dataDir)) {
        await mkdir(path.join(root, 'sub'), { recursive: true });
        const before = await readdir(root);
        for (const folder of [root, path.join(root, 'sub')])
          for (const name of ['a.txt', 'proj']) {
            const refused = await outputs.describe(ctx.id, { name, folder }).catch((e: Error) => e.message);
            expect(refused, folder).toMatch(/closed to saves.*Nothing was copied/s);
            const answer = await runSaveFile(outputs, ctx.id, { name, folder });
            expect(answer).toMatchObject({ isError: true });
            expect(await readdir(folder)).toEqual(folder === root ? before : []);
          }
      }
      for (const mode of Object.values(AccessMode)) {
        await ctx.http.patch(`/sessions/${ctx.id}`, { access_mode: mode });
        ctx.daemon.sdk.script({
          tool: SAVE_FILE_TOOL,
          input: { name: 'a.txt', folder: path.join(home, '.ssh') },
        });
        await ctx.http.post(`/sessions/${ctx.id}/messages`, { text: 'save it' });
        await until(
          async () => (await ctx.http.get(`/sessions/${ctx.id}`)).body.data.state,
          (state) => state === 'idle',
          'the run to end',
        );
        expect(await readdir(path.join(home, '.ssh'))).toEqual(['sub']);
      }
      expect((await ctx.http.get('/approvals')).body.data).toEqual([]);
    });

    it('refuses a link into one, and still allows a folder that only shares a name prefix', async () => {
      const { ctx, home, outputs } = await closed();
      await mkdir(path.join(home, '.ssh'));
      await symlink(path.join(home, '.ssh'), path.join(home, 'Documents'));
      const through = await outputs
        .describe(ctx.id, { name: 'a.txt', folder: path.join(home, 'Documents') })
        .catch((e: Error) => e.message);
      expect(through).toMatch(/closed to saves.*Nothing was copied/s);
      expect(await readdir(path.join(home, '.ssh'))).toEqual([]);
      await mkdir(path.join(home, '.ssh-notes'));
      await mkdir(`${ctx.daemon.dataDir}-copy`);
      for (const folder of [path.join(home, '.ssh-notes'), `${ctx.daemon.dataDir}-copy`])
        expect(await outputs.describe(ctx.id, { name: 'a.txt', folder })).toMatch(/^Save a.txt/);
    });

    it('refuses a name that starts with a dot, so a shell or git startup file is never written', async () => {
      const { ctx, outputs } = await closed();
      const documents = await tempDir('ops-console-documents-');
      for (const name of ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile', '.gitconfig']) {
        await writeFile(path.join(ctx.folder, name), 'x');
        expect(await outputs.describe(ctx.id, { name, folder: documents }).catch((e: Error) => e.message)).toMatch(
          /No file/,
        );
      }
      expect(await readdir(documents)).toEqual([]);
    });
  });

  it('says on the card that a file of the same name in the folder is replaced', async () => {
    const ctx = await start();
    const downloads = await tempDir('ops-console-downloads-');
    await mkdir(ctx.folder, { recursive: true });
    await writeFile(path.join(ctx.folder, 'a.txt'), 'new');
    const outputs = ctx.daemon.app.get(OutputFiles);
    expect(await outputs.describe(ctx.id, { name: 'a.txt', folder: downloads })).not.toMatch(/replaces/);
    await writeFile(path.join(downloads, 'a.txt'), 'old');
    expect(await outputs.describe(ctx.id, { name: 'a.txt', folder: downloads })).toMatch(/replaces the file/);
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
