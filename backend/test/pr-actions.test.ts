import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectorId, HealthStatus, PrState, type WsEvent } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { actionLog, connectors, prAgentReviews } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { ReposModule } from '../src/repos/repos.module';
import { PrActionsService } from '../src/workspace/pr-actions.service';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, listen, startAgentDaemon, until } from './agent-fixtures';
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

const at = (ctx: Ctx) => `/repos/${ctx.repoId}/pull-requests/1`;

const detail = async (ctx: Ctx) => (await ctx.http.get(at(ctx))).body.data;

const thread = (ctx: Ctx, id: string) => ctx.host.comments.get(1)?.find((comment) => comment.id === id);

/** Presses a button: the Session opens and its opening turn runs to the end. */
async function press(ctx: Ctx, body: Record<string, unknown>) {
  ctx.daemon.sdk.script({ text: 'Working on it.' });
  const started = await ctx.http.post(`${at(ctx)}/action-sessions`, body);
  if (started.status !== 201) return started;
  const id = started.body.data.id as string;
  await until(
    async () => (await detail(ctx)).action_sessions.find((s: { session_id: string }) => s.session_id === id),
    (found) => found?.state === 'not_submitted',
    'the opening turn to end',
  );
  return started;
}

const submit = (ctx: Ctx, sessionId: string, input: unknown) =>
  ctx.daemon.app.get(PrActionsService).submit(sessionId, input);

const worktree = (ctx: Ctx, sessionId: string) => path.join(ctx.daemon.dataDir, 'session-worktrees', sessionId);

const address = (ctx: Ctx, ids = ['c1', 'c3', 'c4']) => press(ctx, { action: 'address_comments', comment_ids: ids });

describe('starting a PR action', () => {
  it('opens a Session in a detached worktree at the head commit, with the Playbook as its opening prompt', async () => {
    const ctx = await start();
    const started = await address(ctx);
    expect(started.status).toBe(201);
    const session = started.body.data;
    expect(session).toMatchObject({
      kind: 'repo',
      pr_action: 'address_comments',
      pr_number: 1,
      branch: null,
      title: 'Address comments #1',
    });
    const dir = worktree(ctx, session.id);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(ctx.head);
    expect(git(dir, 'branch', '--show-current')).toBe('');
    expect(git(ctx.dir, 'branch', '--show-current')).toBe('main');

    const call = ctx.daemon.sdk.calls[0];
    expect(call?.prompt).toContain(`at head commit ${ctx.head}`);
    expect(call?.prompt).toContain('[comment_id c1] on src/app.ts:1');
    expect(call?.prompt).toContain('## Read the selected threads');
    expect(call?.prompt).toContain('submit_thread_results');
    expect(call?.options.cwd).toBe(dir);
    // Pull request code adds no settings of its own, and the agent has no push or comment command of its own.
    expect(call?.options.settingSources).toEqual(['user']);
    expect(call?.options.disallowedTools).toEqual(
      expect.arrayContaining(['Bash(git push:*)', 'Bash(gh pr comment:*)']),
    );

    const [listed] = (await detail(ctx)).action_sessions;
    expect(listed).toMatchObject({ session_id: session.id, action: 'address_comments', state: 'not_submitted' });
  });

  it('holds a second press of the same button back, and lets the other buttons through', async () => {
    const ctx = await start('colleague');
    await address(ctx);
    const again = await address(ctx, ['c1']);
    expect([again.status, again.body.error.code]).toEqual([409, 'session_busy']);
    const check = await press(ctx, { action: 'check_replies' });
    expect(check.status).toBe(201);
    expect((await detail(ctx)).action_sessions).toHaveLength(2);
  });

  it('refuses what cannot start: bad bodies, a closed pull request, an unfetchable head, a host that is down', async () => {
    const ctx = await start();
    const post = (body: Record<string, unknown>) => ctx.http.post(`${at(ctx)}/action-sessions`, body);
    expect((await post({ action: 'address_comments' })).status).toBe(400);
    expect((await post({ action: 'address_comments', comment_ids: ['c2'] })).status).toBe(400);
    expect((await post({ action: 'address_comments', comment_ids: ['nope'] })).status).toBe(404);
    expect((await post({ action: 'check_replies', comment_ids: ['c1'] })).status).toBe(400);
    expect((await post({ action: 'review', comment_ids: ['c1'] })).status).toBe(400);
    expect((await post({ action: 'check_replies', note: 'look here' })).status).toBe(400);

    git(ctx.dir, 'push', '-q', 'origin', '--delete', 'feature-1');
    const unfetchable = await post({ action: 'review' });
    expect([unfetchable.status, unfetchable.body.error.code]).toEqual([502, 'upstream_failed']);
    expect(unfetchable.body.error.message).toContain('Could not fetch the branch from origin');
    expect(existsSync(path.join(ctx.daemon.dataDir, 'session-worktrees'))).toBe(false);

    (ctx.host.prs[0] as { state: PrState }).state = PrState.Closed;
    expect((await post({ action: 'review' })).body.error.code).toBe('invalid_state');
    ctx.host.down = 'rate_limited';
    expect((await post({ action: 'review' })).body.error.code).toBe('rate_limited');
    expect((await detail({ ...ctx, host: ctx.host })).action_sessions ?? []).toEqual([]);
  });
});

describe('Address comments', () => {
  it('commits what the agent changed, pushes it, posts each reply and resolves the done threads', async () => {
    const ctx = await start();
    const { body } = await address(ctx);
    const dir = worktree(ctx, body.data.id);
    await writeFile(path.join(dir, 'src', 'app.ts'), 'export const taxRate = 1;\n');

    const result = await submit(ctx, body.data.id, {
      threads: [
        { comment_id: 'c1', outcome: 'done', reply: 'Read it from config.' },
        { comment_id: 'c3', outcome: 'declined', reply: 'The name is used by the API.' },
        { comment_id: 'c4', outcome: 'done', reply: 'Thanks.' },
      ],
    });

    const pushed = git(ctx.dir, 'ls-remote', 'origin', 'refs/heads/feature-1').split('\t')[0] as string;
    expect(pushed).not.toBe(ctx.head);
    expect(git(ctx.remote, 'log', '-1', '--format=%B', 'feature-1')).toBe(
      "Address review comments on #1\n\n- src/app.ts:1\n- reviewer's comment on the pull request",
    );
    expect(result).toContain(`Pushed ${pushed.slice(0, 7)}`);
    const replies = ctx.host.posted.map((comment) => [comment.parent_id, comment.body]);
    expect(replies).toEqual(
      expect.arrayContaining([
        ['c1', `Done in ${pushed.slice(0, 7)}. Read it from config.`],
        ['c3', 'The name is used by the API.'],
        ['c4', `Done in ${pushed.slice(0, 7)}. Thanks.`],
      ]),
    );
    expect([thread(ctx, 'c1')?.resolved, thread(ctx, 'c3')?.resolved, thread(ctx, 'c4')?.resolved]).toEqual([
      true,
      false,
      false,
    ]);
    const [listed] = (await detail(ctx)).action_sessions;
    expect(listed).toMatchObject({ state: 'submitted', commit_sha: pushed });
    const commands = ctx.store.db
      .select()
      .from(actionLog)
      .all()
      .map((row) => row.command);
    expect(commands).toEqual(
      expect.arrayContaining([
        'git commit -m "Address review comments on #1"',
        'git push origin HEAD:refs/heads/feature-1',
        'resolve thread c1',
      ]),
    );

    await expect(submit(ctx, body.data.id, { threads: [] })).rejects.toThrow('Already submitted');
    // Submitted: the button is free again.
    ctx.daemon.sdk.script({ text: 'ok' });
    expect(
      (await ctx.http.post(`${at(ctx)}/action-sessions`, { action: 'address_comments', comment_ids: ['c3'] })).status,
    ).toBe(201);
  });

  it('pushes nothing when every thread is declined, and still posts the replies', async () => {
    const ctx = await start();
    const { body } = await address(ctx, ['c1', 'c3']);
    await writeFile(path.join(worktree(ctx, body.data.id), 'src', 'app.ts'), 'export const other = 1;\n');
    await submit(ctx, body.data.id, {
      threads: [
        { comment_id: 'c1', outcome: 'declined', reply: 'The config does not exist yet.' },
        { comment_id: 'c3', outcome: 'declined', reply: 'Which name do you mean?' },
      ],
    });
    expect(git(ctx.dir, 'ls-remote', 'origin', 'refs/heads/feature-1').split('\t')[0]).toBe(ctx.head);
    expect(ctx.host.posted).toHaveLength(2);
    expect((await detail(ctx)).action_sessions[0]).toMatchObject({ state: 'submitted', commit_sha: null });
  });

  it('resolves an already addressed thread with its plain reply, no commit and no Done prefix', async () => {
    const ctx = await start();
    const { body } = await address(ctx, ['c1', 'c3']);
    await submit(ctx, body.data.id, {
      threads: [
        { comment_id: 'c1', outcome: 'already_addressed', reply: 'Config.read() already does this.' },
        { comment_id: 'c3', outcome: 'declined', reply: 'Which name do you mean?' },
      ],
    });
    expect(git(ctx.dir, 'ls-remote', 'origin', 'refs/heads/feature-1').split('\t')[0]).toBe(ctx.head);
    expect(ctx.host.posted.map((comment) => [comment.parent_id, comment.body])).toEqual(
      expect.arrayContaining([
        ['c1', 'Config.read() already does this.'],
        ['c3', 'Which name do you mean?'],
      ]),
    );
    expect([thread(ctx, 'c1')?.resolved, thread(ctx, 'c3')?.resolved]).toEqual([true, false]);
    expect((await detail(ctx)).action_sessions[0]).toMatchObject({ state: 'submitted', commit_sha: null });
  });

  it('refuses a call that leaves a ticked thread out or adds one that was not ticked, and posts nothing', async () => {
    const ctx = await start();
    const { body } = await address(ctx, ['c1', 'c3']);
    await expect(
      submit(ctx, body.data.id, { threads: [{ comment_id: 'c1', outcome: 'done', reply: 'Fixed.' }] }),
    ).rejects.toThrow('Missing: c3');
    await expect(
      submit(ctx, body.data.id, {
        threads: [
          { comment_id: 'c1', outcome: 'done', reply: 'Fixed.' },
          { comment_id: 'c3', outcome: 'done', reply: 'Fixed.' },
          { comment_id: 'c4', outcome: 'done', reply: 'Fixed.' },
        ],
      }),
    ).rejects.toThrow('Not ticked: c4');
    expect(ctx.host.posted).toEqual([]);
    expect((await detail(ctx)).action_sessions[0].state).toBe('not_submitted');
  });

  it('rebases onto a branch that moved, and tells the agent when the rebase conflicts', async () => {
    const ctx = await start();
    const { body } = await address(ctx, ['c1']);
    const dir = worktree(ctx, body.data.id);
    // A teammate pushes a commit to the branch meanwhile.
    git(ctx.dir, 'checkout', '-q', 'feature-1');
    await writeFile(path.join(ctx.dir, 'NOTES.md'), 'notes\n');
    git(ctx.dir, 'add', '.');
    git(ctx.dir, 'commit', '-q', '-m', 'teammate');
    git(ctx.dir, 'push', '-q', 'origin', 'feature-1');
    git(ctx.dir, 'checkout', '-q', 'main');

    await writeFile(path.join(dir, 'src', 'app.ts'), 'export const rate = 2;\n');
    await submit(ctx, body.data.id, { threads: [{ comment_id: 'c1', outcome: 'done', reply: 'Changed.' }] });
    expect(git(ctx.remote, 'log', '--format=%s', 'feature-1')).toBe(
      'Address review comments on #1\nteammate\nadd the rate\nfirst',
    );
    expect(thread(ctx, 'c1')?.resolved).toBe(true);

    // A second Session meets a teammate's commit that touches the same line.
    ctx.daemon.sdk.script({ text: 'ok' });
    const second = await ctx.http.post(`${at(ctx)}/action-sessions`, {
      action: 'address_comments',
      comment_ids: ['c3'],
    });
    const other = worktree(ctx, second.body.data.id);
    git(ctx.dir, 'checkout', '-q', 'feature-1');
    git(ctx.dir, 'fetch', '-q', 'origin');
    git(ctx.dir, 'reset', '-q', '--hard', 'origin/feature-1');
    await writeFile(path.join(ctx.dir, 'src', 'app.ts'), 'export const rate = 3;\n');
    git(ctx.dir, 'commit', '-q', '-am', 'teammate again');
    git(ctx.dir, 'push', '-q', 'origin', 'feature-1');
    git(ctx.dir, 'checkout', '-q', 'main');
    await until(
      async () =>
        (await detail(ctx)).action_sessions.find((s: { session_id: string }) => s.session_id === second.body.data.id),
      (found) => found?.state === 'not_submitted',
      'the second Session to be idle',
    );
    const before = ctx.host.posted.length;
    await writeFile(path.join(other, 'src', 'app.ts'), 'export const taxRate = 1;\n');
    await expect(
      submit(ctx, second.body.data.id, { threads: [{ comment_id: 'c3', outcome: 'done', reply: 'Renamed.' }] }),
    ).rejects.toThrow('The branch moved and the rebase conflicts with the new commits.');
    expect(ctx.host.posted).toHaveLength(before);
    expect((await detail(ctx)).action_sessions[0].state).toBe('not_submitted');
  });

  it('posts only what is missing when a call is repeated after a failure, and pushes once', async () => {
    const ctx = await start();
    const { body } = await address(ctx, ['c1', 'c3']);
    await writeFile(path.join(worktree(ctx, body.data.id), 'src', 'app.ts'), 'export const taxRate = 1;\n');
    ctx.host.failPosts = (comment) => comment.parent_id === 'c3';
    const input = {
      threads: [
        { comment_id: 'c1', outcome: 'done', reply: 'Config.' },
        { comment_id: 'c3', outcome: 'done', reply: 'Renamed.' },
      ],
    };
    await expect(submit(ctx, body.data.id, input)).rejects.toThrow('Still without a reply or a resolve: c3');
    const pushed = git(ctx.dir, 'ls-remote', 'origin', 'refs/heads/feature-1').split('\t')[0];
    expect((await detail(ctx)).action_sessions[0].state).toBe('not_submitted');

    ctx.host.failPosts = null;
    await submit(ctx, body.data.id, input);
    expect(git(ctx.dir, 'ls-remote', 'origin', 'refs/heads/feature-1').split('\t')[0]).toBe(pushed);
    expect(ctx.host.posted.filter((comment) => comment.parent_id === 'c1')).toHaveLength(1);
    expect(ctx.host.posted.filter((comment) => comment.parent_id === 'c3')).toHaveLength(1);
    expect((await detail(ctx)).action_sessions[0].state).toBe('submitted');
  });
});

describe('Check replies', () => {
  it('posts each verdict, resolves the fixed thread, and keeps nothing the agent changed', async () => {
    const ctx = await start('colleague');
    const { body } = await press(ctx, { action: 'check_replies' });
    expect(ctx.daemon.sdk.calls[0]?.prompt).toContain('octo-operator: Fixed in 33f8c2b2.');
    expect(ctx.daemon.sdk.calls[0]?.prompt).not.toContain('[comment_id c3]');
    await writeFile(path.join(worktree(ctx, body.data.id), 'src', 'app.ts'), 'export const scratch = 1;\n');
    await submit(ctx, body.data.id, {
      threads: [{ comment_id: 'c1', verdict: 'fixed', reply: 'The rate is read from config at the head commit.' }],
    });
    expect(thread(ctx, 'c1')?.resolved).toBe(true);
    expect(ctx.host.posted.at(-1)).toMatchObject({
      parent_id: 'c1',
      body: 'The rate is read from config at the head commit.',
    });
    expect(git(ctx.dir, 'ls-remote', 'origin', 'refs/heads/feature-1').split('\t')[0]).toBe(ctx.head);
    expect((await detail(ctx)).action_sessions[0]).toMatchObject({ state: 'submitted', commit_sha: null });

    // Once the reply is posted, the agent's comment is the thread's last: nothing is left to check.
    const again = await ctx.http.post(`${at(ctx)}/action-sessions`, { action: 'check_replies' });
    expect([again.status, again.body.error.code]).toEqual([409, 'invalid_state']);
  });

  it('leaves a not fixed thread open', async () => {
    const ctx = await start('colleague');
    const { body } = await press(ctx, { action: 'check_replies' });
    await submit(ctx, body.data.id, {
      threads: [{ comment_id: 'c1', verdict: 'not_fixed', reply: 'It is still hard-coded.' }],
    });
    expect(thread(ctx, 'c1')?.resolved).toBe(false);
    expect(ctx.host.posted).toHaveLength(1);
  });
});

describe('Review with agent', () => {
  it('posts each finding on its line and the summary, and records the review against the head commit', async () => {
    const ctx = await start('colleague');
    const { body } = await press(ctx, { action: 'review', note: 'Look at the rate first.' });
    expect(ctx.daemon.sdk.calls[0]?.prompt).toContain('Look at the rate first.');
    expect(ctx.daemon.sdk.calls[0]?.prompt).toContain('submit_review');
    await submit(ctx, body.data.id, {
      decision: 'request_changes',
      verdict: 'The rate is hard-coded.',
      findings: [{ severity: 'high', file: 'src/app.ts', line: 1, text: 'Read the rate from config.' }],
      report: 'Full report.',
    });
    const inline = ctx.host.posted.find((comment) => comment.file_path === 'src/app.ts');
    expect(inline).toMatchObject({ line: 1, head_sha: ctx.head, body: '**High**: Read the rate from config.' });
    expect(ctx.host.posted.at(-1)?.body).toContain('**Agent Review** · REQUEST CHANGES');
    const [review] = ctx.store.db.select().from(prAgentReviews).all();
    expect(review).toMatchObject({
      prNumber: 1,
      headSha: ctx.head,
      sessionId: body.data.id,
      decision: 'request_changes',
    });
    const shown = await detail(ctx);
    expect(shown.latest_agent_review).toMatchObject({ decision: 'request_changes', stale: false });
    expect(shown.action_sessions[0].state).toBe('submitted');

    const again = await ctx.http.post(`${at(ctx)}/action-sessions`, { action: 'review' });
    expect(again.body.error.message).toBe('The agent already reviewed this commit; push a change to review again');
  });
});

describe('Review with agent, posting', () => {
  const OUTPUT = {
    decision: 'request_changes',
    verdict: 'Needs one fix',
    findings: [
      { severity: 'high', file: 'src/app.ts', line: 3, text: 'Unchecked input.' },
      { severity: 'info', file: null, line: null, text: 'Rename the helper.' },
      { severity: 'medium', file: 'src/bad.ts', line: 9, text: 'Cache this.' },
    ],
    report: '## Review summary\n\nOne input check is missing.',
  };

  it('writes an Action Log row before each post, and keeps the review when the host refuses a finding or the summary', async () => {
    const ctx = await start('colleague');
    const { body } = await press(ctx, { action: 'review' });
    const rowsAtPost: number[] = [];
    ctx.host.beforePost = () => {
      rowsAtPost.push(ctx.store.db.select().from(actionLog).all().length);
    };
    ctx.host.failPosts = (comment) => comment.file_path === 'src/bad.ts' || comment.body.startsWith('**Agent Review**');
    const { events } = await listen(ctx.daemon);

    const answer = await submit(ctx, body.data.id, OUTPUT);
    expect(answer).toContain('Posted 2 findings');
    const [review] = ctx.store.db.select().from(prAgentReviews).all();
    const findings = JSON.parse(review?.findings ?? '[]') as { comment_id: string | null; post_error: string | null }[];
    expect(findings.map((f) => [!!f.comment_id, !!f.post_error])).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
    // A row is written before each of the four posts, the summary's too, so each post sees one more.
    expect(rowsAtPost.map((count, i) => count - (rowsAtPost[0] ?? 0) - i)).toEqual([0, 0, 0, 0]);
    const all = await until(
      () => events,
      (list) => list.some((event) => event.event === 'pull_request.reviewed'),
      'pull_request.reviewed',
    );
    const done = all.find((event) => event.event === 'pull_request.reviewed');
    expect(done?.data).toMatchObject({ status: 'ready', posted: 2, post_failed: 2 });
  });

  it('shows the agent its earlier open findings and the others’ threads, and does not post again where its own thread is open', async () => {
    const ctx = await start('colleague');
    const first = await press(ctx, { action: 'review' });
    await submit(ctx, first.body.data.id, { ...OUTPUT, findings: [OUTPUT.findings[0]] });
    const firstFinding = ctx.host.posted[0]?.id as string;

    git(ctx.dir, 'checkout', '-q', 'feature-1');
    await writeFile(path.join(ctx.dir, 'src', 'app.ts'), 'export const rate = 2;\n');
    git(ctx.dir, 'commit', '-q', '-am', 'change the rate');
    git(ctx.dir, 'push', '-q', 'origin', 'feature-1');
    const next = git(ctx.dir, 'rev-parse', 'feature-1');
    git(ctx.dir, 'checkout', '-q', 'main');
    (ctx.host.prs[0] as { head_sha: string }).head_sha = next;

    const second = await press(ctx, { action: 'review' });
    const brief = ctx.daemon.sdk.calls.at(-1)?.prompt ?? '';
    const mine = brief.indexOf('Your findings from earlier reviews, still open:');
    const theirs = brief.indexOf('Open comment threads by others on this pull request:');
    expect(mine).toBeGreaterThan(-1);
    expect(theirs).toBeGreaterThan(mine);
    expect(brief.slice(mine, theirs)).toContain('- on src/app.ts:3: **High**: Unchecked input.');
    expect(brief.slice(theirs)).toContain('- reviewer on src/app.ts:1: Read the rate from config.');
    // The earlier summary is in neither list.
    expect(brief).not.toContain('**Agent Review** ·');

    const before = ctx.host.posted.length;
    await submit(ctx, second.body.data.id, { ...OUTPUT, findings: [OUTPUT.findings[0]] });
    // The finding on src/app.ts:3 points at the first review's thread; only the summary is posted.
    expect(ctx.host.posted.slice(before).map((p) => p.file_path ?? null)).toEqual([null]);
    const latest = (await detail(ctx)).latest_agent_review;
    expect(latest.findings[0].comment_id).toBe(firstFinding);
  });
});

describe('what a PR action Session may do', () => {
  it('offers its one submit tool and none of the Session tools that leave the sandbox', async () => {
    const ctx = await start();
    await address(ctx);
    const servers = ctx.daemon.sdk.calls[0]?.options.mcpServers ?? {};
    expect(Object.keys(servers)).toEqual(['ops-console']);
  });
});
