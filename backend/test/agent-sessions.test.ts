import { readdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { AccessMode, Effort, SessionKind, splitAttachments, withAttachments } from '@ops-console/shared';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime';
import { type AgentDaemon, api, converse, gate, listen, startAgentDaemon, until, WORKING_DIR } from './agent-fixtures';

const running: AgentDaemon[] = [];
async function start(options: Parameters<typeof startAgentDaemon>[0] = {}) {
  const daemon = await startAgentDaemon(options);
  running.push(daemon);
  return daemon;
}

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

describe('Session creation', () => {
  it('takes model, effort and access mode from session_defaults unless the creator passes them', async () => {
    const daemon = await start();
    const plain = await api(daemon).get(`/sessions/${daemon.createSession()}`);
    expect(plain.body.data).toMatchObject({
      title: 'New session',
      state: 'idle',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      access_mode: 'supervised',
      account_id: null,
    });

    await api(daemon).patch('/settings', {
      session_defaults: { model: 'claude-opus-5-5', effort: 'max', access_mode: 'auto' },
    });
    const changed = await api(daemon).get(`/sessions/${daemon.createSession({ effort: Effort.Low })}`);
    expect(changed.body.data).toMatchObject({ model: 'claude-opus-5-5', effort: 'low', access_mode: 'auto' });
  });
});

describe('runs', () => {
  it('runs the first message under the active account and names the Session for its task', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const long = `Why does POST /fb/webhook return 500 for every order placed after midnight UTC?\nMore detail.`;
    const session = await converse(daemon, id, long);

    expect(session).toMatchObject({
      title: 'Why does POST /fb/webhook return 500 for every…',
      state: 'idle',
      last_message_preview: 'Done.',
      last_error: null,
    });
    const accounts = await api(daemon).get('/agent-accounts');
    expect(session.account_id).toBe(accounts.body.meta.active_account_id);
    expect(daemon.sdk.calls[0]).toMatchObject({ prompt: long, configDir: daemon.home });
    expect(daemon.sdk.calls[0]?.options).toMatchObject({
      cwd: WORKING_DIR,
      model: 'claude-sonnet-5-5',
      effort: 'high',
    });
  });

  it("takes Claude Code's name for the task after the first run; an operator's rename and a later name stay", async () => {
    const daemon = await start();
    const id = daemon.createSession();
    daemon.sdk.script({ aiTitle: 'Hermes Atlas stores API response' }, { text: 'Done.' });
    await converse(daemon, id, "curl --url 'https://hermes.example.com/api/v1/stores' -H 'accept: */*'");
    const named = await until(
      async () => (await api(daemon).get(`/sessions/${id}`)).body.data.title,
      (title) => title === 'Hermes Atlas stores API response',
      'the title from the transcript',
    );
    expect(named).toBe('Hermes Atlas stores API response');

    daemon.sdk.script({ aiTitle: 'Something else' }, { text: 'Done.' });
    await converse(daemon, id, 'and the reviews route?');
    expect((await api(daemon).get(`/sessions/${id}`)).body.data.title).toBe('Hermes Atlas stores API response');

    // The operator renames the Session while its first run goes: Claude Code's name does not replace theirs.
    const renamed = daemon.createSession();
    const held = gate();
    daemon.sdk.script({ wait: held.promise }, { aiTitle: 'Cart totals' }, { text: 'Done.' });
    const { events, close } = await listen(daemon);
    expect((await api(daemon).post(`/sessions/${renamed}/messages`, { text: 'look at the cart' })).status).toBe(202);
    expect((await api(daemon).patch(`/sessions/${renamed}`, { title: 'Cart check' })).status).toBe(200);
    held.open();
    await until(async () => events.some((e) => e.event === 'session.finished'), Boolean, 'the run to end');
    close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await api(daemon).get(`/sessions/${renamed}`)).body.data.title).toBe('Cart check');
  });

  it('waits for its MCP servers to connect before the first turn', async () => {
    const daemon = await start();
    await converse(daemon, daemon.createSession(), 'read /apps/1 from example-dev');
    expect(daemon.sdk.calls[0]?.options.env).toMatchObject({ CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '30000' });
  });

  it('resumes the same SDK session for later messages', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    await converse(daemon, id, 'first');
    await converse(daemon, id, 'second');

    expect(daemon.sdk.calls[1]?.options.resume).toBe(daemon.sdk.calls[0]?.sessionId);
    const messages = await api(daemon).get(`/sessions/${id}/messages`);
    expect(messages.body.data.map((message: { role: string }) => message.role)).toEqual([
      'user',
      'agent',
      'user',
      'agent',
    ]);
  });

  it('lists messages from the transcript, with tool calls, edits, code and questions as parts', async () => {
    const daemon = await start();
    const id = daemon.createSession({ access_mode: AccessMode.Full });
    daemon.sdk.script(
      { text: 'Checking the handler.\n```ts\nconst total = order.total;\n```\nThat is the bug.' },
      { tool: 'Read', input: { file_path: 'src/webhook.ts' } },
      { tool: 'Edit', input: { file_path: 'src/webhook.ts', old_string: 'a\nb', new_string: 'c' } },
      { tool: 'Bash', input: { command: 'pnpm test' } },
    );
    await converse(daemon, id, 'Fix the webhook');

    const messages = await api(daemon).get(`/sessions/${id}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body.data).toEqual([
      {
        id: expect.any(String),
        role: 'user',
        status: 'done',
        parts: [{ kind: 'text', text: 'Fix the webhook' }],
        created_at: expect.any(String),
        skill: null,
      },
      {
        id: expect.any(String),
        role: 'agent',
        status: 'done',
        created_at: expect.any(String),
        parts: [
          { kind: 'text', text: 'Checking the handler.' },
          { kind: 'code', lang: 'ts', text: 'const total = order.total;' },
          { kind: 'text', text: 'That is the bug.' },
          { kind: 'step', text: 'Read src/webhook.ts' },
          {
            kind: 'diff',
            file: 'src/webhook.ts',
            lines: [
              { sign: '-', text: 'a' },
              { sign: '-', text: 'b' },
              { sign: '+', text: 'c' },
            ],
          },
          { kind: 'step', text: '$ pnpm test' },
        ],
      },
    ]);
  });

  it('streams parts, resending a growing part whole, and serves the in-flight message after a reload', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const hold = gate();
    daemon.sdk.script({ text: 'Looking at the logs.' }, { wait: hold.promise }, { text: 'Found it.' });
    const { events, close } = await listen(daemon);

    const sent = await api(daemon).post(`/sessions/${id}/messages`, { text: 'Look' });
    const messageId = sent.body.data.message_id;
    const outputs = () => events.flatMap((event) => (event.event === 'session.output' ? [event.data] : []));
    await until(
      () => outputs().length,
      (count) => count >= 3,
    );

    // Two stream deltas grow part 0; the finished block resends it whole.
    expect(outputs().map((output) => [output.message_id, output.part_index, output.part])).toEqual([
      [messageId, 0, { kind: 'text', text: 'Looking at' }],
      [messageId, 0, { kind: 'text', text: 'Looking at the logs.' }],
      [messageId, 0, { kind: 'text', text: 'Looking at the logs.' }],
    ]);

    // A reload mid-run: the list holds the in-flight message, and output continues from the next index.
    const midRun = await api(daemon).get(`/sessions/${id}/messages`);
    expect(midRun.body.data.at(-1)).toMatchObject({
      id: messageId,
      role: 'agent',
      status: 'streaming',
      parts: [{ kind: 'text', text: 'Looking at the logs.' }],
    });
    expect(midRun.body.data.filter((message: { role: string }) => message.role === 'agent')).toHaveLength(1);

    hold.open();
    await until(() => events.some((event) => event.event === 'session.finished'), Boolean);
    expect(outputs().at(-1)).toEqual({
      session_id: id,
      message_id: messageId,
      part_index: 1,
      part: { kind: 'text', text: 'Found it.' },
    });
    expect(events.find((event) => event.event === 'session.finished')?.data).toEqual({
      session_id: id,
      message_id: messageId,
      status: 'done',
      state: 'idle',
      error_code: null,
      started_by: 'operator',
    });
    close();
  });

  it('refuses a message while the run goes, and runs other Sessions side by side', async () => {
    const daemon = await start();
    const first = daemon.createSession();
    const second = daemon.createSession();
    const hold = gate();
    daemon.sdk.script({ wait: hold.promise });
    await api(daemon).post(`/sessions/${first}/messages`, { text: 'one' });

    const busy = await api(daemon).post(`/sessions/${first}/messages`, { text: 'again' });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('session_busy');

    expect((await converse(daemon, second, 'two')).state).toBe('idle');
    hold.open();
    expect((await converse(daemon, first, 'three')).state).toBe('idle');
  });

  it('refuses messages to a kind that takes none', async () => {
    const daemon = await start();
    const id = daemon.createSession({ kind: SessionKind.PrReview });
    const sent = await api(daemon).post(`/sessions/${id}/messages`, { text: 'hello' });
    expect(sent.status).toBe(409);
    expect(sent.body.error.code).toBe('invalid_state');
  });

  it('ends failed when the run errors', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const { events, close } = await listen(daemon);
    daemon.sdk.script({ text: 'Starting.' }, { crash: 'Claude Code process exited with code 1' });

    expect((await converse(daemon, id, 'go')).state).toBe('failed');
    await until(() => events.find((event) => event.event === 'session.finished'), Boolean);
    expect(events.find((event) => event.event === 'session.finished')?.data).toMatchObject({
      status: 'failed',
      state: 'failed',
      error_code: 'upstream_failed',
    });
    close();
  });

  it('lists nothing for a transcript deleted outside the console, and starts a new SDK session next', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    await converse(daemon, id, 'first');
    await rm(path.join(daemon.home, 'projects'), { recursive: true });

    expect((await api(daemon).get(`/sessions/${id}/messages`)).body.data).toEqual([]);
    await converse(daemon, id, 'again');
    expect(daemon.sdk.calls[1]?.options.resume).toBeUndefined();
    expect((await api(daemon).get(`/sessions/${id}/messages`)).body.data).toHaveLength(2);
  });

  it('applies a changed model, effort and access mode from the next run', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    await converse(daemon, id, 'first');
    const patched = await api(daemon).patch(`/sessions/${id}`, {
      model: 'claude-haiku-5-5',
      effort: 'ultrathink',
      access_mode: 'full',
    });
    expect(patched.body.data).toMatchObject({ model: 'claude-haiku-5-5', effort: 'ultrathink', access_mode: 'full' });

    await converse(daemon, id, 'second');
    expect(daemon.sdk.calls[1]?.options).toMatchObject({
      model: 'claude-haiku-5-5',
      effort: 'max',
      permissionMode: 'bypassPermissions',
    });
  });

  it('lists Sessions newest first, by kind and title', async () => {
    const daemon = await start();
    const older = daemon.createSession();
    const newer = daemon.createSession();
    await converse(daemon, older, 'Webhook 500s');
    await converse(daemon, newer, 'Slow checkout');
    const review = daemon.createSession({ kind: SessionKind.PrReview });

    const all = await api(daemon).get('/sessions');
    expect(all.body.data.map((session: { id: string }) => session.id)).toEqual([review, newer, older]);
    const repo = await api(daemon).get('/sessions?kind=repo&q=webhook');
    expect(repo.body.data.map((session: { id: string }) => session.id)).toEqual([older]);
  });
});

describe('attachments', () => {
  it('saves a file in the data folder, and the message naming it lets the agent read that folder', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const saved = await request(daemon.url)
      .post(`/api/sessions/${id}/attachments?name=${encodeURIComponent('../shot one.png')}`)
      .set(daemon.auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('png bytes'));
    expect(saved.status).toBe(201);
    const folder = path.join(daemon.dataDir, 'attachments', id);
    expect(saved.body.data).toMatchObject({ name: 'shot one.png', size: 9 });
    expect(path.dirname(saved.body.data.path)).toBe(folder);
    expect(await readFile(saved.body.data.path, 'utf8')).toBe('png bytes');

    const text = withAttachments('why does this page break?', [saved.body.data]);
    await converse(daemon, id, text);
    expect(daemon.sdk.calls[0]).toMatchObject({ prompt: text });
    expect(daemon.sdk.calls[0]?.options.additionalDirectories).toEqual([
      folder,
      path.join(daemon.dataDir, 'outputs', id),
    ]);
    const messages = await api(daemon).get(`/sessions/${id}/messages`);
    expect(splitAttachments(messages.body.data[0].parts[0].text)).toEqual({
      text: 'why does this page break?',
      attachments: [{ name: 'shot one.png', path: saved.body.data.path }],
    });

    const missing = await request(daemon.url)
      .post('/api/sessions/nope/attachments?name=a.txt')
      .set(daemon.auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));
    expect(missing.status).toBe(404);
  });

  it('serves a saved file back for the console to open, and nothing outside the Session folder', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const saved = await request(daemon.url)
      .post(`/api/sessions/${id}/attachments?name=shot.png`)
      .set(daemon.auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('png bytes'));
    const file = path.basename(saved.body.data.path);
    const read = await request(daemon.url)
      .get(`/api/sessions/${id}/attachments/${file}`)
      .set(daemon.auth)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(read.status).toBe(200);
    expect(read.headers['content-type']).toBe('image/png');
    expect(read.body.toString()).toBe('png bytes');
    const outside = await request(daemon.url)
      .get(`/api/sessions/${id}/attachments/${encodeURIComponent('../../daemon.json')}`)
      .set(daemon.auth);
    expect(outside.status).toBe(404);
    expect((await request(daemon.url).get(`/api/sessions/${id}/attachments/${file}`)).status).toBe(401);
  });
});

describe('deleting a Session', () => {
  it('is refused while its run goes, then removes the row and keeps the transcript and Action Log', async () => {
    const daemon = await start();
    const id = daemon.createSession({ access_mode: AccessMode.Full });
    const hold = gate();
    daemon.sdk.script({ tool: 'Bash', input: { command: 'git status' } }, { wait: hold.promise });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'status' });
    await until(
      async () => (await api(daemon).get('/action-log')).body.data.length,
      (count) => count === 1,
    );

    const busy = await api(daemon).delete(`/sessions/${id}`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('session_busy');

    hold.open();
    await until(
      async () => (await api(daemon).get(`/sessions/${id}`)).body.data.state,
      (state) => state === 'idle',
    );
    expect((await api(daemon).delete(`/sessions/${id}`)).status).toBe(204);
    expect((await api(daemon).get(`/sessions/${id}`)).status).toBe(404);
    const log = await api(daemon).get('/action-log');
    expect(log.body.data).toEqual([
      expect.objectContaining({ session_id: null, command: 'git status', outcome: 'ok' }),
    ]);
    const transcripts = await readdir(path.join(daemon.home, 'projects'), { recursive: true });
    expect(transcripts.some((file) => file.endsWith('.jsonl'))).toBe(true);
  });
});

describe('editing the last message', () => {
  type Said = { id: string; role: string; parts: { kind: string; text?: string }[] };
  const said = async (daemon: AgentDaemon, id: string) =>
    ((await api(daemon).get(`/sessions/${id}/messages`)).body.data as Said[]).map((message) => ({
      id: message.id,
      role: message.role,
      text: message.parts.map((part) => part.text ?? '').join(''),
    }));
  const edit = (daemon: AgentDaemon, id: string, messageId: string, text: string) =>
    api(daemon).post(`/sessions/${id}/messages/${messageId}/edit`, { text });
  const settled = (daemon: AgentDaemon, id: string) =>
    until(
      async () => (await api(daemon).get(`/sessions/${id}`)).body.data.state,
      (state) => state === 'idle' || state === 'failed',
      'the run to end',
    );

  it('puts the files back, drops the old turn and runs the new text from just before it', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    await converse(daemon, id, 'first');
    daemon.sdk.script({ text: 'Changed src/a.ts.' });
    await converse(daemon, id, 'second');
    const before = await said(daemon, id);
    const last = before.filter((message) => message.role === 'user').at(-1);
    const sdkSessionId = daemon.sdk.calls[1]?.sessionId;

    daemon.sdk.rewindResult = {
      canRewind: true,
      filesChanged: [path.join(await realpath(WORKING_DIR), 'src/a.ts')],
      insertions: 2,
      deletions: 1,
    };
    daemon.sdk.script({ text: 'Did the edited thing.' });
    const edited = await edit(daemon, id, last?.id ?? '', 'second, edited');
    expect(edited.status).toBe(202);
    expect(edited.body.data).toEqual({
      message_id: expect.any(String),
      reverted: { files: ['src/a.ts'], insertions: 2, deletions: 1 },
      revert_error: null,
    });
    expect(daemon.sdk.rewinds).toEqual([
      {
        userMessageId: last?.id,
        options: expect.objectContaining({ resume: sdkSessionId, enableFileCheckpointing: true }),
      },
    ]);
    expect(await settled(daemon, id)).toBe('idle');

    expect((await said(daemon, id)).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'first' },
      { role: 'agent', text: 'Done.' },
      { role: 'user', text: 'second, edited' },
      { role: 'agent', text: 'Did the edited thing.' },
    ]);
    expect(daemon.sdk.calls[2]?.options).toMatchObject({
      resume: sdkSessionId,
      resumeSessionAt: before[1]?.id,
      enableFileCheckpointing: true,
    });
  });

  it('still runs the new text when the files cannot go back, and says why', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    await converse(daemon, id, 'only');
    const [first] = await said(daemon, id);

    daemon.sdk.rewindResult = { canRewind: false, error: 'No file checkpoint found for this message.' };
    const edited = await edit(daemon, id, first?.id ?? '', 'only, edited');
    expect(edited.body.data).toMatchObject({
      reverted: null,
      revert_error: 'No file checkpoint found for this message.',
    });
    await settled(daemon, id);
    // The first message has nothing before it, so the conversation starts over.
    expect(daemon.sdk.calls[1]?.options.resume).toBeUndefined();
    expect((await said(daemon, id)).map(({ text }) => text)).toEqual(['only, edited', 'Done.']);
  });

  it('is refused for any message but the last, and while a run goes', async () => {
    const daemon = await start();
    const id = daemon.createSession({ access_mode: AccessMode.Full });
    await converse(daemon, id, 'first');
    await converse(daemon, id, 'second');
    const [first] = await said(daemon, id);
    const old = await edit(daemon, id, first?.id ?? '', 'again');
    expect(old.status).toBe(409);
    expect(old.body.error).toMatchObject({ code: 'invalid_state', message: 'only the last message can be edited' });

    const hold = gate();
    daemon.sdk.script({ wait: hold.promise });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'third' });
    const busy = await edit(daemon, id, first?.id ?? '', 'again');
    expect(busy.body.error.code).toBe('session_busy');
    hold.open();
    await settled(daemon, id);
    expect(daemon.sdk.rewinds).toEqual([]);
  });
});

describe('stopping a run', () => {
  const stateOf = (daemon: AgentDaemon, id: string, state: string) =>
    until(
      async () => (await api(daemon).get(`/sessions/${id}`)).body.data.state,
      (value) => value === state,
      state,
    );

  it('ends a working run, sets the Session idle, and lets it be deleted or take a new message', async () => {
    const daemon = await start();
    const id = daemon.createSession({ access_mode: AccessMode.Full });
    const { events, close } = await listen(daemon);
    daemon.sdk.script({ tool: 'Bash', input: { command: 'git status' } }, { wait: gate().promise });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'status' });
    await until(
      async () => (await api(daemon).get('/action-log')).body.data.length,
      (count) => count === 1,
    );

    expect((await api(daemon).post(`/sessions/${id}/stop`, {})).status).toBe(204);
    await stateOf(daemon, id, 'idle');
    await until(() => events.some((event) => event.event === 'session.finished'), Boolean);
    close();
    expect(events.find((event) => event.event === 'session.finished')?.data).toMatchObject({
      session_id: id,
      status: 'done',
      state: 'idle',
      error_code: null,
    });

    await converse(daemon, id, 'again');
    expect((await api(daemon).delete(`/sessions/${id}`)).status).toBe(204);
  });

  it('ends a run waiting on a question or an Approval, and expires the Approval', async () => {
    const daemon = await start();
    const asking = daemon.createSession();
    daemon.sdk.script({
      tool: 'AskUserQuestion',
      input: { questions: [{ question: 'Which branch?', header: 'Branch', multiSelect: false, options: [] }] },
    });
    await api(daemon).post(`/sessions/${asking}/messages`, { text: 'Fix it' });
    await stateOf(daemon, asking, 'waiting_input');
    expect((await api(daemon).post(`/sessions/${asking}/stop`, {})).status).toBe(204);
    await stateOf(daemon, asking, 'idle');

    const approving = daemon.createSession();
    daemon.sdk.script({ tool: 'Bash', input: { command: 'rm -rf build' } });
    await api(daemon).post(`/sessions/${approving}/messages`, { text: 'clean' });
    await stateOf(daemon, approving, 'waiting_approval');
    expect((await api(daemon).post(`/sessions/${approving}/stop`, {})).status).toBe(204);
    await stateOf(daemon, approving, 'idle');
    expect((await api(daemon).get('/approvals')).body.data).toEqual([
      expect.objectContaining({ session_id: approving, status: 'expired' }),
    ]);
    expect(daemon.sdk.ran).toEqual([]);
  });

  it('ends a run stopped before its query starts, while its conversation is still being found', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    await converse(daemon, id, 'first');
    daemon.sdk.script({ wait: gate().promise });
    const runtime = daemon.app.get(AgentRuntime);
    // A resumed run looks for its transcript before it queries; Stop lands in between.
    runtime.send(id, 'second');
    runtime.stop(id);
    await stateOf(daemon, id, 'idle');
    expect(daemon.sdk.calls).toHaveLength(1);
  });

  it('is refused with invalid_state when no run is going', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const idle = await api(daemon).post(`/sessions/${id}/stop`, {});
    expect(idle.status).toBe(409);
    expect(idle.body.error.code).toBe('invalid_state');
  });
});

describe('the Running tray', () => {
  const tray = async (daemon: AgentDaemon) => (await api(daemon).get('/agent-runs')).body.data;
  const stateOf = (daemon: AgentDaemon, id: string, state: string) =>
    until(
      async () => (await api(daemon).get(`/sessions/${id}`)).body.data.state,
      (value) => value === state,
      state,
    );

  it('lists a run going with its subagents nested, and drops it once it finishes', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const hold = gate();
    daemon.sdk.script(
      { task: { id: 't1', description: 'Search the repo', type: 'Explore' } },
      { task: { id: 't2', description: 'Read the router', parent: 't1' } },
      { taskEnds: { id: 't2', status: 'completed' } },
      { wait: hold.promise },
    );
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'look around' });
    const [run] = await until(
      () => tray(daemon),
      (runs) => runs[0]?.subagents.length === 2,
      'both subagents',
    );
    expect(run).toMatchObject({ running: true, outcome: null, can_resume: true, session: { id } });
    expect(run.started_at).toBeTruthy();
    expect(run.subagents).toEqual([
      expect.objectContaining({ id: 't1', parent_id: null, type: 'Explore', status: 'working' }),
      expect.objectContaining({ id: 't2', parent_id: 't1', status: 'done' }),
    ]);

    hold.open();
    await stateOf(daemon, id, 'idle');
    expect(await tray(daemon)).toEqual([]);
  });

  it('keeps a stopped run, ends its subagents with it, and lets Play and Dismiss follow', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    daemon.sdk.script({ task: { id: 't1', description: 'Search the repo' } }, { wait: gate().promise });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'look around' });
    await until(
      () => tray(daemon),
      (runs) => runs[0]?.subagents.length === 1,
      'the subagent',
    );
    await api(daemon).post(`/sessions/${id}/stop`, {});
    await stateOf(daemon, id, 'idle');

    const [kept] = await tray(daemon);
    expect(kept).toMatchObject({ running: false, outcome: 'stopped' });
    expect(kept.finished_at).toBeTruthy();
    expect(kept.subagents).toEqual([expect.objectContaining({ id: 't1', status: 'stopped' })]);

    const played = await api(daemon).post(`/sessions/${id}/resume`, {});
    expect(played.status).toBe(202);
    await stateOf(daemon, id, 'idle');
    expect(daemon.sdk.calls.at(-1)?.prompt).toBe('Carry on from where you stopped.');
    expect(await tray(daemon)).toEqual([]);
  });

  it('keeps a paused run for Play, and a run that hit its limit for Retry, until dismissed', async () => {
    const daemon = await start();
    const paused = daemon.createSession();
    daemon.sdk.script({ wait: gate().promise });
    await api(daemon).post(`/sessions/${paused}/messages`, { text: 'work' });
    await stateOf(daemon, paused, 'working');
    expect((await api(daemon).post(`/sessions/${paused}/pause`, {})).status).toBe(204);
    await stateOf(daemon, paused, 'idle');

    const limited = daemon.createSession();
    daemon.sdk.script({ rejected: true });
    await api(daemon).post(`/sessions/${limited}/messages`, { text: 'work' });
    await stateOf(daemon, limited, 'failed');

    const runs = await tray(daemon);
    expect(
      runs.map((run: { session: { id: string }; outcome: string }) => [run.session.id, run.outcome]).sort(),
    ).toEqual(
      [
        [paused, 'paused'],
        [limited, 'rate_limited'],
      ].sort(),
    );

    await api(daemon).post(`/sessions/${limited}/resume`, {});
    await stateOf(daemon, limited, 'idle');
    expect(daemon.sdk.calls.at(-1)?.prompt).toContain('Try again');

    expect((await api(daemon).delete(`/agent-runs/${paused}`)).status).toBe(204);
    expect(await tray(daemon)).toEqual([]);
  });

  it('keeps a run the daemon restart interrupted', async () => {
    const dataDir = (await start()).dataDir;
    const first = running[0] as AgentDaemon;
    const id = first.createSession();
    first.sdk.script({ wait: gate().promise });
    await api(first).post(`/sessions/${id}/messages`, { text: 'work' });
    await stateOf(first, id, 'working');
    await running.pop()?.stop();

    const again = await start({ dataDir });
    expect(await tray(again)).toEqual([expect.objectContaining({ running: false, outcome: 'interrupted' })]);
  });

  it('refuses Play while a run is going and Dismiss on it', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    daemon.sdk.script({ wait: gate().promise });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'work' });
    await stateOf(daemon, id, 'working');
    expect((await api(daemon).post(`/sessions/${id}/resume`, {})).body.error.code).toBe('session_busy');
    expect((await api(daemon).delete(`/agent-runs/${id}`)).body.error.code).toBe('session_busy');
  });
});

describe('daemon restart', () => {
  it('fails Sessions left waiting and expires their Approvals', async () => {
    const dataDir = (await start()).dataDir;
    const daemon = running[0] as AgentDaemon;
    const id = daemon.createSession();
    daemon.sdk.script({ tool: 'Bash', input: { command: 'rm -rf build' } });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'clean' });
    await until(
      async () => (await api(daemon).get(`/sessions/${id}`)).body.data.state,
      (state) => state === 'waiting_approval',
    );
    await running.pop()?.stop();

    const again = await start({ dataDir });
    expect((await api(again).get(`/sessions/${id}`)).body.data.state).toBe('failed');
    const approvals = await api(again).get('/approvals');
    expect(approvals.body.data).toEqual([expect.objectContaining({ kind: 'command', status: 'expired' })]);
    const log = await api(again).get('/action-log');
    expect(log.body.data).toEqual([
      expect.objectContaining({ command: 'rm -rf build', outcome: 'failed', error_message: 'interrupted' }),
    ]);
  });
});

describe('the Agent runs page', () => {
  const detail = async (daemon: AgentDaemon, id: string) => (await api(daemon).get(`/agent-runs/${id}`)).body.data;
  const stateOf = (daemon: AgentDaemon, id: string, state: string) =>
    until(
      async () => (await api(daemon).get(`/sessions/${id}`)).body.data.state,
      (value) => value === state,
      state,
    );

  it('keeps each tool call with its phase and time, and says where the run is', async () => {
    const daemon = await start();
    const id = daemon.createSession({ access_mode: AccessMode.Full });
    const hold = gate();
    daemon.sdk.script(
      { tool: 'Read', input: { file_path: 'a.ts' } },
      { tool: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } },
      { tool: 'Bash', input: { command: 'pnpm test backend' }, hold: hold.promise },
    );
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'fix it' });
    const open = await until(
      () => detail(daemon, id),
      (value) => value.steps.some((step: { finished_at: string | null }) => step.finished_at === null),
      'the open command',
    );

    expect(open.steps.map((step: { tool: string; phase: string }) => [step.tool, step.phase])).toEqual([
      ['Read', 'reading'],
      ['Edit', 'editing'],
      ['Bash', 'commands'],
    ]);
    expect(open.run).toMatchObject({ running: true, health: 'on_track', activity: 'Running pnpm test backend' });
    expect(open.stages.find((one: { state: string }) => one.state === 'now').id).toBe('run_tests');
    expect(open.run.split.map((one: { phase: string }) => one.phase)).toEqual([
      'thinking',
      'reading',
      'editing',
      'commands',
      'subagents',
      'waiting_you',
      'waiting_limit',
    ]);

    hold.open();
    await stateOf(daemon, id, 'idle');
    const done = await detail(daemon, id);
    expect(done.steps.every((step: { ok: boolean | null }) => step.ok === true)).toBe(true);
    expect(done.failure).toBeNull();
  });

  it('says a run waits on the operator, and for what', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    daemon.sdk.script({ tool: 'Bash', input: { command: 'rm -rf build' } });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'clean' });
    const [run] = await until(
      async () => (await api(daemon).get('/agent-runs')).body.data,
      (runs) => runs[0]?.health === 'needs_you',
      'needs you',
    );
    expect(run.health_reason).toMatch(/^Waiting on you for \d+s: Running rm -rf build$/);
    const [approval] = (await api(daemon).get('/approvals')).body.data;
    await api(daemon).post(`/approvals/${approval.id}/decision`, { decision: 'approved' });
    await stateOf(daemon, id, 'idle');
    // Time spent on the Approval is kept apart from the call's own time.
    const ended = await detail(daemon, id);
    expect(ended.run.split.find((one: { phase: string }) => one.phase === 'waiting_you').ms).toBeGreaterThanOrEqual(0);
  });

  it('explains a run the network blocked, with the host to allow', async () => {
    const daemon = await start();
    const id = daemon.createSession({ access_mode: AccessMode.Full });
    daemon.sdk.script(
      {
        tool: 'Bash',
        input: { command: 'pnpm install' },
        fails: 'ERR_PNPM_FETCH_403 GET https://registry.example.com/left-pad: Forbidden',
      },
      { crash: 'process died' },
    );
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'bump deps' });
    await stateOf(daemon, id, 'failed');

    const [run] = (await api(daemon).get('/agent-runs')).body.data;
    expect(run).toMatchObject({ health: 'failed', outcome: 'failed' });
    expect(run.health_reason).toContain('pnpm install');
    const { failure } = await detail(daemon, id);
    expect(failure).toMatchObject({ kind: 'network_blocked', blocked_host: 'registry.example.com' });
    expect(failure.raw).toContain('Forbidden');
  });

  it('explains a usage limit, and reports 404 for a Session that never ran', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    expect((await api(daemon).get(`/agent-runs/${id}`)).status).toBe(404);
    daemon.sdk.script({ rejected: true });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'work' });
    await stateOf(daemon, id, 'failed');
    expect((await detail(daemon, id)).failure).toMatchObject({ kind: 'rate_limited' });
  });

  it('keeps what a run cost and adds the day up', async () => {
    const daemon = await start();
    const first = daemon.createSession();
    const second = daemon.createSession();
    daemon.sdk.script({ cost: { usd: 0.25, tokens: 1000 } }, { text: 'ok' });
    await api(daemon).post(`/sessions/${first}/messages`, { text: 'one' });
    await stateOf(daemon, first, 'idle');
    daemon.sdk.script({ cost: { usd: 0.5, tokens: 2000 } }, { text: 'ok' });
    await api(daemon).post(`/sessions/${second}/messages`, { text: 'two' });
    await stateOf(daemon, second, 'idle');

    expect((await detail(daemon, first)).run).toMatchObject({ cost_usd: 0.25, tokens: 1000 });
    expect((await api(daemon).get('/agent-runs/usage')).body.data).toEqual({ cost_usd: 0.75, tokens: 3000, runs: 2 });
  });

  describe('queued messages', () => {
    const queued = async (daemon: AgentDaemon, id: string) =>
      (await api(daemon).get(`/sessions/${id}`)).body.data.queued_message;

    it('sends the queued message when the run ends', async () => {
      const daemon = await start();
      const id = daemon.createSession();
      const hold = gate();
      daemon.sdk.script({ wait: hold.promise });
      await api(daemon).post(`/sessions/${id}/messages`, { text: 'first' });
      await stateOf(daemon, id, 'working');
      expect((await api(daemon).put(`/sessions/${id}/queue`, { text: 'then this' })).body.data).toEqual({
        queued: true,
      });
      expect(await queued(daemon, id)).toBe('then this');

      hold.open();
      await until(
        () => daemon.sdk.calls.length,
        (count) => count === 2,
        'the queued run',
      );
      expect(daemon.sdk.calls[1]?.prompt).toBe('then this');
      await stateOf(daemon, id, 'idle');
      expect(await queued(daemon, id)).toBeNull();
    });

    it('holds the message when the operator stops the run, until Send now', async () => {
      const daemon = await start();
      const id = daemon.createSession();
      daemon.sdk.script({ wait: gate().promise });
      await api(daemon).post(`/sessions/${id}/messages`, { text: 'first' });
      await stateOf(daemon, id, 'working');
      await api(daemon).put(`/sessions/${id}/queue`, { text: 'held text' });
      await api(daemon).post(`/sessions/${id}/stop`, {});
      await stateOf(daemon, id, 'idle');
      expect(daemon.sdk.calls).toHaveLength(1);
      expect(await queued(daemon, id)).toBe('held text');

      expect((await api(daemon).post(`/sessions/${id}/queue/send`, {})).status).toBe(204);
      await until(
        () => daemon.sdk.calls.length,
        (count) => count === 2,
        'the sent run',
      );
      expect(daemon.sdk.calls[1]?.prompt).toBe('held text');
      await stateOf(daemon, id, 'idle');
      expect(await queued(daemon, id)).toBeNull();
    });

    it('stops a run going and sends the message when Send now comes while it runs', async () => {
      const daemon = await start();
      const id = daemon.createSession();
      daemon.sdk.script({ wait: gate().promise });
      await api(daemon).post(`/sessions/${id}/messages`, { text: 'first' });
      await stateOf(daemon, id, 'working');
      await api(daemon).put(`/sessions/${id}/queue`, { text: 'now please' });
      await api(daemon).post(`/sessions/${id}/queue/send`, {});
      await until(
        () => daemon.sdk.calls.length,
        (count) => count === 2,
        'the sent run',
      );
      expect(daemon.sdk.calls[1]?.prompt).toBe('now please');
      await stateOf(daemon, id, 'idle');
    });

    it('takes the message back, and sends at once when no run goes', async () => {
      const daemon = await start();
      const id = daemon.createSession();
      daemon.sdk.script({ wait: gate().promise });
      await api(daemon).post(`/sessions/${id}/messages`, { text: 'first' });
      await stateOf(daemon, id, 'working');
      await api(daemon).put(`/sessions/${id}/queue`, { text: 'never mind' });
      expect((await api(daemon).delete(`/sessions/${id}/queue`)).status).toBe(204);
      expect(await queued(daemon, id)).toBeNull();
      await api(daemon).post(`/sessions/${id}/stop`, {});
      await stateOf(daemon, id, 'idle');

      expect((await api(daemon).put(`/sessions/${id}/queue`, { text: 'nothing runs' })).body.data).toEqual({
        queued: false,
      });
      await until(
        () => daemon.sdk.calls.at(-1)?.prompt,
        (prompt) => prompt === 'nothing runs',
        'the message to start',
      );
      expect((await api(daemon).post(`/sessions/${id}/queue/send`, {})).body.error.code).toBe('invalid_state');
    });
  });

  it('stops every run going and dismisses every ended run', async () => {
    const daemon = await start();
    const a = daemon.createSession();
    const b = daemon.createSession();
    const limited = daemon.createSession();
    daemon.sdk.script({ rejected: true });
    await api(daemon).post(`/sessions/${limited}/messages`, { text: 'x' });
    await stateOf(daemon, limited, 'failed');
    daemon.sdk.script({ wait: gate().promise });
    daemon.sdk.script({ wait: gate().promise });
    await api(daemon).post(`/sessions/${a}/messages`, { text: 'x' });
    await api(daemon).post(`/sessions/${b}/messages`, { text: 'x' });
    await stateOf(daemon, a, 'working');
    await stateOf(daemon, b, 'working');

    expect((await api(daemon).post('/agent-runs/stop-all', {})).body.data).toEqual({ stopped: 2 });
    await stateOf(daemon, a, 'idle');
    await stateOf(daemon, b, 'idle');
    expect((await api(daemon).get('/agent-runs')).body.data).toHaveLength(3);

    expect((await api(daemon).delete('/agent-runs')).body.data).toEqual({ dismissed: 3 });
    expect((await api(daemon).get('/agent-runs')).body.data).toEqual([]);
  });
});
