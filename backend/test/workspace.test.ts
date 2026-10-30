import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectorId, HealthStatus, PrReviewState, type WsEvent } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { actionLog, agentComments, connectors, prAgentReviews } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { ReposModule } from '../src/repos/repos.module';
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
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' });

async function makeRepo(name: string, origin = 'git@github.com:acme/orders-api.git'): Promise<string> {
  const dir = path.join(await tempDir('ops-console-git-'), name);
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'branch', 'feature-1');
  git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

type Ctx = {
  daemon: AgentDaemon;
  host: FakeGitHost;
  repoId: string;
  dir: string;
  store: Store;
  http: ReturnType<typeof api>;
};

/** A daemon with GitHub connected as `octo-operator`, one imported Repo, and a scripted Git host. */
async function start(): Promise<Ctx> {
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
  const http = api(daemon);
  const dir = await makeRepo('orders-api');
  const imported = await http.post('/repos', { path: dir });
  return { daemon, host, repoId: imported.body.data.id, dir, store, http };
}

const newSession = (ctx: Ctx, branch = 'main') =>
  ctx.http.post('/sessions', { repo_id: ctx.repoId, branch }).then((res) => res.body.data.id as string);

describe('Sessions in a Repo', () => {
  it('needs a Repo and a branch that exists, and never takes a pr_review', async () => {
    const ctx = await start();
    expect((await ctx.http.post('/sessions', {})).body.error.code).toBe('validation_failed');
    expect((await ctx.http.post('/sessions', { repo_id: ctx.repoId })).body.error.code).toBe('validation_failed');
    const missing = await ctx.http.post('/sessions', { repo_id: ctx.repoId, branch: 'nope' });
    expect(missing.body.error.code).toBe('validation_failed');
    const review = await ctx.http.post('/sessions', { kind: 'pr_review', repo_id: ctx.repoId, branch: 'main' });
    expect(review.body.error.code).toBe('validation_failed');
    const created = await ctx.http.post('/sessions', { repo_id: ctx.repoId, branch: 'main', effort: 'low' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ kind: 'repo', repo_id: ctx.repoId, branch: 'main', effort: 'low' });
    expect(created.body.data.model).toBeTruthy();
  });

  it('runs the agent in the Repo folder, in two Repos side by side, and refuses a second message mid-run', async () => {
    const ctx = await start();
    const other = await makeRepo('billing', 'git@github.com:acme/billing.git');
    const otherId = (await ctx.http.post('/repos', { path: other })).body.data.id;
    const first = await newSession(ctx);
    const second = (await ctx.http.post('/sessions', { repo_id: otherId, branch: 'main' })).body.data.id;
    const hold = gate();
    ctx.daemon.sdk.script({ wait: hold.promise }, { text: 'one' });
    ctx.daemon.sdk.script({ text: 'two' });

    expect((await ctx.http.post(`/sessions/${first}/messages`, { text: 'go' })).status).toBe(202);
    await ctx.http.post(`/sessions/${second}/messages`, { text: 'go' });
    const busy = await ctx.http.post(`/sessions/${first}/messages`, { text: 'again' });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('session_busy');
    await until(
      () => ctx.http.get(`/sessions/${second}`).then((res) => res.body.data.state),
      (state) => state === 'idle',
    );
    hold.open();
    await until(
      () => ctx.http.get(`/sessions/${first}`).then((res) => res.body.data.state),
      (state) => state === 'idle',
    );
    expect(ctx.daemon.sdk.calls.map((call) => path.basename(call.options.cwd ?? '')).sort()).toEqual([
      'billing',
      'orders-api',
    ]);
  });

  it('refuses to remove a Repo that has Sessions, and deleting the Session keeps reviews and agent comments', async () => {
    const ctx = await start();
    const id = await newSession(ctx);
    const refused = await ctx.http.delete(`/repos/${ctx.repoId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('repo_has_sessions');

    ctx.store.write((tx) => {
      tx.insert(prAgentReviews).values({ id: 'r1', repoId: ctx.repoId, prNumber: 1, headSha: 'a' }).run();
      tx.insert(agentComments).values({ repoId: ctx.repoId, prNumber: 1, commentId: '9', agentReviewId: 'r1' }).run();
    });
    expect((await ctx.http.delete(`/sessions/${id}`)).status).toBe(204);
    expect(ctx.store.db.select().from(prAgentReviews).all()).toHaveLength(1);
    expect(ctx.store.db.select().from(agentComments).all()).toHaveLength(1);
    expect((await ctx.http.get('/repos')).body.data[0].branch).toBe('main');
    expect((await ctx.http.delete(`/repos/${ctx.repoId}`)).status).toBe(204);
  });
});

describe('branches', () => {
  it('marks the branches that have an open pull request, and still lists when the host fails', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1, { branch: 'feature-1' }), hostPr(2, { branch: 'other', state: 'merged' as never })];
    const branches = (await ctx.http.get(`/repos/${ctx.repoId}/branches`)).body.data;
    expect(branches).toEqual(
      expect.arrayContaining([
        { name: 'main', current: true, has_open_pr: false },
        { name: 'feature-1', current: false, has_open_pr: true },
      ]),
    );
    ctx.host.down = 'failed';
    await ctx.http.post('/pull-requests/refresh', { repo_id: ctx.repoId });
    const after = await ctx.http.get(`/repos/${ctx.repoId}/branches`);
    expect(after.status).toBe(200);
  });

  it('checks out a branch, stashes uncommitted changes first, and logs each git step before it runs', async () => {
    const ctx = await start();
    const id = await newSession(ctx);
    const { events, close } = await listen(ctx.daemon);
    await writeFile(path.join(ctx.dir, 'README.md'), 'changed\n');
    await writeFile(path.join(ctx.dir, 'new.txt'), 'untracked\n');

    const moved = await ctx.http.post(`/sessions/${id}/checkout`, { branch: 'feature-1' });
    expect(moved.status).toBe(200);
    expect(moved.body.data.stashed).toBe(true);
    expect(moved.body.data.session.branch).toBe('feature-1');
    expect(git(ctx.dir, 'branch', '--show-current').toString().trim()).toBe('feature-1');
    expect(git(ctx.dir, 'stash', 'list').toString()).toContain('before switching to feature-1');

    const log = (await ctx.http.get(`/action-log?session_id=${id}&kind=git`)).body.data;
    expect(log.map((row: { command: string }) => row.command).sort()).toEqual([
      'git checkout feature-1',
      'git stash push --include-untracked',
    ]);
    expect(
      log.every((row: { outcome: string; actor: string }) => row.outcome === 'ok' && row.actor === 'operator'),
    ).toBe(true);
    await until(
      () => events,
      (all) => all.some((event) => event.event === 'session.updated' && event.data.branch === 'feature-1'),
      'session.updated with the branch',
    );
    close();
  });

  it('makes a new branch from the current one, says nothing was stashed on a clean tree, and surfaces a git refusal', async () => {
    const ctx = await start();
    const id = await newSession(ctx);
    const made = await ctx.http.post(`/sessions/${id}/checkout`, { branch: 'fix-login', create: true });
    expect(made.body.data).toMatchObject({ stashed: false, session: { branch: 'fix-login' } });

    const again = await ctx.http.post(`/sessions/${id}/checkout`, { branch: 'fix-login', create: true });
    expect(again.status).toBe(502);
    expect(again.body.error.code).toBe('upstream_failed');
    const failed = (await ctx.http.get(`/action-log?session_id=${id}&outcome=failed`)).body.data;
    expect(failed).toHaveLength(1);
  });

  it('refuses while the Session or any Session in the Repo is running', async () => {
    const ctx = await start();
    const one = await newSession(ctx);
    const two = await newSession(ctx);
    const hold = gate();
    ctx.daemon.sdk.script({ wait: hold.promise });
    await ctx.http.post(`/sessions/${one}/messages`, { text: 'go' });
    for (const id of [one, two]) {
      const refused = await ctx.http.post(`/sessions/${id}/checkout`, { branch: 'feature-1' });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('invalid_state');
    }
    hold.open();
    await until(
      () => ctx.http.get(`/sessions/${one}`).then((res) => res.body.data.state),
      (state) => state === 'idle',
    );
    expect((await ctx.http.post(`/sessions/${two}/checkout`, { branch: 'feature-1' })).status).toBe(200);
    expect((await ctx.http.get(`/action-log?kind=git`)).body.data).toHaveLength(1);
  });
});

describe('pull requests', () => {
  it('lists from memory for a minute, and Refresh reads the host again and says what changed', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1), hostPr(2)];
    const first = await ctx.http.get('/pull-requests');
    expect(first.body.data.map((pr: { number: number }) => pr.number)).toEqual([2, 1]);
    expect(first.body.meta).toMatchObject({ stale: false });
    expect(first.body.meta.synced_at).toBeTruthy();
    await ctx.http.get('/pull-requests');
    expect(ctx.host.calls.list).toBe(1);

    const { events, close } = await listen(ctx.daemon);
    ctx.host.prs = [hostPr(1, { head_sha: 'sha-1-b' }), hostPr(2)];
    expect((await ctx.http.post('/pull-requests/refresh', {})).status).toBe(202);
    const refreshed = await until(
      () => events,
      (all) => all.some((event) => event.event === 'pull_request.refreshed'),
      'pull_request.refreshed',
    );
    const event = refreshed.find(
      (e): e is Extract<WsEvent, { event: 'pull_request.refreshed' }> => e.event === 'pull_request.refreshed',
    );
    expect(event?.data).toEqual({ repo_id: null, status: 'ok', changed: [{ repo_id: ctx.repoId, number: 1 }] });
    close();
  });

  it('serves the cached list as stale when the host fails, and errors when nothing is cached', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    ctx.host.down = 'rate_limited';
    const cold = await ctx.http.get(`/pull-requests?repo_id=${ctx.repoId}`);
    expect(cold.status).toBe(429);
    expect(cold.body.error.code).toBe('rate_limited');
    ctx.host.down = 'failed';
    expect((await ctx.http.get(`/pull-requests?repo_id=${ctx.repoId}`)).body.error.code).toBe('upstream_failed');

    ctx.host.down = null;
    await ctx.http.get('/pull-requests');
    ctx.host.down = 'failed';
    // Past the minute the list is read again; the host fails and the cache answers.
    const { LIST_TTL_MS } = await import('../src/workspace/pull-requests.service');
    const realNow = Date.now;
    Date.now = () => realNow() + LIST_TTL_MS + 1;
    try {
      const stale = await ctx.http.get('/pull-requests');
      expect(stale.status).toBe(200);
      expect(stale.body.meta.stale).toBe(true);
      expect(stale.body.data).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("tells the operator's own pull requests apart by login or by an agent Session on the branch", async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1, { author: 'octo-operator' }), hostPr(2), hostPr(3, { branch: 'feature-1' })];
    const all = (await ctx.http.get('/pull-requests')).body.data as {
      number: number;
      is_mine: boolean;
      by_agent: boolean;
    }[];
    expect(all.find((pr) => pr.number === 1)).toMatchObject({ is_mine: true, by_agent: false });
    expect(all.find((pr) => pr.number === 2)).toMatchObject({ is_mine: false, by_agent: false });
    await newSession(ctx, 'feature-1');
    const after = (await ctx.http.get('/pull-requests?mine=true')).body.data as { number: number; by_agent: boolean }[];
    expect(after.map((pr) => pr.number).sort()).toEqual([1, 3]);
    expect(after.find((pr) => pr.number === 3)?.by_agent).toBe(true);
    const q = (await ctx.http.get('/pull-requests?q=change 2')).body.data;
    expect(q.map((pr: { number: number }) => pr.number)).toEqual([2]);
  });

  it("counts every comment and the resolved threads, and marks the agent's comments", async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const root = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comments`, {
      body: 'why?',
      file_path: 'src/app.ts',
      line: 3,
    });
    expect(root.status).toBe(201);
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comments`, {
      body: 'because',
      parent_id: root.body.data.id,
    });
    ctx.store.write((tx) => {
      tx.insert(agentComments).values({ repoId: ctx.repoId, prNumber: 1, commentId: root.body.data.id }).run();
    });
    const resolved = await ctx.http.patch(`/repos/${ctx.repoId}/pull-requests/1/comments/${root.body.data.id}`, {
      resolved: true,
    });
    expect(resolved.body.data).toMatchObject({ resolved: true, by_agent: true, reply_count: 1 });

    const detail = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1`)).body.data;
    expect(detail).toMatchObject({ comment_count: 2, resolved_count: 1 });
    expect(detail.files).toHaveLength(1);
    expect(detail.comments.map((c: { by_agent: boolean }) => c.by_agent)).toEqual([true, false]);
    const reply = detail.comments[1];
    const notRoot = await ctx.http.patch(`/repos/${ctx.repoId}/pull-requests/1/comments/${reply.id}`, {
      resolved: true,
    });
    expect(notRoot.body.error.code).toBe('invalid_state');
  });

  it('changes nothing when the host refuses a comment, and drops the cache when it accepts', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    await ctx.http.get('/pull-requests');
    ctx.host.failPosts = () => true;
    const refused = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comments`, { body: 'hi' });
    expect(refused.status).toBe(502);
    await ctx.http.get('/pull-requests');
    expect(ctx.host.calls.list).toBe(1);
    ctx.host.failPosts = null;
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comments`, { body: 'hi' });
    const after = await ctx.http.get('/pull-requests');
    expect(ctx.host.calls.list).toBe(2);
    expect(after.body.data[0].comment_count).toBe(1);
  });

  it("refuses approve and request-changes on the operator's own pull request, and allows a comment", async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1, { author: 'octo-operator' }), hostPr(2)];
    for (const event of ['approve', 'request_changes']) {
      const refused = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reviews`, { event, body: 'x' });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('invalid_state');
    }
    expect(
      (await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/reviews`, { event: 'comment', body: 'note' })).status,
    ).toBe(200);
    const noBody = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/2/reviews`, { event: 'request_changes' });
    expect(noBody.body.error.code).toBe('validation_failed');
    const approved = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/2/reviews`, { event: 'approve' });
    expect(approved.body.data.review_state).toBe(PrReviewState.Approved);
  });

  it('merges only an approved open pull request, logs it first, and keeps it open when the host refuses', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1), hostPr(2, { review_state: PrReviewState.Approved })];
    const early = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/merge`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('invalid_state');
    expect(ctx.host.merged).toEqual([]);

    ctx.host.rejectMerge = true;
    const rejected = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/2/merge`);
    expect(rejected.status).toBe(502);
    expect(rejected.body.error.code).toBe('upstream_failed');
    expect((await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/2`)).body.data.state).toBe('open');

    ctx.host.rejectMerge = false;
    const merged = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/2/merge`);
    expect(merged.body.data.state).toBe('merged');
    const rows = (await ctx.http.get('/action-log?kind=pr')).body.data;
    expect(rows.map((row: { outcome: string }) => row.outcome).sort()).toEqual(['failed', 'ok']);
    expect(rows[0].actor).toBe('operator');
  });

  it('has no pull requests for a Repo without a Git host', async () => {
    const ctx = await start();
    const local = await makeRepo('scratch', 'ssh://git.example.com/scratch.git');
    const id = (await ctx.http.post('/repos', { path: local })).body.data.id;
    const res = await ctx.http.get(`/pull-requests?repo_id=${id}`);
    expect(res.status).toBe(409);
    expect((await ctx.http.get('/pull-requests')).body.data).toEqual([]);
  });
});

const REVIEW = [
  '```json',
  JSON.stringify({
    verdict: 'Needs one fix',
    findings: [
      { severity: 'blocker', file: 'src/app.ts', line: 3, text: 'Unchecked input.' },
      { severity: 'nit', file: null, line: null, text: 'Rename the helper.' },
      { severity: 'suggestion', file: 'src/bad.ts', line: 9, text: 'Cache this.' },
    ],
    checklist: [{ item: 'Migration', status: 'pass', note: 'none needed' }],
    tools: [],
  }),
  '```',
].join('\n');

const waitForReview = (events: WsEvent[]) =>
  until(
    () => events,
    (all) => all.some((event) => event.event === 'pull_request.reviewed'),
    'pull_request.reviewed',
  );

describe('Agent Review', () => {
  it("runs in the pull request's own Session, posts each finding with an Action Log row first, and records the comments", async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const { events, close } = await listen(ctx.daemon);
    const rowsAtPost: number[] = [];
    ctx.host.beforePost = () => {
      rowsAtPost.push(ctx.store.db.select().from(actionLog).all().length);
    };
    ctx.host.failPosts = (comment) => comment.file_path === 'src/bad.ts';
    ctx.daemon.sdk.script({ text: REVIEW });

    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({ status: 'running', head_sha: 'sha-1-a', stale: false });
    await waitForReview(events);

    const [review] = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`)).body.data;
    expect(review).toMatchObject({ status: 'ready', verdict: 'Needs one fix' });
    expect(
      review.findings.map((f: { comment_id: string | null; post_error: string | null }) => [
        !!f.comment_id,
        !!f.post_error,
      ]),
    ).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
    expect(review.checklist).toHaveLength(1);
    expect(ctx.host.posted.map((p) => [p.file_path ?? null, p.line ?? null])).toEqual([
      ['src/app.ts', 3],
      [null, null],
    ]);
    // A row is written before each of the three posts, so each post sees one more.
    expect(rowsAtPost).toEqual([1, 2, 3]);
    const done = events.find((e) => e.event === 'pull_request.reviewed');
    expect(done?.data).toMatchObject({ status: 'ready', posted: 2, post_failed: 1 });

    const detail = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1`)).body.data;
    expect(detail.comments.every((c: { by_agent: boolean }) => c.by_agent)).toBe(true);
    expect(detail.latest_agent_review.id).toBe(review.id);
    expect(detail.agent_session_id).toBeTruthy();
    close();
  });

  it('reads as stale after the pull request moves on, and a second review adds a row in the same Session', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const { events, close } = await listen(ctx.daemon);
    ctx.daemon.sdk.script({ text: REVIEW });
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    await waitForReview(events);

    ctx.host.prs = [hostPr(1, { head_sha: 'sha-1-b' })];
    const stale = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`)).body.data;
    expect(stale[0].stale).toBe(true);

    ctx.daemon.sdk.script({ text: REVIEW });
    events.length = 0;
    const second = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    expect(second.body.data).toMatchObject({ head_sha: 'sha-1-b', stale: false });
    await waitForReview(events);
    const rows = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`)).body.data;
    expect(rows).toHaveLength(2);
    expect(rows[1].stale).toBe(true);
    const sessions = (await ctx.http.get('/sessions?kind=pr_review')).body.data;
    expect(sessions).toHaveLength(1);
    close();
  });

  it('marks the review failed when the agent does not answer in the agreed shape, and refuses a second run mid-review', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const { events, close } = await listen(ctx.daemon);
    const hold = gate();
    ctx.daemon.sdk.script({ wait: hold.promise }, { text: 'I looked at it and it is fine.' });
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    const busy = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('session_busy');
    hold.open();
    await waitForReview(events);
    const rows = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`)).body.data;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(ctx.host.posted).toEqual([]);
    close();
  });

  it('takes no message from the operator in a pr_review Session', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const { events, close } = await listen(ctx.daemon);
    ctx.daemon.sdk.script({ text: REVIEW });
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    await waitForReview(events);
    const session = (await ctx.http.get('/sessions?kind=pr_review')).body.data[0];
    const refused = await ctx.http.post(`/sessions/${session.id}/messages`, { text: 'hello' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('invalid_state');
    close();
  });

  it('answers a reply in a thread the agent started, and ignores a reply in any other thread', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const { events, close } = await listen(ctx.daemon);
    ctx.daemon.sdk.script({ text: REVIEW });
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    await waitForReview(events);
    const agentRoot = ctx.host.posted[0]?.id as string;
    const calls = ctx.daemon.sdk.calls.length;

    ctx.daemon.sdk.script({ text: 'Good point: I will keep the check.' });
    const reply = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comments`, {
      body: 'Can we skip the check?',
      parent_id: agentRoot,
    });
    expect(reply.status).toBe(201);
    await until(
      () => ctx.host.posted.length,
      (count) => count === 5,
      'the agent answer',
    );
    expect(ctx.daemon.sdk.calls).toHaveLength(calls + 1);
    expect(ctx.daemon.sdk.calls.at(-1)?.prompt).toContain('Can we skip the check?');
    const answer = ctx.host.posted[4];
    expect(answer).toMatchObject({ body: 'Good point: I will keep the check.', parent_id: agentRoot });
    expect(
      ctx.store.db
        .select()
        .from(agentComments)
        .where(eq(agentComments.commentId, answer?.id as string))
        .all(),
    ).toHaveLength(1);
    const sessionId = (await ctx.http.get('/sessions?kind=pr_review')).body.data[0].id;
    const logged = (await ctx.http.get(`/action-log?session_id=${sessionId}&kind=pr`)).body.data;
    expect(logged.some((row: { command: string }) => row.command.startsWith('reply in thread'))).toBe(true);

    const other = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comments`, { body: 'unrelated thread' });
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comments`, {
      body: 'me again',
      parent_id: other.body.data.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ctx.daemon.sdk.calls).toHaveLength(calls + 1);
    close();
  });
});
