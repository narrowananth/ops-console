import os from 'node:os';
import path from 'node:path';
import { AccessMode, ConnectorId, type LogSource, RunPurpose, SessionKind, type WsEvent } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpScope } from '../src/agent/mcp-scope';
import { NEW_RELIC_QUERY_TOOL } from '../src/agent/new-relic-tool';
import { RUN_INTEGRATION_TOOL } from '../src/agent/pull-request-tool';
import { AgentRuntime } from '../src/agent/runtime';
import { type AgentDaemon, api, converse, listen, startAgentDaemon, until, WORKING_DIR } from './agent-fixtures';
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

  it('supervised warns when a secret-looking assignment hides part of a command', async () => {
    const daemon = await start();
    const hidden: Step = { tool: 'Bash', input: { command: `export X_TOKEN='echo hi'; eval "$X_TOKEN"` } };
    const { approvals } = await runTool(daemon, AccessMode.Supervised, hidden, 'denied');
    const [approval] = approvals as { summary: string }[];
    expect(approval?.summary).toContain('[redacted]');
    expect(approval?.summary).toContain('Part of this command is hidden as a secret, and it runs as written');
    // A plain command carries no warning.
    const plain = await runTool(daemon, AccessMode.Supervised, bash, 'approved');
    const summaries = (plain.approvals as { summary: string }[]).map((item) => item.summary);
    expect(summaries).toContain('$ pnpm build');
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

describe('file tool write scope', () => {
  const outside = (file: string): Step => ({ tool: 'Write', input: { file_path: file, content: 'x' } });

  it('refuses a write outside the run folders in every Access mode, full included', async () => {
    const daemon = await start();
    for (const mode of Object.values(AccessMode)) {
      daemon.sdk.ran.length = 0;
      await runTool(daemon, mode, outside(path.join(os.homedir(), '.zshrc')));
      await runTool(daemon, mode, outside(path.join(os.homedir(), '.ops-console', 'current', 'bin', 'ops-console')));
      expect(daemon.sdk.ran).toEqual([]);
    }
  });

  it('lets a write in the working folder through', async () => {
    const daemon = await start();
    await runTool(daemon, AccessMode.Full, outside(path.join(WORKING_DIR, 'notes.md')));
    expect(daemon.sdk.ran).toEqual([expect.objectContaining({ tool: 'Write' })]);
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
      { tool: 'Bash', input: { command: 'bkt pr merge 42' } },
      { tool: 'mcp__github__merge_pull_request', input: { pullNumber: 42 } },
    );
    await converse(daemon, id, 'ship it');

    expect(daemon.sdk.ran).toEqual([]);
    const log = await api(daemon).get('/action-log');
    expect(log.body.data.map((row: { kind: string; outcome: string }) => [row.kind, row.outcome])).toEqual([
      ['query', 'denied'],
      ['shell', 'denied'],
      ['pr', 'denied'],
    ]);
  });
});

describe('commit hooks', () => {
  it('refuses a command that skips them, in full mode, and runs the same command without the skip', async () => {
    const daemon = await start();
    const id = daemon.createSession({ access_mode: AccessMode.Full });
    daemon.sdk.script(
      { tool: 'Bash', input: { command: 'git add -A && git commit --no-verify -m "wip"' } },
      { tool: 'Bash', input: { command: 'HUSKY=0 git commit -m "wip"' } },
      { tool: 'Bash', input: { command: 'git commit -n -m "wip"' } },
      { tool: 'Bash', input: { command: 'git -c core.hooksPath=/dev/null commit -m "wip"' } },
      { tool: 'Bash', input: { command: 'git commit -m "fix the -n and --no-verify flags"' } },
    );
    await converse(daemon, id, 'commit it');

    // Only the commit whose message merely names the flags runs.
    expect(daemon.sdk.ran).toEqual([
      { tool: 'Bash', input: { command: 'git commit -m "fix the -n and --no-verify flags"' } },
    ]);
  });

  it('tells every run to let the repo hooks finish and never skip them', async () => {
    const daemon = await start();
    await converse(daemon, daemon.createSession(), 'go');
    const append = (daemon.sdk.calls.at(-1)?.options.systemPrompt as { append: string } | undefined)?.append ?? '';
    expect(append).toContain('Commit hooks.');
    expect(append).toContain('--no-verify');
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
      {
        kind: 'question',
        text: 'Which branch should the fix go on?',
        header: 'Branch',
        multi_select: false,
        options: [
          { label: 'main', description: 'Straight to main' },
          { label: 'fix/webhook', description: 'A new branch' },
        ],
      },
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

describe('Google Connectors', () => {
  const GOOGLE = ['google-docs', 'google-sheets', 'google-drive'];
  const denied = (daemon: AgentDaemon) =>
    (
      daemon.sdk.calls.at(-1)?.options.settings as { deniedMcpServers?: { serverName: string }[] } | undefined
    )?.deniedMcpServers?.map((server) => server.serverName) ?? [];

  it('keeps the Google servers out of every Job and in a chat', async () => {
    const daemon = await start();
    const runtime = daemon.app.get(AgentRuntime);
    await converse(daemon, daemon.createSession(), 'read my sheet');
    for (const name of GOOGLE) expect(denied(daemon)).not.toContain(name);

    for (const purpose of [
      RunPurpose.Verify,
      RunPurpose.Fix,
      RunPurpose.AgentReview,
      RunPurpose.ReplyCheck,
      RunPurpose.CommentPass,
    ]) {
      await runtime.runFor(daemon.createSession(), 'job', null, { purpose }).finished;
      expect(denied(daemon), purpose).toEqual(expect.arrayContaining(GOOGLE));
    }
  });

  it('asks before a Google call in supervised mode as for any MCP server, and runs it in full', async () => {
    const daemon = await start();
    const write: Step = {
      tool: 'mcp__google-sheets__update_values',
      input: { spreadsheet: 'abc', range: 'A1', values: [[1]] },
    };
    const asked = await runTool(daemon, AccessMode.Supervised, write, 'approved');
    expect(asked.approvals).toHaveLength(1);
    const full = await runTool(daemon, AccessMode.Full, write);
    expect(full.approvals).toEqual([asked.approvals[0]]);
    expect(daemon.sdk.ran.map((call) => call.tool)).toEqual([write.tool, write.tool]);
  });
});

describe('CloudWatch Connector', () => {
  const denied = (daemon: AgentDaemon) =>
    (
      daemon.sdk.calls.at(-1)?.options.settings as { deniedMcpServers?: { serverName: string }[] } | undefined
    )?.deniedMcpServers?.map((server) => server.serverName) ?? [];
  const tool = (name: string): Step => ({ tool: `mcp__cloudwatch__${name}`, input: {} });

  it('starts its MCP server for a chat and for a Verification with no Alert, and for no other job', async () => {
    const daemon = await start();
    const runtime = daemon.app.get(AgentRuntime);
    await converse(daemon, daemon.createSession(), 'which log groups are there');
    expect(denied(daemon)).not.toContain('cloudwatch');
    await runtime.runFor(daemon.createSession(), 'job', null, { purpose: RunPurpose.Verify }).finished;
    expect(denied(daemon)).not.toContain('cloudwatch');

    for (const purpose of [RunPurpose.Fix, RunPurpose.AgentReview, RunPurpose.ReplyCheck, RunPurpose.CommentPass]) {
      await runtime.runFor(daemon.createSession(), 'job', null, { purpose }).finished;
      expect(denied(daemon), purpose).toContain('cloudwatch');
    }
  });

  it('lets the agent use only the four log tools of its server, in every access mode', async () => {
    const daemon = await start();
    const allowed = [
      'describe_log_groups',
      'execute_log_insights_query',
      'get_logs_insight_query_results',
      'cancel_logs_insight_query',
    ];
    const refused = [
      'analyze_log_group',
      'execute_cwl_insights_batch',
      'get_metric_data',
      'get_metric_metadata',
      'get_recommended_metric_alarms',
      'analyze_metric',
      'execute_promql_query',
      'get_promql_series',
      'get_active_alarms',
      'get_alarm_history',
      // A tool a later version of the server adds is refused too.
      'put_metric_data',
    ];
    for (const name of [...allowed, ...refused]) await runTool(daemon, AccessMode.Full, tool(name));
    expect(daemon.sdk.ran.map((call) => call.tool.replace('mcp__cloudwatch__', ''))).toEqual(allowed);
  });
});

describe('Loki and New Relic MCP servers', () => {
  const kept = (purpose: RunPurpose, source: LogSource | null) => {
    const scope = mcpScope(purpose, SessionKind.Repo, source);
    return scope.none ? [] : ['grafana', 'newrelic'].filter((name) => !scope.withoutConnectors.includes(name));
  };

  it('starts the server of the Alert’s own source for its Verification and Fix, and no other', () => {
    for (const purpose of [RunPurpose.Verify, RunPurpose.Fix]) {
      expect(kept(purpose, ConnectorId.LokiLogs), purpose).toEqual(['grafana']);
      expect(kept(purpose, ConnectorId.NewRelicLogs), purpose).toEqual(['newrelic']);
      expect(kept(purpose, ConnectorId.Datadog), purpose).toEqual([]);
    }
  });

  it('starts neither for a pull request job', () => {
    for (const purpose of [RunPurpose.AgentReview, RunPurpose.OpenPullRequest]) {
      expect(kept(purpose, ConnectorId.LokiLogs), purpose).toEqual([]);
    }
  });
});

describe('Loki and New Relic tools of the hosted servers', () => {
  const tool = (server: string, name: string) => ({ tool: `mcp__${server}__${name}`, input: {} }) satisfies Step;

  it('lets the agent call only the read tools of Grafana’s and New Relic’s servers, in full access, and refuses any other, known or not', async () => {
    const daemon = await start();
    const allowed = [
      ...[
        'list_datasources',
        'get_datasource',
        'list_loki_label_names',
        'list_loki_label_values',
        'query_loki_logs',
        'query_loki_stats',
        'query_loki_patterns',
      ].map((name) => tool('grafana', name)),
      ...['execute_nrql_query', 'list_available_new_relic_accounts'].map((name) => tool('newrelic', name)),
    ];
    const refused = [
      ...['update_dashboard', 'create_incident', 'query_prometheus', 'a_tool_a_later_version_adds'].map((name) =>
        tool('grafana', name),
      ),
      ...['create_alert_condition', 'a_tool_a_later_version_adds'].map((name) => tool('newrelic', name)),
    ];
    for (const step of [...allowed, ...refused]) await runTool(daemon, AccessMode.Full, step);
    expect(daemon.sdk.ran.map((call) => call.tool)).toEqual(allowed.map((step) => step.tool));
  });
});

describe('Loki and New Relic through run_integration', () => {
  const call = (cli: string, ...args: string[]): Step => ({ tool: RUN_INTEGRATION_TOOL, input: { cli, args } });

  it('is not offered logcli or newrelic: a call naming either is refused in every access mode and runs nothing', async () => {
    const daemon = await start();
    const refused = [
      call('logcli', 'query', '--since', '1h', '{service_name="shop-api"}'),
      call('logcli', 'labels'),
      call('newrelic', 'nrql', 'query', '--query', 'SELECT count(*) FROM Log SINCE 1 hour ago'),
    ];
    for (const mode of Object.values(AccessMode)) for (const step of refused) await runTool(daemon, mode, step);
    expect(daemon.sdk.ran).toEqual([]);
  });
});

describe('New Relic through the console’s own query tool', () => {
  it('runs with no Approval in every access mode, as a logged query that holds no secret', async () => {
    const daemon = await start();
    const nrql = "SELECT count(*) FROM Log WHERE api_key = 'abc123secret' SINCE 1 hour ago";
    for (const mode of Object.values(AccessMode)) {
      const { approvals } = await runTool(daemon, mode, { tool: NEW_RELIC_QUERY_TOOL, input: { nrql } });
      expect(approvals, mode).toEqual([]);
    }
    expect(daemon.sdk.ran.map((call) => call.tool)).toEqual(Object.values(AccessMode).map(() => NEW_RELIC_QUERY_TOOL));
    const log = (await api(daemon).get('/action-log')).body.data as { target: string; command: string }[];
    expect(log).toHaveLength(Object.values(AccessMode).length);
    for (const row of log) {
      expect(row.target).toBe('New Relic');
      expect(row.command).toMatch(/^NRQL SELECT count\(\*\) FROM Log/);
      expect(row.command).not.toContain('abc123secret');
    }
  });
});
