import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectorId, HealthStatus, PrState, type WsEvent } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { StartupRecovery } from '../src/common/recovery';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { actionLog, agentComments, connectors, prCommentPasses, prReplyChecks } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { ReposModule } from '../src/repos/repos.module';
import { PullRequestsService } from '../src/workspace/pull-requests.service';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, gate, listen, startAgentDaemon, until } from './agent-fixtures';
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
 * request #1 from `feature-1`, by `author`, with two threads on a line: `c1` (answered by `c2`) and `c3`.
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

const outcome = (summary: string, status = 'done') =>
  `\`\`\`json\n{ "outcome": "${status}", "summary": "${summary}" }\n\`\`\``;

const verdict = (value: string, reply: string) => `\`\`\`json\n{ "verdict": "${value}", "reply": "${reply}" }\n\`\`\``;

const outcomes = (threads: { comment_id: string; outcome: string; reply: string }[]) =>
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

/** Writes `text` into a file of the scratch copy while the agent's step runs. */
const editing = (ctx: Ctx, file: string, text: string) =>
  (async () => {
    const cwd = await until(
      () => ctx.daemon.sdk.calls.at(-1)?.options.cwd,
      (dir) => typeof dir === 'string' && dir.includes('pr-scratch'),
      'the agent to run in the scratch copy',
    );
    await writeFile(path.join(cwd as string, file), text);
  })();

describe('Check reply', () => {
  it('checks the thread in a scratch copy at the head commit, posts the verdict, and resolves on fixed', async () => {
    const ctx = await start('colleague');
    ctx.daemon.sdk.script({ text: outcome('the thread asks for config') });
    ctx.daemon.sdk.script({ text: outcome('src/app.ts still hard-codes it') });
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
    expect(check.playbook.steps.map((step: { status: string }) => step.status)).toEqual(['done', 'done']);
    const reply = ctx.host.posted.at(-1);
    expect(reply).toMatchObject({
      parent_id: 'c1',
      body: 'Checked src/app.ts at the head commit: the rate is read from config.',
    });
    expect(thread(ctx, 'c1')?.resolved).toBe(true);

    const calls = ctx.daemon.sdk.calls.slice(-3);
    const scratch = path.join(ctx.daemon.dataDir, 'pr-scratch', started.body.data.id);
    expect(calls.map((call) => call.options.cwd)).toEqual([scratch, scratch, scratch]);
    // The agent cannot push, comment or resolve itself in any of its turns (Settled).
    for (const call of calls)
      expect(call.options.disallowedTools).toEqual(
        expect.arrayContaining(['Bash(git push:*)', 'Bash(gh pr comment:*)']),
      );
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
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ text: verdict('not_fixed', 'The rate is still hard-coded on line 1.') });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    await jobEnded(ctx, 'reply_check', started.body.data.id);
    expect(thread(ctx, 'c1')?.resolved).toBe(false);

    const again = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    expect([again.status, again.body.error.code]).toEqual([409, 'invalid_state']);

    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comments`, { body: 'Now it is.', parent_id: 'c1' });
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('read') });
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
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('the file is gone', 'failed') });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    const id = started.body.data.id as string;
    await jobEnded(ctx, 'reply_check', id);
    const [failed] = (await detail(ctx)).reply_checks;
    expect(failed).toMatchObject({
      status: 'failed',
      can_retry: true,
      error: 'Step 2 · Read the code now failed: the file is gone',
    });
    expect(ctx.host.posted).toEqual([]);
    const scratch = path.join(ctx.daemon.dataDir, 'pr-scratch', id);
    expect(existsSync(scratch)).toBe(true);

    ctx.events.length = 0;
    ctx.daemon.sdk.script({ text: outcome('read it now') });
    ctx.daemon.sdk.script({ text: verdict('fixed', 'Done right.') });
    const retried = await ctx.http.post(`/reply-checks/${id}/retry`);
    expect(retried.status).toBe(202);
    await jobEnded(ctx, 'reply_check', id);
    const [ready] = (await detail(ctx)).reply_checks;
    expect(ready).toMatchObject({ status: 'ready', resolved: true });
    expect(ready.playbook.steps.map((step: { status: string }) => step.status)).toEqual(['done', 'done']);
    expect(ctx.daemon.sdk.calls.at(-2)?.options.cwd).toBe(scratch);
    expect(existsSync(scratch)).toBe(false);
    expect((await ctx.http.post(`/reply-checks/${id}/retry`)).body.error.code).toBe('invalid_state');
  });

  it('removes a failed Reply check’s scratch copy when a new one starts on the thread', async () => {
    const ctx = await start();
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('cannot read', 'failed') });
    const first = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    await jobEnded(ctx, 'reply_check', first.body.data.id);
    const kept = path.join(ctx.daemon.dataDir, 'pr-scratch', first.body.data.id);
    expect(existsSync(kept)).toBe(true);

    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('read') });
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
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('read') });
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
    expect(failed.playbook.steps.map((step: { status: string }) => step.status)).toEqual(['pending', 'pending']);
  });

  it('runs the Playbook Check reply holds, scratch copy steps included', async () => {
    const ctx = await start();
    const playbook = await ctx.http.post('/playbooks', {
      name: 'Run it',
      steps: [{ block: 'run_tests', title: 'Run the tests', instructions: 'Run them.', writes: true }],
    });
    await ctx.http.put('/playbook-triggers/check_reply', { playbook_id: playbook.body.data.id });
    ctx.daemon.sdk.script({ text: outcome('tests pass') });
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

describe('Address comments', () => {
  it('changes the code for the ticked threads, pushes one commit, replies and resolves the done ones', async () => {
    const ctx = await start();
    ctx.daemon.sdk.script({ text: outcome('two threads') });
    ctx.daemon.sdk.script(
      { wait: editing(ctx, 'src/app.ts', 'export const taxRate = 1;\n') },
      { text: outcome('renamed rate') },
    );
    ctx.daemon.sdk.script({ text: outcome('tests pass') });
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
    expect(ctx.daemon.sdk.calls.at(-4)?.prompt).toContain('[comment_id c3] on src/app.ts:1');
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

  it('refuses someone else’s pull request, a thread it cannot take, and none ticked', async () => {
    const ctx = await start('colleague');
    const post = (comment_ids: string[]) =>
      ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids });
    expect((await post(['c1'])).body.error.message).toBe('Address comments works only on your own pull requests');
    (ctx.host.prs[0] as { author: string }).author = 'octo-operator';
    expect((await post([])).body.error.code).toBe('validation_failed');
    expect((await post(['c4'])).body.error.code).toBe('validation_failed');
    expect((await post(['c2'])).body.error.code).toBe('validation_failed');
    ctx.host.down = 'failed';
    expect((await post(['c3'])).body.error.code).toBe('upstream_failed');
    expect(ctx.store.db.select().from(prCommentPasses).all()).toEqual([]);
  });

  it('makes no commit when every thread is declined, and still replies', async () => {
    const ctx = await start();
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('nothing', 'skipped') });
    ctx.daemon.sdk.script({ text: outcome('-', 'skipped') });
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

  it('fails with nothing posted when the branch moved, and offers no retry', async () => {
    const ctx = await start();
    git(ctx.dir, 'checkout', '-q', 'feature-1');
    await writeFile(path.join(ctx.dir, 'NOTES.md'), 'a teammate pushed\n');
    git(ctx.dir, 'add', '.');
    git(ctx.dir, 'commit', '-q', '-m', 'teammate');
    git(ctx.dir, 'push', '-q', 'origin', 'feature-1');
    git(ctx.dir, 'checkout', '-q', 'main');
    const moved = git(ctx.remote, 'rev-parse', 'feature-1');

    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script(
      { wait: editing(ctx, 'src/app.ts', 'export const taxRate = 1;\n') },
      { text: outcome('renamed') },
    );
    ctx.daemon.sdk.script({ text: outcome('pass') });
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
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script(
      { wait: editing(ctx, 'src/app.ts', 'export const taxRate = 2;\n') },
      { text: outcome('done') },
    );
    ctx.daemon.sdk.script({ text: outcome('pass') });
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
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('cannot build', 'failed') });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids: ['c3'] });
    const id = started.body.data.id as string;
    await jobEnded(ctx, 'comment_pass', id);
    expect((await detail(ctx)).comment_passes[0]).toMatchObject({
      status: 'failed',
      can_retry: true,
      error: 'Step 2 · Make the changes failed: cannot build',
    });
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(ctx.head);

    ctx.events.length = 0;
    ctx.daemon.sdk.script({ wait: editing(ctx, 'src/app.ts', 'export const taxRate = 1;\n') }, { text: outcome('ok') });
    ctx.daemon.sdk.script({ text: outcome('pass') });
    ctx.daemon.sdk.script({ text: outcomes([{ comment_id: 'c3', outcome: 'done', reply: 'Renamed.' }]) });
    await ctx.http.post(`/comment-passes/${id}/retry`);
    await jobEnded(ctx, 'comment_pass', id);
    const [ready] = (await detail(ctx)).comment_passes;
    expect(ready.status).toBe('ready');
    expect(ready.playbook.steps.map((step: { status: string }) => step.status)).toEqual(['done', 'done', 'done']);
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(ready.commit_sha);
  });
});

describe('Skip step', () => {
  it('marks the failed step skipped by the operator and finishes the Comment pass from the next step', async () => {
    const ctx = await start();
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ wait: editing(ctx, 'src/app.ts', 'export const taxRate = 1;\n') }, { text: outcome('ok') });
    ctx.daemon.sdk.script({ text: outcome('no test runner', 'failed') });
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comment-passes`, { comment_ids: ['c3'] });
    const id = started.body.data.id as string;
    await jobEnded(ctx, 'comment_pass', id);
    expect((await detail(ctx)).comment_passes[0].error).toBe('Step 3 · Run the tests failed: no test runner');

    ctx.events.length = 0;
    ctx.daemon.sdk.script({ text: outcomes([{ comment_id: 'c3', outcome: 'done', reply: 'Renamed.' }]) });
    expect((await ctx.http.post(`/comment-passes/${id}/retry`, { skip: true })).status).toBe(202);
    await jobEnded(ctx, 'comment_pass', id);
    const [ready] = (await detail(ctx)).comment_passes;
    expect(ready.status).toBe('ready');
    expect(
      ready.playbook.steps.map((step: { status: string; summary: string }) => [step.status, step.summary]),
    ).toEqual([
      ['done', 'read'],
      ['done', 'ok'],
      ['skipped', 'Skipped by the operator: no test runner'],
    ]);
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(ready.commit_sha);
    expect((await ctx.http.post(`/comment-passes/${id}/retry`, { skip: true })).body.error.code).toBe('invalid_state');
  });

  it('refuses to skip when the job failed outside its steps', async () => {
    const ctx = await start();
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('read') });
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
    ctx.daemon.sdk.script({ wait: firstStep.promise }, { text: outcome('read') });
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
      error: 'Step 1 · Read the threads failed: stopped by the operator',
    });
    expect(git(ctx.remote, 'rev-parse', 'feature-1')).toBe(ctx.head);

    const closing = gate();
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('read') });
    ctx.daemon.sdk.script({ wait: closing.promise }, { text: verdict('fixed', 'Fixed.') });
    const check = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reply-checks`, { comment_id: 'c1' });
    await until(
      () => ctx.daemon.sdk.calls.length,
      (count) => count > 3,
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
    ctx.daemon.sdk.script({ wait: hold.promise }, { text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('read') });
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
    ctx.daemon.sdk.script({ wait: hold.promise }, { text: outcome('read') });
    ctx.daemon.sdk.script({ text: outcome('read') });
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
    expect([existsSync(kept), existsSync(done), existsSync(stray)]).toEqual([true, false, false]);
  });
});
