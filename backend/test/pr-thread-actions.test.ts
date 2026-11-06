import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectorId, HealthStatus, PlaybookTrigger, PrState, type WsEvent } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { StartupRecovery } from '../src/common/recovery';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { actionLog, agentComments, connectors, prCommentPasses, prReplyChecks } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { BUILTIN_RULES } from '../src/playbooks/builtins';
import { ReposModule } from '../src/repos/repos.module';
import { PullRequestsService } from '../src/workspace/pull-requests.service';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, gate, listen, startAgentDaemon, stepAnswer, stepTurns, until } from './agent-fixtures';
import type { Step } from './fakes/agent-sdk';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeGitHost, hostPr } from './fakes/git-host';
import { FakeProbe } from './fakes/probe';
import { tempDir } from './helpers';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'pipe',
  })
    .toString()
    .trim();

type Ctx = {
  daemon: AgentDaemon;
  host: FakeGitHost;
  repoId: string;
  /** The operator's checkout. */
  dir: string;
  /** The bare repository `origin` points at. */
  remote: string;
  /** The pull request's head commit. */
  head: string;
  store: Store;
  http: ReturnType<typeof api>;
  events: WsEvent[];
};

/**
 * GitHub connected as `octo-operator`, one imported Repo whose `origin` is a local bare repository, and pull
 * request #1 from `feature-1`, by `author`, with two threads on a line, `c1` (answered by `c2`) and `c3`, and a
 * general comment `c4`.
 */
async function start(author = 'octo-operator'): Promise<Ctx> {
  const host = new FakeGitHost();
  const daemon = await startAgentDaemon({
    fixtureKinds: false,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      ReposModule.forRoot(),
      WorkspaceModule.forRoot({ hosts: host }),
    ],
  });
  running.push(daemon);
  const store = daemon.app.get<Store>(STORE);
  store.write((tx) => {
    tx.update(connectors)
      .set({ status: HealthStatus.Ok, login: 'octo-operator' })
      .where(eq(connectors.id, ConnectorId.Github))
      .run();
  });
  const root = await tempDir('ops-console-pr-');
  const remote = path.join(root, 'remote.git');
  const dir = path.join(root, 'orders-api');
  await mkdir(dir, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Operator');
  git(dir, 'config', 'user.email', 'operator@example.com');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'checkout', '-q', '-b', 'feature-1');
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'app.ts'), 'export const rate = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'add the rate');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/orders-api.git');
  const http = api(daemon);
  const repoId = (await http.post('/repos', { path: dir })).body.data.id as string;
  // The Repo is on GitHub to the console; git reaches the bare repository.
  git(dir, 'remote', 'set-url', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main', 'feature-1');
  const head = git(dir, 'rev-parse', 'feature-1');
  host.prs = [hostPr(1, { author, branch: 'feature-1', head_sha: head })];
  const at = (minute: number) => `2026-11-01T10:0${minute}:00.000Z`;
  host.comments.set(1, [
    {
      id: 'c1',
      parent_id: null,
      author: 'reviewer',
      body: 'Read the rate from config.\nIt is hard-coded.',
      file_path: 'src/app.ts',
      line: 1,
      resolved: false,
      created_at: at(1),
    },
    {
      id: 'c2',
      parent_id: 'c1',
      author: 'octo-operator',
      body: 'Fixed in 33f8c2b2.',
      file_path: 'src/app.ts',
      line: 1,
      resolved: false,
      created_at: at(2),
    },
    {
      id: 'c3',
      parent_id: null,
      author: 'reviewer',
      body: 'Rename rate to taxRate.',
      file_path: 'src/app.ts',
      line: 1,
      resolved: false,
      created_at: at(3),
    },
    {
      id: 'c4',
      parent_id: null,
      author: 'reviewer',
      body: 'Nice work overall.',
      file_path: null,
      line: null,
      resolved: false,
      created_at: at(4),
    },
  ]);
  const { events } = await listen(daemon);
  return { daemon, host, repoId, dir, remote, head, store, http, events };
}

const verdict = (value: string, reply: string) => `\`\`\`json\n{ "verdict": "${value}", "reply": "${reply}" }\n\`\`\``;

const outcomes = (threads: { comment_id: string; outcome: string; reply: string }[]) =>
  `\`\`\`json\n${JSON.stringify({ threads })}\n\`\`\``;

const verdicts = (threads: { comment_id: string; verdict: string; reply: string }[]) =>
  `\`\`\`json\n${JSON.stringify({ threads })}\n\`\`\``;

const jobEnded = (ctx: Ctx, kind: 'reply_check' | 'comment_pass', id: string) =>
  until(
    () => ctx.events,
    (all) =>
      all.some(
        (event) =>
          event.event === 'pull_request.job_changed' &&
          event.data.kind === kind &&
          event.data.id === id &&
          event.data.status !== 'running',
      ),
    `${kind} ${id} to end`,
  );

const detail = async (ctx: Ctx) => (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1`)).body.data;

const thread = (ctx: Ctx, id: string) => ctx.host.comments.get(1)?.find((comment) => comment.id === id);

/** Scripts the runs in order. */
const script = (ctx: Ctx, runs: Step[][]) => {
  for (const run of runs) ctx.daemon.sdk.script(...run);
};

/** Writes `text` into a file of the scratch copy while the agent's `turn`-th run from now (from 0) runs. */
const editing = (ctx: Ctx, turn: number, file: string, text: string) => {
  const at = ctx.daemon.sdk.calls.length + turn;
  return (async () => {
    const cwd = await until(
      () => ctx.daemon.sdk.calls[at]?.options.cwd,
      (dir) => typeof dir === 'string' && dir.includes('pr-scratch'),
      'the agent to run in the scratch copy',
    );
    await writeFile(path.join(cwd as string, file), text);
  })();
};

/** The index of Address comments' step that changes the code, and the one that runs the tests. */
const IMPLEMENT = 3;
const TESTS = 4;

describe('Check reply', () => {
  it('checks the thread in a scratch copy at the head commit, posts the verdict, and resolves on fixed', async () => {
    const ctx = await start('colleague');
    const turns = stepTurns(PlaybookTrigger.CheckReply, {
      0: [stepAnswer('the thread asks for config')],
      2: [stepAnswer('src/app.ts still hard-codes it')],
    });
    script(ctx, turns);
    ctx.daemon.sdk.script({
      text: verdict('fixed', 'Checked src/app.ts at the head commit: the rate is read from config.'),
    });

    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({
      status: 'running',
      comment_id: 'c1',
      head_sha: ctx.head,
      playbook: { id: null, name: 'Check reply (built-in)' },
    });
    await jobEnded(ctx, 'reply_check', started.body.data.id);

    const [check] = (await detail(ctx)).reply_checks;
    expect(check).toMatchObject({ status: 'ready', verdict: 'fixed', resolved: true, can_retry: false });
    expect(check.playbook.steps.map((step: { status: string }) => step.status)).toEqual(turns.map(() => 'done'));
    const reply = ctx.host.posted.at(-1);
    expect(reply).toMatchObject({
      parent_id: 'c1',
      body: 'Checked src/app.ts at the head commit: the rate is read from config.',
    });
    expect(thread(ctx, 'c1')?.resolved).toBe(true);

    const calls = ctx.daemon.sdk.calls;
    const scratch = path.join(ctx.daemon.dataDir, 'pr-scratch', started.body.data.id);
    // Each step, then the closing turn.
    expect(calls.map((call) => call.options.cwd)).toEqual([...turns, 'closing'].map(() => scratch));
    // The agent cannot push, comment or resolve itself in any of its turns (Settled), and each turn carries the
    // built-in's rules.
    for (const call of calls) {
      expect(call.options.disallowedTools).toEqual(
        expect.arrayContaining(['Bash(git push:*)', 'Bash(gh pr comment:*)']),
      );
      expect((call.options.systemPrompt as { append: string }).append).toContain(BUILTIN_RULES.check_reply);
    }
    expect(calls[0]?.prompt).toContain(`at head commit ${ctx.head}`);
    expect(calls[0]?.prompt).toContain('octo-operator: Fixed in 33f8c2b2.');
    expect(existsSync(scratch)).toBe(false);
    expect(git(ctx.dir, 'branch', '--show-current')).toBe('main');

    const actions = ctx.store.db
      .select()
      .from(actionLog)
      .all()
      .map((row) => row.command);
    expect(actions).toEqual(expect.arrayContaining(['reply in thread c1', 'resolve thread c1']));
    const posted = (await detail(ctx)).comments.find((comment: { id: string }) => comment.id === reply?.id);
    expect(posted.by_agent).toBe(true);
  });

  it('leaves the thread open on not fixed, and checks again only after someone replies', async () => {
    const ctx = await start();
    script(ctx, stepTurns(PlaybookTrigger.CheckReply));
    ctx.daemon.sdk.script({ text: verdict('not_fixed', 'The rate is still hard-coded on line 1.') });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    await jobEnded(ctx, 'reply_check', started.body.data.id);
    expect(thread(ctx, 'c1')?.resolved).toBe(false);

    const again = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    expect([again.status, again.body.error.code]).toEqual([409, 'invalid_state']);

    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comments`, { body: 'Now it is.', parent_id: 'c1' });
    script(ctx, stepTurns(PlaybookTrigger.CheckReply));
    ctx.daemon.sdk.script({ text: verdict('partly_fixed', 'Read from config, but no default.') });
    const third = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    expect(third.status).toBe(202);
    await jobEnded(ctx, 'reply_check', third.body.data.id);
    const checks = (await detail(ctx)).reply_checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: third.body.data.id, verdict: 'partly_fixed', resolved: false });
  });

  it('refuses a thread it cannot check, and a pull request that is not open', async () => {
    const ctx = await start();
    const post = (comment_id: string) =>
      ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id });
    expect((await post('nope')).status).toBe(404);
    expect((await post('c2')).status).toBe(404);
    expect((await post('c4')).body.error.code).toBe('invalid_state');
    (thread(ctx, 'c3') as { resolved: boolean }).resolved = true;
    expect((await post('c3')).body.error.message).toBe('The thread is resolved');
    (ctx.host.prs[0] as { state: PrState }).state = PrState.Closed;
    expect((await post('c1')).body.error.message).toBe('The pull request is not open');
    expect(ctx.store.db.select().from(prReplyChecks).all()).toEqual([]);

    ctx.host.down = 'rate_limited';
    expect((await post('c1')).body.error.code).toBe('rate_limited');
  });

  it('fails a step with nothing posted and retries it in the kept scratch copy', async () => {
    const ctx = await start();
    const turns = stepTurns(PlaybookTrigger.CheckReply, { 1: [stepAnswer('the file is gone', 'failed')] });
    script(ctx, turns.slice(0, 2));
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    const id = started.body.data.id as string;
    await jobEnded(ctx, 'reply_check', id);
    const [failed] = (await detail(ctx)).reply_checks;
    expect(failed).toMatchObject({
      status: 'failed',
      can_retry: true,
      error: 'Step 2 · Prepare the code context failed: the file is gone',
    });
    expect(ctx.host.posted).toEqual([]);
    const scratch = path.join(ctx.daemon.dataDir, 'pr-scratch', id);
    expect(existsSync(scratch)).toBe(true);

    ctx.events.length = 0;
    script(ctx, stepTurns(PlaybookTrigger.CheckReply, { 1: [stepAnswer('read it now')] }).slice(1));
    ctx.daemon.sdk.script({ text: verdict('fixed', 'Done right.') });
    const retried = await ctx.http.post(`/reply-checks/${id}/retry`);
    expect(retried.status).toBe(202);
    await jobEnded(ctx, 'reply_check', id);
    const [ready] = (await detail(ctx)).reply_checks;
    expect(ready).toMatchObject({ status: 'ready', resolved: true });
    expect(ready.playbook.steps.map((step: { status: string }) => step.status)).toEqual(turns.map(() => 'done'));
    expect(ctx.daemon.sdk.calls.at(-2)?.options.cwd).toBe(scratch);
    expect(existsSync(scratch)).toBe(false);
    expect((await ctx.http.post(`/reply-checks/${id}/retry`)).body.error.code).toBe('invalid_state');
  });

  it('removes a failed Reply check’s scratch copy when a new one starts on the thread', async () => {
    const ctx = await start();
    script(ctx, stepTurns(PlaybookTrigger.CheckReply, { 1: [stepAnswer('cannot read', 'failed')] }).slice(0, 2));
    const first = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    await jobEnded(ctx, 'reply_check', first.body.data.id);
    const kept = path.join(ctx.daemon.dataDir, 'pr-scratch', first.body.data.id);
    expect(existsSync(kept)).toBe(true);

    script(ctx, stepTurns(PlaybookTrigger.CheckReply));
    ctx.daemon.sdk.script({ text: verdict('fixed', 'Fixed.') });
    const second = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    expect(existsSync(kept)).toBe(false);
    const earlier = ctx.store.db.select().from(prReplyChecks).where(eq(prReplyChecks.id, first.body.data.id)).get();
    expect(earlier).toMatchObject({ scratchPath: null, canRetry: false });
    await jobEnded(ctx, 'reply_check', second.body.data.id);
  });

  it('fails when the resolve fails, and a retry only resolves', async () => {
    const ctx = await start();
    ctx.host.failResolve = true;
    script(ctx, stepTurns(PlaybookTrigger.CheckReply));
    ctx.daemon.sdk.script({ text: verdict('fixed', 'Fixed.') });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    const id = started.body.data.id as string;
    await jobEnded(ctx, 'reply_check', id);
    const [failed] = (await detail(ctx)).reply_checks;
    expect(failed).toMatchObject({
      status: 'failed',
      can_retry: true,
      error: 'Could not resolve the thread: the host refused to resolve',
    });
    expect(ctx.host.posted).toHaveLength(1);

    ctx.host.failResolve = false;
    ctx.events.length = 0;
    const calls = ctx.daemon.sdk.calls.length;
    await ctx.http.post(`/reply-checks/${id}/retry`);
    await jobEnded(ctx, 'reply_check', id);
    expect((await detail(ctx)).reply_checks[0]).toMatchObject({ status: 'ready', resolved: true });
    expect(ctx.host.posted).toHaveLength(1);
    expect(ctx.daemon.sdk.calls.length).toBe(calls);
  });

  it('fails before step 1 when the head commit cannot be fetched, with no retry', async () => {
    const ctx = await start();
    (ctx.host.prs[0] as { head_sha: string }).head_sha = 'f'.repeat(40);
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    await jobEnded(ctx, 'reply_check', started.body.data.id);
    const [failed] = (await detail(ctx)).reply_checks;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^Could not make a scratch copy: /);
    expect(failed.can_retry).toBe(false);
    expect(failed.playbook.steps.map((step: { status: string }) => step.status)).toEqual(
      stepTurns(PlaybookTrigger.CheckReply).map(() => 'pending'),
    );
  });

  it('runs the Playbook Check reply holds, scratch copy steps included', async () => {
    const ctx = await start();
    const playbook = await ctx.http.post('/playbooks', {
      name: 'Run it',
      steps: [{ block: 'run_tests', title: 'Run the tests', instructions: 'Run them.', writes: true }],
    });
    await ctx.http.put('/playbook-triggers/check_reply', { playbook_id: playbook.body.data.id });
    ctx.daemon.sdk.script(stepAnswer('tests pass'));
    ctx.daemon.sdk.script({ text: verdict('fixed', 'Tests pass.') });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    expect(started.body.data.playbook).toMatchObject({
      name: 'Run it',
      steps: [{ title: 'Run the tests', writes: true }],
    });
    await jobEnded(ctx, 'reply_check', started.body.data.id);
    expect(ctx.daemon.sdk.calls.at(-2)?.prompt).toContain('You may write files and run local commands');
  });
});

describe('Skills on a job', () => {
  it("offers a Check reply the Playbook's Skills, as copied at the start, and shows them on the job (Behavior 10, 14)", async () => {
    const ctx = await start();
    const made = await ctx.http.post('/skills', {
      name: 'reply-method',
      description: 'Use when checking a reply.',
      instructions: 'Read the diff first.',
    });
    const playbook = await ctx.http.post('/playbooks', {
      name: 'With a Skill',
      steps: [{ block: 'run_tests', title: 'Run the tests', instructions: 'Run them.', writes: false }],
      skill_ids: [made.body.data.id],
    });
    await ctx.http.put('/playbook-triggers/check_reply', { playbook_id: playbook.body.data.id });
    ctx.daemon.sdk.script(stepAnswer('ok'));
    ctx.daemon.sdk.script({ text: verdict('fixed', 'Fine.') });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    expect(started.body.data.playbook.skills).toEqual([{ id: made.body.data.id, name: 'reply-method' }]);
    await jobEnded(ctx, 'reply_check', started.body.data.id);
    // The step turn and the closing turn both had the Skill.
    for (const call of ctx.daemon.sdk.calls.slice(-2)) {
      expect(call.options.skills).toEqual(['ops-console-skills:reply-method']);
    }

    // Deleting the Skill leaves the job's record of it, by name only.
    await ctx.http.delete(`/skills/${made.body.data.id}`);
    const [check] = (await detail(ctx)).reply_checks;
    expect(check.playbook.skills).toEqual([{ id: null, name: 'reply-method' }]);
  });
});

describe('Check replies', () => {
  /** A second replied thread, on the same line. */
  const secondReplied = (ctx: Ctx) => {
    ctx.host.comments.get(1)?.push(
      {
        id: 'c5',
        parent_id: null,
        author: 'reviewer',
        body: 'Add a test for the rate.',
        file_path: 'src/app.ts',
        line: 1,
        resolved: false,
        created_at: '2026-11-01T10:05:00.000Z',
      },
      {
        id: 'c6',
        parent_id: 'c5',
        author: 'colleague',
        body: 'Added one.',
        file_path: 'src/app.ts',
        line: 1,
        resolved: false,
        created_at: '2026-11-01T10:06:00.000Z',
      },
    );
  };

  it('checks every replied thread in one run, replies in each, resolves the fixed ones, and pushes nothing', async () => {
    const ctx = await start('colleague');
    secondReplied(ctx);
    const turns = stepTurns(PlaybookTrigger.CheckReply);
    script(ctx, turns);
    ctx.daemon.sdk.script({
      text: verdicts([
        { comment_id: 'c1', verdict: 'fixed', reply: 'The rate is read from config now.' },
        { comment_id: 'c5', verdict: 'not_fixed', reply: 'No test covers the rate yet.' },
      ]),
    });

    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-check-passes`);
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({
      kind: 'check',
      status: 'running',
      playbook: { name: 'Check reply (built-in)' },
    });
    // Only threads with a reply: c3 and the general comment c4 have none.
    expect(started.body.data.threads.map((item: { comment_id: string }) => item.comment_id)).toEqual(['c1', 'c5']);
    await jobEnded(ctx, 'comment_pass', started.body.data.id);

    const [pass] = (await detail(ctx)).comment_passes;
    expect(pass).toMatchObject({ kind: 'check', status: 'ready', commit_sha: null });
    expect(pass.threads).toMatchObject([
      { comment_id: 'c1', outcome: 'fixed', posted: true, resolved: true },
      { comment_id: 'c5', outcome: 'not_fixed', posted: true, resolved: false },
    ]);
    expect(ctx.host.posted.map((post) => [post.parent_id, post.body])).toEqual([
      ['c1', 'The rate is read from config now.'],
      ['c5', 'No test covers the rate yet.'],
    ]);
    expect(thread(ctx, 'c1')?.resolved).toBe(true);
    expect(thread(ctx, 'c5')?.resolved).toBe(false);
    // One run for both threads: each step once, then one closing turn.
    expect(ctx.daemon.sdk.calls).toHaveLength(turns.length + 1);
    expect(ctx.daemon.sdk.calls[0]?.prompt).toContain('[comment_id c1]');
    expect(ctx.daemon.sdk.calls[0]?.prompt).toContain('[comment_id c5]');
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(ctx.head);

    // Every replied thread now ends with the agent's reply: nothing is left to check.
    const again = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-check-passes`);
    expect([again.status, again.body.error.message]).toEqual([409, 'No open thread has a reply to check']);
  });

  it('refuses a pull request with no replied thread', async () => {
    const ctx = await start();
    ctx.host.comments.set(
      1,
      (ctx.host.comments.get(1) ?? []).filter((comment) => comment.id !== 'c2'),
    );
    const refused = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-check-passes`);
    expect([refused.status, refused.body.error.message]).toEqual([409, 'No open thread has a reply to check']);
  });
});

describe('Address comments', () => {
  it('changes the code for the ticked threads, pushes one commit, replies and resolves the done ones', async () => {
    const ctx = await start();
    script(
      ctx,
      stepTurns(PlaybookTrigger.AddressComments, {
        0: [stepAnswer('two threads')],
        [IMPLEMENT]: [
          { wait: editing(ctx, IMPLEMENT, 'src/app.ts', 'export const taxRate = 1;\n') },
          stepAnswer('renamed rate'),
        ],
        [TESTS]: [stepAnswer('tests pass')],
      }),
    );
    ctx.daemon.sdk.script({
      text: outcomes([
        { comment_id: 'c3', outcome: 'done', reply: 'Renamed rate to taxRate.' },
        { comment_id: 'c1', outcome: 'declined', reply: 'Config has no rate yet; that is a bigger change.' },
      ]),
    });

    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, {
      comment_ids: ['c1', 'c3'],
    });
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({
      status: 'running',
      head_sha: ctx.head,
      playbook: { name: 'Address comments (built-in)' },
      threads: [
        {
          comment_id: 'c1',
          file_path: 'src/app.ts',
          line: 1,
          author: 'reviewer',
          excerpt: 'Read the rate from config.',
        },
        { comment_id: 'c3', outcome: 'pending', posted: false },
      ],
    });
    await jobEnded(ctx, 'comment_pass', started.body.data.id);

    const [pass] = (await detail(ctx)).comment_passes;
    const pushed = git(ctx.remote, 'rev-parse', 'feature-1');
    expect(pass).toMatchObject({ status: 'ready', commit_sha: pushed, stale: false });
    expect(pushed).not.toBe(ctx.head);
    expect(git(ctx.remote, 'log', '-1', '--format=%B', 'feature-1')).toBe(
      'Address review comments on #1\n\n- src/app.ts:1',
    );
    expect(git(ctx.remote, 'show', 'feature-1:src/app.ts')).toBe('export const taxRate = 1;');
    expect(git(ctx.remote, 'rev-parse', 'feature-1~1')).toBe(ctx.head);
    expect(
      pass.threads.map((t: { comment_id: string; outcome: string; posted: boolean; resolved: boolean }) => [
        t.comment_id,
        t.outcome,
        t.posted,
        t.resolved,
      ]),
    ).toEqual([
      ['c1', 'declined', true, false],
      ['c3', 'done', true, true],
    ]);
    expect(ctx.host.posted.map((post) => [post.parent_id, post.body])).toEqual([
      ['c1', 'Config has no rate yet; that is a bigger change.'],
      ['c3', `Done in ${pushed.slice(0, 7)}. Renamed rate to taxRate.`],
    ]);
    expect([thread(ctx, 'c1')?.resolved, thread(ctx, 'c3')?.resolved]).toEqual([false, true]);
    expect(ctx.daemon.sdk.calls[0]?.prompt).toContain('[comment_id c3] on src/app.ts:1');
    expect(existsSync(path.join(ctx.daemon.dataDir, 'pr-scratch', pass.id))).toBe(false);
    // The pass is not stale at its own commit, only once the head moves past it.
    (ctx.host.prs[0] as { head_sha: string }).head_sha = pushed;
    ctx.daemon.app.get(PullRequestsService).drop(ctx.repoId);
    expect((await detail(ctx)).comment_passes[0].stale).toBe(false);
    (ctx.host.prs[0] as { head_sha: string }).head_sha = 'a-later-commit';
    ctx.daemon.app.get(PullRequestsService).drop(ctx.repoId);
    expect((await detail(ctx)).comment_passes[0].stale).toBe(true);
    // The operator's checkout is untouched.
    expect(git(ctx.dir, 'branch', '--show-current')).toBe('main');
    expect(git(ctx.dir, 'status', '--porcelain')).toBe('');
  });

  it('works on someone else’s pull request and a general comment: pushes, replies, and resolves only the line thread', async () => {
    const ctx = await start('colleague');
    script(
      ctx,
      stepTurns(PlaybookTrigger.AddressComments, {
        [IMPLEMENT]: [
          { wait: editing(ctx, IMPLEMENT, 'src/app.ts', 'export const taxRate = 1;\n') },
          stepAnswer('renamed rate'),
        ],
      }),
    );
    ctx.daemon.sdk.script({
      text: outcomes([
        { comment_id: 'c3', outcome: 'done', reply: 'Renamed rate to taxRate.' },
        { comment_id: 'c4', outcome: 'done', reply: 'Thanks; renamed the rate too.' },
      ]),
    });

    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, {
      comment_ids: ['c3', 'c4'],
    });
    expect(started.status).toBe(202);
    expect(started.body.data.threads[1]).toMatchObject({ comment_id: 'c4', file_path: null, line: null });
    await jobEnded(ctx, 'comment_pass', started.body.data.id);

    const [pass] = (await detail(ctx)).comment_passes;
    const pushed = git(ctx.remote, 'rev-parse', 'feature-1');
    expect(pass).toMatchObject({ status: 'ready', commit_sha: pushed });
    expect(git(ctx.remote, 'log', '-1', '--format=%B', 'feature-1')).toBe(
      "Address review comments on #1\n\n- src/app.ts:1\n- reviewer's comment on the pull request",
    );
    expect(ctx.host.posted.map((post) => post.parent_id)).toEqual(['c3', 'c4']);
    expect([thread(ctx, 'c3')?.resolved, thread(ctx, 'c4')?.resolved]).toEqual([true, false]);
    expect(pass.threads.map((t: { resolved: boolean }) => t.resolved)).toEqual([true, false]);
    expect(ctx.daemon.sdk.calls[0]?.prompt).toContain('[comment_id c4] on the pull request');
  });

  it('refuses a thread it cannot take, and none ticked', async () => {
    const ctx = await start();
    const post = (comment_ids: string[]) =>
      ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids });
    expect((await post([])).body.error.code).toBe('validation_failed');
    expect((await post(['c2'])).body.error.code).toBe('validation_failed');
    (thread(ctx, 'c1') as { resolved: boolean }).resolved = true;
    expect((await post(['c1'])).body.error.code).toBe('validation_failed');
    ctx.host.down = 'failed';
    expect((await post(['c3'])).body.error.code).toBe('upstream_failed');
    expect(ctx.store.db.select().from(prCommentPasses).all()).toEqual([]);
  });

  it('makes no commit when every thread is declined, and still replies', async () => {
    const ctx = await start();
    script(
      ctx,
      stepTurns(PlaybookTrigger.AddressComments, {
        [IMPLEMENT]: [stepAnswer('nothing', 'skipped')],
        [TESTS]: [stepAnswer('-', 'skipped')],
      }),
    );
    ctx.daemon.sdk.script({
      text: outcomes([{ comment_id: 'c3', outcome: 'declined', reply: 'rate is the name the API uses.' }]),
    });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids: ['c3'] });
    await jobEnded(ctx, 'comment_pass', started.body.data.id);
    const [pass] = (await detail(ctx)).comment_passes;
    expect(pass).toMatchObject({ status: 'ready', commit_sha: null });
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(ctx.head);
    expect(ctx.host.posted.map((post) => post.body)).toEqual(['rate is the name the API uses.']);
    expect(thread(ctx, 'c3')?.resolved).toBe(false);
  });

  it('fails with nothing pushed when the run rewrote the scratch copy’s .git, and offers no retry', async () => {
    const ctx = await start();
    const before = git(ctx.remote, 'rev-parse', 'feature-1');
    const other = path.join(path.dirname(ctx.dir), 'planted');
    await mkdir(other);
    git(other, 'init', '-q');

    // The step edits a file, as the pass expects, and also points the scratch copy's gitfile at a repository of its own.
    const tampering = editing(ctx, IMPLEMENT, 'src/app.ts', 'export const taxRate = 1;\n').then(async () => {
      const cwd = ctx.daemon.sdk.calls.at(-1)?.options.cwd as string;
      await writeFile(path.join(cwd, '.git'), `gitdir: ${path.join(other, '.git')}\n`);
    });
    script(
      ctx,
      stepTurns(PlaybookTrigger.AddressComments, { [IMPLEMENT]: [{ wait: tampering }, stepAnswer('renamed')] }),
    );
    ctx.daemon.sdk.script({ text: outcomes([{ comment_id: 'c3', outcome: 'done', reply: 'Renamed.' }]) });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids: ['c3'] });
    await jobEnded(ctx, 'comment_pass', started.body.data.id);

    const [pass] = (await detail(ctx)).comment_passes;
    expect(pass).toMatchObject({ status: 'failed', can_retry: false });
    expect(pass.error).toContain('the scratch copy was changed outside the console');
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(before);
    expect(ctx.host.posted).toEqual([]);
  });

  const teammatePushes = async (ctx: Awaited<ReturnType<typeof start>>, file: string, text: string) => {
    git(ctx.dir, 'checkout', '-q', 'feature-1');
    await writeFile(path.join(ctx.dir, file), text);
    git(ctx.dir, 'add', '.');
    git(ctx.dir, 'commit', '-q', '-m', 'teammate');
    git(ctx.dir, 'push', '-q', 'origin', 'feature-1');
    git(ctx.dir, 'checkout', '-q', 'main');
    return git(ctx.remote, 'rev-parse', 'feature-1');
  };

  it('catches up with a branch that moved and pushes on top of it, without force (19)', async () => {
    const ctx = await start();
    const moved = await teammatePushes(ctx, 'NOTES.md', 'a teammate pushed\n');

    script(
      ctx,
      stepTurns(PlaybookTrigger.AddressComments, {
        [IMPLEMENT]: [
          { wait: editing(ctx, IMPLEMENT, 'src/app.ts', 'export const taxRate = 1;\n') },
          stepAnswer('renamed'),
        ],
      }),
    );
    ctx.daemon.sdk.script({ text: outcomes([{ comment_id: 'c3', outcome: 'done', reply: 'Renamed.' }]) });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids: ['c3'] });
    await jobEnded(ctx, 'comment_pass', started.body.data.id);
    const [pass] = (await detail(ctx)).comment_passes;
    const pushed = git(ctx.remote, 'rev-parse', 'feature-1');
    expect(pass).toMatchObject({ status: 'ready', commit_sha: pushed });
    expect(pushed).not.toBe(moved);
    // The teammate's commit is the parent: nothing was dropped.
    expect(git(ctx.remote, 'rev-parse', 'feature-1~1')).toBe(moved);
    expect(git(ctx.remote, 'show', 'feature-1:NOTES.md')).toBe('a teammate pushed');
    expect(git(ctx.remote, 'show', 'feature-1:src/app.ts')).toBe('export const taxRate = 1;');
    expect(ctx.host.posted.length).toBeGreaterThan(0);
  });

  it('fails with nothing posted when the branch moved onto the same lines, and offers no retry (19)', async () => {
    const ctx = await start();
    const moved = await teammatePushes(ctx, 'src/app.ts', 'export const taxRate = 7;\n');

    script(
      ctx,
      stepTurns(PlaybookTrigger.AddressComments, {
        [IMPLEMENT]: [
          { wait: editing(ctx, IMPLEMENT, 'src/app.ts', 'export const taxRate = 1;\n') },
          stepAnswer('renamed'),
        ],
      }),
    );
    ctx.daemon.sdk.script({ text: outcomes([{ comment_id: 'c3', outcome: 'done', reply: 'Renamed.' }]) });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids: ['c3'] });
    await jobEnded(ctx, 'comment_pass', started.body.data.id);
    const [pass] = (await detail(ctx)).comment_passes;
    expect(pass).toMatchObject({
      status: 'failed',
      error: 'The branch moved; run Address comments again.',
      can_retry: false,
    });
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(moved);
    expect(ctx.host.posted).toEqual([]);
  });

  it('after a push, a failed reply fails the pass, and a retry posts only what is left without pushing again', async () => {
    const ctx = await start();
    ctx.host.failPosts = (comment) => comment.parent_id === 'c1';
    script(
      ctx,
      stepTurns(PlaybookTrigger.AddressComments, {
        [IMPLEMENT]: [
          { wait: editing(ctx, IMPLEMENT, 'src/app.ts', 'export const taxRate = 2;\n') },
          stepAnswer('done'),
        ],
      }),
    );
    ctx.daemon.sdk.script({
      text: outcomes([
        { comment_id: 'c1', outcome: 'done', reply: 'Reads config now.' },
        { comment_id: 'c3', outcome: 'done', reply: 'Renamed.' },
      ]),
    });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, {
      comment_ids: ['c1', 'c3'],
    });
    const id = started.body.data.id as string;
    await jobEnded(ctx, 'comment_pass', id);
    const [failed] = (await detail(ctx)).comment_passes;
    const pushed = git(ctx.remote, 'rev-parse', 'feature-1');
    expect(failed).toMatchObject({
      status: 'failed',
      can_retry: true,
      commit_sha: pushed,
      error: 'Could not post or resolve 1 thread: the host refused the comment',
    });
    expect(failed.threads.map((t: { posted: boolean; resolved: boolean }) => [t.posted, t.resolved])).toEqual([
      [false, false],
      [true, true],
    ]);

    ctx.host.failPosts = null;
    ctx.events.length = 0;
    const calls = ctx.daemon.sdk.calls.length;
    await ctx.http.post(`/comment-passes/${id}/retry`);
    await jobEnded(ctx, 'comment_pass', id);
    const [ready] = (await detail(ctx)).comment_passes;
    expect(ready).toMatchObject({ status: 'ready', commit_sha: pushed });
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(pushed);
    expect(ctx.host.posted.map((post) => post.parent_id).sort()).toEqual(['c1', 'c3']);
    expect([thread(ctx, 'c1')?.resolved, thread(ctx, 'c3')?.resolved]).toEqual([true, true]);
    expect(ctx.daemon.sdk.calls.length).toBe(calls);
  });

  it('fails a step with nothing pushed, and retries from it', async () => {
    const ctx = await start();
    const failing = stepTurns(PlaybookTrigger.AddressComments, { [IMPLEMENT]: [stepAnswer('cannot build', 'failed')] });
    script(ctx, failing.slice(0, IMPLEMENT + 1));
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids: ['c3'] });
    const id = started.body.data.id as string;
    await jobEnded(ctx, 'comment_pass', id);
    expect((await detail(ctx)).comment_passes[0]).toMatchObject({
      status: 'failed',
      can_retry: true,
      error: 'Step 4 · Implement the agreed changes failed: cannot build',
    });
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(ctx.head);

    ctx.events.length = 0;
    script(
      ctx,
      stepTurns(PlaybookTrigger.AddressComments, {
        // The retry's first run is the failed step.
        [IMPLEMENT]: [{ wait: editing(ctx, 0, 'src/app.ts', 'export const taxRate = 1;\n') }, stepAnswer('ok')],
      }).slice(IMPLEMENT),
    );
    ctx.daemon.sdk.script({ text: outcomes([{ comment_id: 'c3', outcome: 'done', reply: 'Renamed.' }]) });
    await ctx.http.post(`/comment-passes/${id}/retry`);
    await jobEnded(ctx, 'comment_pass', id);
    const [ready] = (await detail(ctx)).comment_passes;
    expect(ready.status).toBe('ready');
    expect(ready.playbook.steps.map((step: { status: string }) => step.status)).toEqual(failing.map(() => 'done'));
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(ready.commit_sha);
  });
});

describe('Skip step', () => {
  it('marks the failed step skipped by the operator and finishes the Comment pass from the next step', async () => {
    const ctx = await start();
    const turns = stepTurns(PlaybookTrigger.AddressComments, {
      0: [stepAnswer('read')],
      [IMPLEMENT]: [{ wait: editing(ctx, IMPLEMENT, 'src/app.ts', 'export const taxRate = 1;\n') }, stepAnswer('ok')],
      [TESTS]: [stepAnswer('no test runner', 'failed')],
    });
    script(ctx, turns.slice(0, TESTS + 1));
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids: ['c3'] });
    const id = started.body.data.id as string;
    await jobEnded(ctx, 'comment_pass', id);
    expect((await detail(ctx)).comment_passes[0].error).toBe('Step 5 · Run the tests failed: no test runner');

    ctx.events.length = 0;
    script(ctx, turns.slice(TESTS + 1));
    ctx.daemon.sdk.script({ text: outcomes([{ comment_id: 'c3', outcome: 'done', reply: 'Renamed.' }]) });
    expect((await ctx.http.post(`/comment-passes/${id}/retry`, { skip: true })).status).toBe(202);
    await jobEnded(ctx, 'comment_pass', id);
    const [ready] = (await detail(ctx)).comment_passes;
    expect(ready.status).toBe('ready');
    expect(
      ready.playbook.steps.map((step: { status: string; summary: string }) => [step.status, step.summary]),
    ).toEqual(
      turns.map((_turn, index) =>
        index === TESTS
          ? ['skipped', 'Skipped by the operator: no test runner']
          : ['done', index === 0 ? 'read' : 'ok'],
      ),
    );
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(ready.commit_sha);
    expect((await ctx.http.post(`/comment-passes/${id}/retry`, { skip: true })).body.error.code).toBe('invalid_state');
  });

  it('refuses to skip when the job failed outside its steps', async () => {
    const ctx = await start();
    script(ctx, stepTurns(PlaybookTrigger.CheckReply));
    ctx.daemon.sdk.script({ text: 'no verdict here' });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    await jobEnded(ctx, 'reply_check', started.body.data.id);
    const skipped = await ctx.http.post(`/reply-checks/${started.body.data.id}/retry`, { skip: true });
    expect([skipped.status, skipped.body.error.message]).toEqual([409, 'No step failed, so there is no step to skip']);
    expect((await detail(ctx)).reply_checks[0].status).toBe('failed');
  });
});

describe('Stop', () => {
  it('stops a Comment pass in a step and a Reply check in its closing turn; both fail with nothing posted and can retry', async () => {
    const ctx = await start();
    const firstStep = gate();
    ctx.daemon.sdk.script({ wait: firstStep.promise }, stepAnswer('read'));
    const pass = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids: ['c3'] });
    const passId = pass.body.data.id as string;
    await until(
      () => ctx.daemon.sdk.calls.length,
      (count) => count > 0,
      'the first step to start',
    );
    const session = (await detail(ctx)).agent_session_id as string;
    expect((await ctx.http.post(`/sessions/${session}/stop`, {})).status).toBe(204);
    await jobEnded(ctx, 'comment_pass', passId);
    expect((await detail(ctx)).comment_passes[0]).toMatchObject({
      status: 'failed',
      can_retry: true,
      error: 'Step 1 · Read the selected threads failed: stopped by the operator',
    });
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(ctx.head);

    const closing = gate();
    const steps = stepTurns(PlaybookTrigger.CheckReply);
    script(ctx, steps);
    ctx.daemon.sdk.script({ wait: closing.promise }, { text: verdict('fixed', 'Fixed.') });
    const before = ctx.daemon.sdk.calls.length;
    const check = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    await until(
      () => ctx.daemon.sdk.calls.length,
      (count) => count > before + steps.length,
      'the closing turn to start',
    );
    expect((await ctx.http.post(`/sessions/${session}/stop`, {})).status).toBe(204);
    await jobEnded(ctx, 'reply_check', check.body.data.id);
    expect((await detail(ctx)).reply_checks[0]).toMatchObject({
      status: 'failed',
      can_retry: true,
      error: 'The verdict was not given: stopped by the operator',
    });
    expect(ctx.host.posted).toEqual([]);
  });
});

describe('One job per pull request', () => {
  it('refuses every other job while one runs, and the Agent Review too', async () => {
    const ctx = await start();
    const hold = gate();
    script(ctx, stepTurns(PlaybookTrigger.CheckReply, { 0: [{ wait: hold.promise }, stepAnswer('read')] }));
    ctx.daemon.sdk.script({ text: verdict('fixed', 'Fixed.') });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    await until(
      () => ctx.daemon.sdk.calls.length,
      (count) => count > 0,
      'the first step to start',
    );
    const busy = [
      await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c3' }),
      await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids: ['c3'] }),
      await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`),
    ];
    expect(busy.map((res) => [res.status, res.body.error.code, res.body.error.message])).toEqual([
      [409, 'session_busy', 'The agent is working on this PR'],
      [409, 'session_busy', 'The agent is working on this PR'],
      [409, 'session_busy', 'The agent is working on this PR'],
    ]);
    hold.open();
    await jobEnded(ctx, 'reply_check', started.body.data.id);
  });
});

describe('Reply in thread', () => {
  it('waits for a running job to end, then answers, and the job is not disturbed', async () => {
    const ctx = await start();
    ctx.host.comments.get(1)?.push({
      id: 'c9',
      parent_id: null,
      author: 'octo-operator',
      body: '**nit**: name the constant.',
      file_path: 'src/app.ts',
      line: 1,
      resolved: false,
      created_at: '2026-11-01T10:09:00.000Z',
    });
    ctx.store.write((tx) => {
      tx.insert(agentComments).values({ repoId: ctx.repoId, prNumber: 1, commentId: 'c9', agentReviewId: null }).run();
    });
    const hold = gate();
    script(ctx, stepTurns(PlaybookTrigger.CheckReply, { 0: [{ wait: hold.promise }, stepAnswer('read')] }));
    ctx.daemon.sdk.script({ text: verdict('not_fixed', 'Still hard-coded.') });
    ctx.daemon.sdk.script({ text: 'Done: I named it TAX_RATE.' });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    await until(
      () => ctx.daemon.sdk.calls.length,
      (count) => count > 0,
      'the first step to start',
    );
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comments`, { body: 'Which name?', parent_id: 'c9' });
    hold.open();
    await jobEnded(ctx, 'reply_check', started.body.data.id);
    expect((await detail(ctx)).reply_checks[0]).toMatchObject({ status: 'ready', verdict: 'not_fixed' });
    await until(
      () => ctx.host.posted.filter((post) => post.parent_id === 'c9').map((post) => post.body),
      (bodies) => bodies.includes('Done: I named it TAX_RATE.'),
      'the thread answer',
    );
  });
});

describe('Restart', () => {
  it('fails a job left running as interrupted, keeps failed jobs’ scratch copies and removes the rest', async () => {
    const ctx = await start();
    const folder = path.join(ctx.daemon.dataDir, 'pr-scratch');
    const kept = path.join(folder, 'left-running');
    const done = path.join(folder, 'was-ready');
    const stray = path.join(folder, 'stray');
    for (const dir of [kept, done, stray]) await mkdir(dir, { recursive: true });
    ctx.store.write((tx) => {
      tx.insert(prReplyChecks)
        .values([
          {
            id: 'left-running',
            repoId: ctx.repoId,
            prNumber: 1,
            commentId: 'c1',
            headSha: ctx.head,
            scratchPath: kept,
          },
          {
            id: 'was-ready',
            repoId: ctx.repoId,
            prNumber: 1,
            commentId: 'c3',
            headSha: ctx.head,
            status: 'ready' as never,
            scratchPath: done,
          },
        ])
        .run();
    });
    await ctx.daemon.app.get(StartupRecovery).runAll();
    const rows = ctx.store.db.select().from(prReplyChecks).all();
    expect(rows.find((row) => row.id === 'left-running')).toMatchObject({
      status: 'failed',
      error: 'interrupted',
      canRetry: true,
      scratchPath: kept,
    });
    expect(rows.find((row) => row.id === 'was-ready')?.scratchPath).toBeNull();
    // The copies go after recovery ends, so a large one never holds up start-up.
    await until(
      () => [existsSync(kept), existsSync(done), existsSync(stray)],
      (exists) => exists.join() === 'true,false,false',
      'the copies to be removed',
    );
  });
});
