import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { AccessMode, Effort, SessionKind } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
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
  it('runs the first message under the active account and titles the Session from its first line', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const long = `Why does POST /fb/webhook return 500 for every order placed after midnight UTC?\nMore detail.`;
    const session = await converse(daemon, id, long);

    expect(session).toMatchObject({
      title: long.split('\n')[0]?.slice(0, 60),
      state: 'idle',
      last_message_preview: 'Done.',
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
