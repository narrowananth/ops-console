import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectorId, GitHost, HealthStatus, PrReviewState, type WsEvent } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { StartupRecovery } from '../src/common/recovery';
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

  it('asks what to do with the Sessions before removing a Repo, and deleting a Session keeps reviews and agent comments', async () => {
    const ctx = await start();
    const id = await newSession(ctx);
    expect((await ctx.http.get('/repos')).body.data[0].session_count).toBe(1);
    const refused = await ctx.http.delete(`/repos/${ctx.repoId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('repo_has_sessions');
    expect((await ctx.http.delete(`/repos/${ctx.repoId}?sessions=later`)).body.error.code).toBe('validation_failed');

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

  it('removes a Repo with its Sessions kept, hides both, and brings both back when the folder is imported again', async () => {
    const ctx = await start();
    const id = await newSession(ctx);
    const hold = gate();
    ctx.daemon.sdk.script({ wait: hold.promise }, { text: 'done' });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'go' });

    expect((await ctx.http.delete(`/repos/${ctx.repoId}?sessions=keep`)).status).toBe(204);
    expect((await ctx.http.get('/repos')).body.data).toEqual([]);
    expect((await ctx.http.get('/sessions?kind=repo')).body.data).toEqual([]);
    expect((await ctx.http.get(`/repos/${ctx.repoId}/branches`)).status).toBe(404);
    expect((await ctx.http.post('/sessions', { repo_id: ctx.repoId, branch: 'main' })).status).toBe(404);

    // The run it was in finishes unseen.
    hold.open();
    await until(
      () => ctx.http.get(`/sessions/${id}`).then((res) => res.body.data.state),
      (state) => state === 'idle',
    );

    const again = await ctx.http.post('/repos', { path: ctx.dir });
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({ id: ctx.repoId, session_count: 1 });
    expect((await ctx.http.get('/sessions?kind=repo')).body.data.map((s: { id: string }) => s.id)).toEqual([id]);
    expect((await ctx.http.post('/repos', { path: ctx.dir })).body.error.code).toBe('duplicate');
  });

  it('removes a Repo with its Sessions deleted, once none is running', async () => {
    const ctx = await start();
    const id = await newSession(ctx);
    const hold = gate();
    ctx.daemon.sdk.script({ wait: hold.promise }, { text: 'done' });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'go' });

    const busy = await ctx.http.delete(`/repos/${ctx.repoId}?sessions=delete`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('session_busy');

    hold.open();
    await until(
      () => ctx.http.get(`/sessions/${id}`).then((res) => res.body.data.state),
      (state) => state === 'idle',
    );
    expect((await ctx.http.delete(`/repos/${ctx.repoId}?sessions=delete`)).status).toBe(204);
    expect((await ctx.http.get(`/sessions/${id}`)).status).toBe(404);
    const again = await ctx.http.post('/repos', { path: ctx.dir });
    expect(again.body.data.id).not.toBe(ctx.repoId);
    expect(again.body.data.session_count).toBe(0);
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
    // Past the minute the kept list answers at once and is read again behind it; that read fails, so the next answer
    // says the list is stale.
    const { LIST_TTL_MS } = await import('../src/workspace/pull-requests.service');
    const realNow = Date.now;
    Date.now = () => realNow() + LIST_TTL_MS + 1;
    try {
      const first = await ctx.http.get('/pull-requests');
      expect(first.status).toBe(200);
      expect(first.body.data).toHaveLength(1);
      const stale = await until(
        () => ctx.http.get('/pull-requests'),
        (res) => res.body.meta.stale === true,
        'a stale list',
      );
      expect(stale.body.data).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });

  it('answers a minute-old list from memory, reads the host behind it, and tells the UI what changed', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    await ctx.http.get(`/pull-requests?repo_id=${ctx.repoId}`);
    const { events, close } = await listen(ctx.daemon);
    ctx.host.prs = [hostPr(1), hostPr(2)];
    const { LIST_TTL_MS } = await import('../src/workspace/pull-requests.service');
    const realNow = Date.now;
    Date.now = () => realNow() + LIST_TTL_MS + 1;
    try {
      const kept = await ctx.http.get(`/pull-requests?repo_id=${ctx.repoId}`);
      expect(kept.body.data).toHaveLength(1);
      const refreshed = await until(
        () => events,
        (all) => all.some((event) => event.event === 'pull_request.refreshed'),
        'pull_request.refreshed',
      );
      expect(refreshed.find((event) => event.event === 'pull_request.refreshed')?.data).toMatchObject({
        repo_id: ctx.repoId,
        status: 'ok',
        changed: [{ repo_id: ctx.repoId, number: 2 }],
      });
      expect((await ctx.http.get(`/pull-requests?repo_id=${ctx.repoId}`)).body.data).toHaveLength(2);
    } finally {
      Date.now = realNow;
      close();
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

  it("deletes the operator's and the agent's comments, and refuses anyone else's", async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const own = (await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/comments`, { body: 'mine' })).body.data;
    ctx.store.write((tx) => {
      tx.insert(agentComments).values({ repoId: ctx.repoId, prNumber: 1, commentId: own.id }).run();
    });
    ctx.host.comments.set(1, [
      ...(ctx.host.comments.get(1) ?? []),
      {
        id: 'theirs',
        parent_id: null,
        author: 'someone-else',
        body: 'not yours',
        file_path: null,
        line: null,
        resolved: false,
        created_at: new Date().toISOString(),
      },
    ]);
    const before = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1`)).body.data;
    expect(before.comments.map((c: { is_mine: boolean }) => c.is_mine)).toEqual([true, false]);

    const refused = await ctx.http.delete(`/repos/${ctx.repoId}/pull-requests/1/comments/theirs`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('invalid_state');
    expect((await ctx.http.delete(`/repos/${ctx.repoId}/pull-requests/1/comments/${own.id}`)).status).toBe(204);
    expect((await ctx.http.delete(`/repos/${ctx.repoId}/pull-requests/1/comments/${own.id}`)).status).toBe(404);

    const after = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1`)).body.data;
    expect(after.comments.map((c: { id: string }) => c.id)).toEqual(['theirs']);
    expect(ctx.store.db.select().from(agentComments).all()).toEqual([]);
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
    expect(approved.body.data.approved_by).toEqual(['me']);
  });

  it('reads one file of a pull request at a commit, null when it is not there', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    ctx.host.texts.set('abc1234:src/app.ts', 'const a = 1;\n');
    const found = await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/file?path=src/app.ts&ref=abc1234`);
    expect(found.body.data).toEqual({ path: 'src/app.ts', ref: 'abc1234', text: 'const a = 1;\n' });
    const gone = await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/file?path=src/old.ts&ref=abc1234`);
    expect(gone.body.data.text).toBeNull();
    const bad = await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/file?path=src/app.ts&ref=main;rm`);
    expect(bad.body.error.code).toBe('validation_failed');
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

  it("lists every repository's pull requests under the host's owners, linking the imported Repo", async () => {
    const ctx = await start();
    ctx.host.ownerNames = ['octo-operator', 'acme'];
    ctx.host.prs = [hostPr(1)];
    ctx.host.elsewhere = [
      {
        ...hostPr(5, { author: 'octo-operator', url: 'https://github.com/acme/billing/pull/5' }),
        slug: 'acme/billing',
      },
      { ...hostPr(6), slug: 'octo-operator/notes' },
    ];
    const res = await ctx.http.get('/pull-requests');
    const rows = res.body.data.map((pr: { repo_id: string | null; slug: string; number: number; host: string }) => ({
      repo: pr.repo_id,
      slug: pr.slug,
      number: pr.number,
      host: pr.host,
    }));
    expect(rows).toEqual([
      { repo: null, slug: 'octo-operator/notes', number: 6, host: 'github' },
      { repo: null, slug: 'acme/billing', number: 5, host: 'github' },
      { repo: ctx.repoId, slug: 'acme/orders-api', number: 1, host: 'github' },
    ]);
    expect(ctx.host.ownerReads).toEqual(['octo-operator', 'acme']);
    const mine = await ctx.http.get('/pull-requests?mine=true');
    expect(mine.body.data.map((pr: { number: number }) => pr.number)).toEqual([5]);
  });

  it('has no pull requests for a Repo without a Git host', async () => {
    const ctx = await start();
    const local = await makeRepo('scratch', 'ssh://git.example.com/scratch.git');
    const id = (await ctx.http.post('/repos', { path: local })).body.data.id;
    const res = await ctx.http.get(`/pull-requests?repo_id=${id}`);
    expect(res.status).toBe(409);
    expect((await ctx.http.get('/pull-requests')).body.data).toEqual([]);
  });

  it('lists every other Repo when one sits on a host with no adapter yet, and refuses that Repo alone', async () => {
    const ctx = await start();
    ctx.host.unsupported.add(GitHost.Bitbucket);
    ctx.store.write((tx) => {
      tx.update(connectors).set({ status: HealthStatus.Ok }).where(eq(connectors.id, ConnectorId.Bitbucket)).run();
    });
    const billing = await makeRepo('billing', 'git@bitbucket.org:acme/billing.git');
    const id = (await ctx.http.post('/repos', { path: billing })).body.data.id;
    ctx.host.prs = [hostPr(1)];

    const all = await ctx.http.get('/pull-requests');
    expect(all.status).toBe(200);
    expect(all.body.data.map((pr: { repo_id: string }) => pr.repo_id)).toEqual([ctx.repoId]);
    expect((await ctx.http.get(`/pull-requests?repo_id=${id}`)).status).toBe(502);

    const { events, close } = await listen(ctx.daemon);
    await ctx.http.post('/pull-requests/refresh', {});
    const refreshed = await until(
      () => events,
      (list) => list.some((event) => event.event === 'pull_request.refreshed'),
      'pull_request.refreshed',
    );
    expect(refreshed.find((event) => event.event === 'pull_request.refreshed')?.data).toMatchObject({ status: 'ok' });
    close();
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

/** The built-in Review PR step's turn, then the closing turn with the findings. */
function scriptReview(ctx: { daemon: AgentDaemon }): void {
  ctx.daemon.sdk.script({ text: '```json\n{ "outcome": "done", "summary": "read the diff" }\n```' });
  ctx.daemon.sdk.script({ text: REVIEW });
}

const waitForReview = (events: WsEvent[]) =>
  until(
    () => events,
    (all) => all.some((event) => event.event === 'pull_request.reviewed'),
    'pull_request.reviewed',
  );

describe('Agent Review', () => {
  it('fails a review the last daemon left running, so a new one can start', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    ctx.store.write((tx) => {
      tx.insert(prAgentReviews)
        .values({ id: 'left-running', repoId: ctx.repoId, prNumber: 1, headSha: 'sha-1-a' })
        .run();
    });
    await ctx.daemon.app.get(StartupRecovery).runAll();
    const [review] = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`)).body.data;
    expect(review).toMatchObject({ id: 'left-running', status: 'failed' });
  });

  it("runs in the pull request's own Session, posts each finding with an Action Log row first, and records the comments", async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const { events, close } = await listen(ctx.daemon);
    const rowsAtPost: number[] = [];
    ctx.host.beforePost = () => {
      rowsAtPost.push(ctx.store.db.select().from(actionLog).all().length);
    };
    ctx.host.failPosts = (comment) => comment.file_path === 'src/bad.ts';
    scriptReview(ctx);

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
    scriptReview(ctx);
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    await waitForReview(events);

    ctx.host.prs = [hostPr(1, { head_sha: 'sha-1-b' })];
    const stale = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`)).body.data;
    expect(stale[0].stale).toBe(true);

    scriptReview(ctx);
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

  it('refuses a second review of a commit already reviewed', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const { events, close } = await listen(ctx.daemon);
    scriptReview(ctx);
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    await waitForReview(events);
    const calls = ctx.daemon.sdk.calls.length;
    const again = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('invalid_state');
    expect(ctx.daemon.sdk.calls).toHaveLength(calls);
    expect(ctx.host.posted).toHaveLength(3);
    close();
  });

  it('shows the agent the open threads, and does not post again on a line where its own open thread is', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const { events, close } = await listen(ctx.daemon);
    scriptReview(ctx);
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    await waitForReview(events);
    const first = ctx.host.posted[0]?.id as string;

    ctx.host.prs = [hostPr(1, { head_sha: 'sha-1-b' })];
    scriptReview(ctx);
    events.length = 0;
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    await waitForReview(events);

    expect(ctx.daemon.sdk.calls.at(-2)?.prompt).toContain('on src/app.ts:3: **blocker**: Unchecked input.');
    // src/app.ts:3 points at the first thread; the rest have no open agent thread on their line, so they post.
    expect(ctx.host.posted.map((p) => [p.file_path ?? null, p.line ?? null])).toEqual([
      ['src/app.ts', 3],
      [null, null],
      ['src/bad.ts', 9],
      [null, null],
    ]);
    const [latest] = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`)).body.data;
    expect(latest.findings[0].comment_id).toBe(first);
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

  it("runs Review PR's Playbook one step per turn, shows its steps, and fails whole on a failed step", async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const step = (title: string) => ({ block: 'custom', title, instructions: `Check ${title}.`, writes: false });
    const created = await ctx.http.post('/playbooks', {
      name: 'PROD readiness',
      rules: 'Flag every missing migration.',
      steps: [step('Migrations'), step('Rollback')],
    });
    await ctx.http.put('/playbook-triggers/review_pr', { playbook_id: created.body.data.id });
    const { events, close } = await listen(ctx.daemon);
    const outcome = (status: string, summary: string) => ({
      text: `\`\`\`json\n${JSON.stringify({ outcome: status, summary })}\n\`\`\``,
    });
    ctx.daemon.sdk.script(outcome('done', 'no migration'));
    ctx.daemon.sdk.script(outcome('failed', 'no rollback plan'));
    const started = await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    expect(started.body.data.playbook).toMatchObject({ name: 'PROD readiness' });
    await waitForReview(events);
    const [failed] = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`)).body.data;
    expect(failed.status).toBe('failed');
    expect(failed.playbook.steps).toEqual([
      { title: 'Migrations', writes: false, status: 'done', summary: 'no migration' },
      { title: 'Rollback', writes: false, status: 'failed', summary: 'no rollback plan' },
    ]);
    expect(ctx.daemon.sdk.calls).toHaveLength(2);
    expect(ctx.host.posted).toEqual([]);

    events.length = 0;
    ctx.daemon.sdk.script(outcome('done', 'no migration'));
    ctx.daemon.sdk.script(outcome('skipped', 'nothing to roll back'));
    ctx.daemon.sdk.script({ text: REVIEW });
    await ctx.http.post(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`);
    await waitForReview(events);
    const [ready] = (await ctx.http.get(`/repos/${ctx.repoId}/pull-requests/1/agent-reviews`)).body.data;
    expect(ready).toMatchObject({ status: 'ready', verdict: 'Needs one fix' });
    expect(ready.playbook.steps.map((s: { status: string }) => s.status)).toEqual(['done', 'skipped']);
    const prompts = ctx.daemon.sdk.calls.slice(2).map((call) => call.prompt);
    expect(prompts[0]).toContain('Review pull request #1');
    expect(prompts[0]).toContain('Step 1 of 2: Migrations');
    expect(prompts[2]).toMatch(/^Write your review/);
    const append = (ctx.daemon.sdk.calls.at(-1)?.options.systemPrompt as { append: string } | undefined)?.append ?? '';
    expect(append).toContain('Flag every missing migration.');
    close();
  });

  it('takes no message from the operator in a pr_review Session', async () => {
    const ctx = await start();
    ctx.host.prs = [hostPr(1)];
    const { events, close } = await listen(ctx.daemon);
    scriptReview(ctx);
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
    scriptReview(ctx);
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
