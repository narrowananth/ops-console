import { AccessMode, type WsEvent } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentDaemon, api, converse, listen, startAgentDaemon, until } from './agent-fixtures';
import type { Step } from './fakes/agent-sdk';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

async function start() {
  const daemon = await startAgentDaemon();
  running.push(daemon);
  return daemon;
}

const of = <E extends WsEvent['event']>(events: WsEvent[], name: E) =>
  events.flatMap((event) => (event.event === name ? [event.data as Extract<WsEvent, { event: E }>['data']] : []));

async function stateOf(daemon: AgentDaemon, id: string, state: string) {
  return until(
    async () => (await api(daemon).get(`/sessions/${id}`)).body.data.state,
    (value) => value === state,
    state,
  );
}

async function pendingApproval(daemon: AgentDaemon) {
  const list = await until(
    async () => (await api(daemon).get('/approvals?status=pending')).body.data,
    (data) => data.length === 1,
    'a pending approval',
  );
  return list[0];
}

/** Runs one tool call in a Session with the access mode, answering each Approval with `decide`. */
async function runTool(
  daemon: AgentDaemon,
  accessMode: AccessMode,
  step: Step,
  decide: 'approved' | 'denied' | null = null,
): Promise<{ id: string; approvals: unknown[] }> {
  const id = daemon.createSession({ access_mode: accessMode });
  daemon.sdk.script(step);
  await api(daemon).post(`/sessions/${id}/messages`, { text: 'go' });
  if (decide) {
    await stateOf(daemon, id, 'waiting_approval');
    const approval = await pendingApproval(daemon);
    await api(daemon).post(`/approvals/${approval.id}/decision`, { decision: decide });
  }
  await stateOf(daemon, id, 'idle');
  return { id, approvals: (await api(daemon).get('/approvals')).body.data };
}

describe('access modes', () => {
  const bash: Step = { tool: 'Bash', input: { command: 'pnpm build' } };
  const edit: Step = { tool: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } };

  it('supervised asks before a command, and runs it once approved', async () => {
    const daemon = await start();
    const { approvals } = await runTool(daemon, AccessMode.Supervised, bash, 'approved');
    expect(approvals).toEqual([
      expect.objectContaining({
        kind: 'command',
        status: 'approved',
        summary: '$ pnpm build',
        command: 'pnpm build',
        is_prod: false,
      }),
    ]);
    expect(daemon.sdk.ran).toEqual([{ tool: 'Bash', input: { command: 'pnpm build' } }]);
  });

  it('supervised asks before an edit; the edit Approval has no Action Log row', async () => {
    const daemon = await start();
    const { approvals } = await runTool(daemon, AccessMode.Supervised, edit, 'approved');
    expect(approvals).toEqual([
      expect.objectContaining({
        kind: 'edit',
        summary: 'Edit src/a.ts',
        action_log_id: null,
        target: null,
        command: null,
      }),
    ]);
    expect((await api(daemon).get('/action-log')).body.data).toEqual([]);
  });

  it('accept_edits runs edits and still asks before commands', async () => {
    const daemon = await start();
    expect((await runTool(daemon, AccessMode.AcceptEdits, edit)).approvals).toEqual([]);
    const { approvals } = await runTool(daemon, AccessMode.AcceptEdits, bash, 'denied');
    expect(approvals).toEqual([expect.objectContaining({ kind: 'command', status: 'denied' })]);
    expect(daemon.sdk.ran.map((call) => call.tool)).toEqual(['Edit']);
  });

  it('auto asks only for the calls its classifier sends to the operator', async () => {
    const daemon = await start();
    expect((await runTool(daemon, AccessMode.Auto, bash)).approvals).toEqual([]);
    const risky = await runTool(daemon, AccessMode.Auto, { ...bash, classifierAsks: true }, 'approved');
    expect(risky.approvals).toEqual([expect.objectContaining({ kind: 'command' })]);
  });

  it('full runs edits and commands without asking', async () => {
    const daemon = await start();
    await runTool(daemon, AccessMode.Full, edit);
    const { approvals } = await runTool(daemon, AccessMode.Full, bash);
    expect(approvals).toEqual([]);
    expect(daemon.sdk.ran.map((call) => call.tool)).toEqual(['Edit', 'Bash']);
  });
});

describe('Approvals', () => {
  it('denying tells the agent no and sets the Action Log row denied; a decided Approval cannot be decided again', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const { approvals } = await runTool(
      daemon,
      AccessMode.Supervised,
      { tool: 'Bash', input: { command: 'rm -rf dist' } },
      'denied',
    );
    const [approval] = approvals as { id: string; action_log_id: string }[];

    expect(daemon.sdk.ran).toEqual([]);
    const log = await api(daemon).get('/action-log');
    expect(log.body.data).toEqual([expect.objectContaining({ id: approval?.action_log_id, outcome: 'denied' })]);
    expect(of(events, 'approval.requested')).toEqual([
      {
        approval_id: approval?.id,
        session_id: expect.any(String),
        kind: 'command',
        summary: '$ rm -rf dist',
        is_prod: false,
      },
    ]);
    expect(of(events, 'approval.decided')).toEqual([{ approval_id: approval?.id, decision: 'denied' }]);

    const again = await api(daemon).post(`/approvals/${approval?.id}/decision`, { decision: 'approved' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('invalid_state');
    close();
  });
});

describe('PROD writes', () => {
  it('hold for a prod_write Approval in full mode, and run only once approved', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const write = 'psql-prod -c "update orders set status = 1"';
    const id = daemon.createSession({ access_mode: AccessMode.Full });
    daemon.sdk.script({ tool: 'Bash', input: { command: write } });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'fix the order' });

    await stateOf(daemon, id, 'waiting_approval');
    expect(daemon.sdk.ran).toEqual([]);
    const approval = await pendingApproval(daemon);
    expect(approval).toMatchObject({
      kind: 'prod_write',
      is_prod: true,
      command: write,
      summary: `PROD write: ${write}`,
    });
    expect(of(events, 'approval.requested')).toEqual([expect.objectContaining({ kind: 'prod_write', is_prod: true })]);

    await api(daemon).post(`/approvals/${approval.id}/decision`, { decision: 'approved' });
    await stateOf(daemon, id, 'idle');
    expect(daemon.sdk.ran).toEqual([{ tool: 'Bash', input: { command: write } }]);
    close();
  });

  it('a denied PROD write never runs, and its secrets never reach the Approval', async () => {
    const daemon = await start();
    const write = 'PGPASSWORD=hunter22 psql-prod -c "delete from carts"';
    const redacted = 'PGPASSWORD=[redacted] psql-prod -c "delete from carts"';
    const { events, close } = await listen(daemon);
    const { approvals } = await runTool(daemon, AccessMode.Full, { tool: 'Bash', input: { command: write } }, 'denied');
    expect(daemon.sdk.ran).toEqual([]);
    expect(approvals).toEqual([expect.objectContaining({ summary: `PROD write: ${redacted}`, command: redacted })]);
    expect(of(events, 'approval.requested')).toEqual([expect.objectContaining({ summary: `PROD write: ${redacted}` })]);
    expect((await api(daemon).get('/action-log?is_prod=true')).body.data).toEqual([
      expect.objectContaining({ command: redacted, is_prod: true, outcome: 'denied' }),
    ]);
    close();
  });
});

describe('merging', () => {
  it('is denied in full mode, by command and by Git host MCP tool', async () => {
    const daemon = await start();
    const id = daemon.createSession({ access_mode: AccessMode.Full });
    daemon.sdk.script(
      { tool: 'Bash', input: { command: 'gh pr merge 42 --squash' } },
      { tool: 'mcp__github__merge_pull_request', input: { pullNumber: 42 } },
    );
    await converse(daemon, id, 'ship it');

    expect(daemon.sdk.ran).toEqual([]);
    const log = await api(daemon).get('/action-log');
    expect(log.body.data.map((row: { kind: string; outcome: string }) => [row.kind, row.outcome])).toEqual([
      ['query', 'denied'],
      ['pr', 'denied'],
    ]);
  });
});

describe('Action Log', () => {
  it('writes a pending row before every Bash and MCP call, then its outcome, with the kind and target of the call', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const id = daemon.createSession({ access_mode: AccessMode.Full });
    daemon.sdk.script(
      { tool: 'Bash', input: { command: 'git log -1' } },
      { tool: 'Bash', input: { command: 'gh pr view 42' } },
      { tool: 'Bash', input: { command: 'pnpm test' }, fails: 'Exit code 1' },
      { tool: 'Read', input: { file_path: 'README.md' } },
      { tool: 'mcp__slack__slack_send_message', input: { channel_id: 'C123', text: 'deployed' } },
      { tool: 'mcp__atlassian__createJiraIssue', input: { projectKey: 'OPS', summary: 'Fix webhook' } },
      { tool: 'mcp__pg-staging__execute_sql', input: { sql: 'select 1' } },
    );
    await converse(daemon, id, 'go');

    const log = await api(daemon).get(`/action-log?session_id=${id}`);
    expect(
      log.body.data.map((row: Record<string, unknown>) => [row.kind, row.target, row.outcome, row.actor]).reverse(),
    ).toEqual([
      ['git', expect.any(String), 'ok', 'agent'],
      ['pr', expect.stringMatching(/#42$/), 'ok', 'agent'],
      ['shell', expect.any(String), 'failed', 'agent'],
      ['message', 'C123', 'ok', 'agent'],
      ['ticket', 'atlassian', 'ok', 'agent'],
      ['query', 'pg-staging', 'ok', 'agent'],
    ]);
    expect(log.body.data.find((row: { kind: string }) => row.kind === 'shell')).toMatchObject({
      error_message: 'Exit code 1',
    });

    const logged = of(events, 'action.logged');
    expect(logged).toHaveLength(12);
    for (const row of log.body.data) {
      expect(logged.filter((event) => event.id === row.id).map((event) => event.outcome)).toEqual([
        'pending',
        row.outcome,
      ]);
    }
    expect((await api(daemon).get('/action-log?kind=git')).body.data).toHaveLength(1);
    close();
  });

  it('stores commands redacted', async () => {
    const daemon = await start();
    await runTool(daemon, AccessMode.Full, {
      tool: 'Bash',
      input: { command: 'PGPASSWORD=hunter22 psql -h db.example.com' },
    });
    expect((await api(daemon).get('/action-log')).body.data[0].command).toBe(
      'PGPASSWORD=[redacted] psql -h db.example.com',
    );
  });

  it('has no update or delete endpoint', async () => {
    const daemon = await start();
    await runTool(daemon, AccessMode.Full, { tool: 'Bash', input: { command: 'ls' } });
    const [row] = (await api(daemon).get('/action-log')).body.data;
    expect((await api(daemon).patch(`/action-log/${row.id}`, { outcome: 'ok' })).status).toBe(404);
    expect((await api(daemon).delete(`/action-log/${row.id}`)).status).toBe(404);
    expect((await api(daemon).delete('/action-log')).status).toBe(404);
  });
});

describe("the agent's questions", () => {
  it('wait for the operator, whose next message answers them', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const question = {
      question: 'Which branch should the fix go on?',
      header: 'Branch',
      multiSelect: false,
      options: [
        { label: 'main', description: 'Straight to main' },
        { label: 'fix/webhook', description: 'A new branch' },
      ],
    };
    daemon.sdk.script({ tool: 'AskUserQuestion', input: { questions: [question] } }, { text: 'On it.' });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'Fix it' });

    await stateOf(daemon, id, 'waiting_input');
    const messages = await api(daemon).get(`/sessions/${id}/messages`);
    expect(messages.body.data.at(-1).parts).toEqual([
      { kind: 'question', text: 'Which branch should the fix go on?', options: ['main', 'fix/webhook'] },
    ]);
    expect((await api(daemon).get('/approvals')).body.data).toEqual([]);

    const answered = await api(daemon).post(`/sessions/${id}/messages`, { text: 'fix/webhook' });
    expect(answered.status).toBe(202);
    await stateOf(daemon, id, 'idle');
    expect(daemon.sdk.ran).toEqual([
      {
        tool: 'AskUserQuestion',
        input: { questions: [question], answers: { 'Which branch should the fix go on?': 'fix/webhook' } },
      },
    ]);
  });
});
