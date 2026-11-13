import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessMode, Effort, Model, SessionKind } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { runSpawnSessions, SPAWN_SESSIONS_TOOL } from '../src/agent/pull-request-tool';
import { AgentRuntime } from '../src/agent/runtime';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { ReposModule } from '../src/repos/repos.module';
import { SessionSpawnService } from '../src/workspace/session-spawn.service';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, gate, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeGitHost } from './fakes/git-host';
import { FakeProbe } from './fakes/probe';
import { tempDir } from './helpers';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

type Wait = { id: string; summary: string };

/** A daemon with three imported Repos, `orders-api`, `web` and `billing`, each on `main`. */
async function start() {
  const daemon = await startAgentDaemon({
    fixtureKinds: false,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      ReposModule.forRoot(),
      WorkspaceModule.forRoot({ hosts: new FakeGitHost() }),
    ],
  });
  running.push(daemon);
  const http = api(daemon);
  const root = await realpath(await tempDir('ops-console-git-'));
  const repo = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    await writeFile(path.join(dir, 'README.md'), 'hello\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'first');
    git(dir, 'remote', 'add', 'origin', `git@github.com:acme/${name}.git`);
    return { name, dir, id: (await http.post('/repos', { path: dir })).body.data.id as string };
  };
  const repos = { orders: await repo('orders-api'), web: await repo('web'), billing: await repo('billing') };
  const anonymous = async (access_mode = AccessMode.Supervised) =>
    (await http.post('/sessions', { kind: 'anonymous', access_mode })).body.data.id as string;
  const pending = async () => (await http.get('/approvals?status=pending')).body.data as Wait[];
  const session = async (id: string) => (await http.get(`/sessions/${id}`)).body.data;
  const idle = (id: string) =>
    until(
      async () => (await session(id)).state,
      (state) => state === 'idle',
      'the run to end',
    );
  /** The agent calls `spawn_sessions` in `id`; the call waits on the Approval. */
  const ask = async (id: string, input: unknown, hold = gate()) => {
    daemon.sdk.script({ tool: SPAWN_SESSIONS_TOOL, input: input as Record<string, unknown>, hold: hold.promise });
    await http.post(`/sessions/${id}/messages`, { text: 'split this across the Repos' });
    return hold;
  };
  return { daemon, http, repos, anonymous, pending, session, idle, ask, spawner: daemon.app.get(SessionSpawnService) };
}

const batch = (ctx: Awaited<ReturnType<typeof start>>) => ({
  sessions: [
    { repo: 'web', task: 'Fix the cart total.\nIt drops cents.' },
    { repo: ctx.repos.billing.dir, task: 'Round invoices to two places.' },
  ],
});

describe('spawn parallel Sessions', () => {
  it('is offered in an operator chat of an Anonymous or a repo Session, and not in a run the console starts (1, 2)', async () => {
    const ctx = await start();
    const anonymous = await ctx.anonymous();
    const inRepo = ctx.daemon.createSession({ repoId: ctx.repos.orders.id, branch: 'main' });
    for (const id of [anonymous, inRepo]) {
      ctx.daemon.sdk.script({ text: 'ok' });
      await ctx.http.post(`/sessions/${id}/messages`, { text: 'hi' });
      await ctx.idle(id);
    }
    for (const call of ctx.daemon.sdk.calls)
      expect(Object.keys(call.options.mcpServers ?? {})).toEqual(['ops-console']);
    expect(ctx.spawner.offers(anonymous)).toBe(true);
    expect(ctx.spawner.offers(inRepo)).toBe(true);

    // A run the console starts (a Playbook step, a Verification) has no such tool.
    const before = ctx.daemon.sdk.calls.length;
    ctx.daemon.sdk.script({ text: 'ok' });
    await ctx.daemon.app.get(AgentRuntime).runFor(anonymous, 'hi').finished;
    expect(ctx.daemon.sdk.calls.slice(before).every((call) => call.options.mcpServers === undefined)).toBe(true);
  });

  it('refuses the whole list before it asks when an entry is unknown, repeated, blank or the Session own Repo (3)', async () => {
    const ctx = await start();
    const parent = ctx.daemon.createSession({ repoId: ctx.repos.orders.id, branch: 'main' });
    const refused = (sessions: { repo: string; task: string }[], why: RegExp) =>
      expect(() => ctx.spawner.describe(parent, { sessions })).toThrow(why);
    refused(
      [
        { repo: 'web', task: 'a' },
        { repo: 'shipping', task: 'b' },
      ],
      /no imported Repo matches "shipping"/,
    );
    refused(
      [
        { repo: 'web', task: 'a' },
        { repo: 'acme/web', task: 'b' },
      ],
      /web is listed twice/,
    );
    refused([{ repo: 'orders-api', task: 'a' }], /orders-api is this Session's own Repo/);

    // An empty list and a blank task never reach the Approval.
    ctx.daemon.sdk.script({ tool: SPAWN_SESSIONS_TOOL, input: { sessions: [] } });
    await ctx.http.post(`/sessions/${parent}/messages`, { text: 'go' });
    await ctx.idle(parent);
    ctx.daemon.sdk.script({ tool: SPAWN_SESSIONS_TOOL, input: { sessions: [{ repo: 'web', task: '  ' }] } });
    await ctx.http.post(`/sessions/${parent}/messages`, { text: 'go again' });
    await ctx.idle(parent);
    expect((await ctx.http.get('/approvals')).body.data).toEqual([]);
    expect(ctx.daemon.sdk.ran).toEqual([]);
    expect((await ctx.http.get('/sessions')).body.data).toHaveLength(1);
  });

  it('asks once for the whole list in every Access mode, and a yes starts a Session per Repo at once (4, 6, 7)', async () => {
    for (const mode of Object.values(AccessMode)) {
      const ctx = await start();
      const parent = await ctx.anonymous(mode);
      await ctx.http.patch(`/sessions/${parent}`, { model: Model.Haiku, effort: Effort.Low });
      const hold = await ctx.ask(parent, batch(ctx));
      const [approval, ...others] = await until(ctx.pending, (list) => list.length >= 1, `an Approval in ${mode}`);
      expect(others).toEqual([]);
      expect(approval?.summary).toContain('Start 2 Sessions');
      expect(approval?.summary).toContain(`web (${ctx.repos.web.dir}): Fix the cart total. … [35 characters]`);
      expect(approval?.summary).toContain(
        `billing (${ctx.repos.billing.dir}): Round invoices to two places. [29 characters]`,
      );
      expect((await ctx.http.get('/sessions')).body.data).toHaveLength(1);

      await ctx.http.post(`/approvals/${approval?.id}/decision`, { decision: 'approved' });
      // The fake SDK does not run the tool, so the test calls it as the tool would.
      const answer = await runSpawnSessions(ctx.spawner, parent, batch(ctx), 'call-1');
      expect(answer.isError).toBeUndefined();
      expect(answer.content[0]?.text).toMatch(/^started web as Session .+\nstarted billing as Session /);
      hold.open();

      // The parent's run and both children start with no waiting for one another.
      await until(
        () => ctx.daemon.sdk.calls.length,
        (count) => count === 3,
        'the children runs',
      );
      const children = ctx.daemon.sdk.calls.slice(1);
      for (const call of children) {
        expect(Object.keys(call.options.mcpServers ?? {})).toEqual(['ops-console']);
        expect(call.prompt).toContain('git switch -c');
        expect(call.prompt).toContain('open_pull_request');
        expect(call.prompt).toContain('leave them alone');
        expect(call.options.model).toBe(Model.Haiku);
      }
      const prompts = children.map((call) => call.prompt);
      expect(prompts.some((prompt) => prompt.startsWith('Fix the cart total.\nIt drops cents.'))).toBe(true);
      expect(prompts.some((prompt) => prompt.startsWith('Round invoices to two places.'))).toBe(true);

      const parentView = await ctx.session(parent);
      expect(parentView.spawned).toHaveLength(2);
      for (const child of parentView.spawned) {
        const view = await ctx.session(child.id);
        expect(view).toMatchObject({
          kind: SessionKind.Repo,
          branch: 'main',
          access_mode: mode,
          effort: Effort.Low,
          spawned_by: { id: parent },
        });
      }
    }
  });

  it('starts nothing when the operator says no, and tells the agent to stop asking (5)', async () => {
    const ctx = await start();
    const parent = await ctx.anonymous();
    await ctx.ask(parent, batch(ctx));
    const [approval] = await until(ctx.pending, (list) => list.length === 1, 'the Approval');
    await ctx.http.post(`/approvals/${approval?.id}/decision`, { decision: 'denied' });
    await ctx.idle(parent);
    expect(ctx.daemon.sdk.ran).toEqual([]);
    expect(ctx.daemon.sdk.calls).toHaveLength(1);
    expect((await ctx.session(parent)).spawned).toEqual([]);
    expect((await ctx.http.get('/sessions')).body.data).toHaveLength(1);
  });

  it('stopping the parent while the Approval waits denies the batch (12)', async () => {
    const ctx = await start();
    const parent = await ctx.anonymous();
    await ctx.ask(parent, batch(ctx));
    await until(ctx.pending, (list) => list.length === 1, 'the Approval');
    await ctx.http.post(`/sessions/${parent}/stop`);
    await ctx.idle(parent);
    expect((await ctx.http.get('/sessions')).body.data).toHaveLength(1);
    expect(ctx.daemon.sdk.calls).toHaveLength(1);
  });

  it('keeps the Session whose Repo folder is gone, failed with the reason, and the others run (8)', async () => {
    const ctx = await start();
    const parent = await ctx.anonymous();
    await rm(ctx.repos.web.dir, { recursive: true });
    const answer = await runSpawnSessions(ctx.spawner, parent, batch(ctx), 'call-1');
    expect(answer.content[0]?.text).toMatch(/^started web as Session .+\nstarted billing as Session /);
    const spawned = (await ctx.session(parent)).spawned as { id: string; repo_name: string }[];
    const web = spawned.find((one) => one.repo_name === 'web');
    const billing = spawned.find((one) => one.repo_name === 'billing');
    await until(
      async () => (await ctx.session(web?.id ?? '')).state,
      (state) => state === 'failed',
      'the web Session to fail',
    );
    expect((await ctx.session(web?.id ?? '')).last_error).toBeTruthy();
    await until(
      async () => (await ctx.session(billing?.id ?? '')).state,
      (state) => state === 'idle',
      'the billing Session to finish',
    );
    expect(ctx.daemon.sdk.calls).toHaveLength(1);
  });

  it('shows each child to its parent by call, and the parent to each child, until the parent is deleted (9, 10, 11)', async () => {
    const ctx = await start();
    const parent = await ctx.anonymous();
    const first = await runSpawnSessions(ctx.spawner, parent, { sessions: [{ repo: 'web', task: 'one' }] }, 'call-a');
    const second = await runSpawnSessions(
      ctx.spawner,
      parent,
      { sessions: [{ repo: 'billing', task: 'two' }] },
      'call-b',
    );
    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    await until(
      () => ctx.daemon.sdk.calls.length,
      (count) => count === 2,
      'the children runs',
    );
    const { spawned } = await ctx.session(parent);
    expect(spawned.map((child: { call_id: string; repo_name: string }) => [child.call_id, child.repo_name])).toEqual([
      ['call-a', 'web'],
      ['call-b', 'billing'],
    ]);
    const child = spawned[0].id as string;
    await ctx.idle(child);
    expect((await ctx.session(child)).spawned_by).toMatchObject({ id: parent });
    // The child is an ordinary Session: it sits in the Repo's list and stops or deletes alone.
    const listed = (await ctx.http.get('/sessions')).body.data as { id: string; repo_id: string | null }[];
    expect(listed.find((one) => one.id === child)?.repo_id).toBe(ctx.repos.web.id);
    expect((await ctx.http.delete(`/sessions/${spawned[1].id}`)).status).toBe(204);
    expect((await ctx.session(parent)).spawned).toHaveLength(1);

    await ctx.idle(parent);
    expect((await ctx.http.delete(`/sessions/${parent}`)).status).toBe(204);
    expect((await ctx.session(child)).spawned_by).toBeNull();
  });

  it('puts the call in the transcript, so the card survives a reload (9)', async () => {
    const ctx = await start();
    const parent = await ctx.anonymous();
    const hold = await ctx.ask(parent, batch(ctx));
    const [approval] = await until(ctx.pending, (list) => list.length === 1, 'the Approval');
    await ctx.http.post(`/approvals/${approval?.id}/decision`, { decision: 'approved' });
    hold.open();
    await ctx.idle(parent);
    const messages = (await ctx.http.get(`/sessions/${parent}/messages`)).body.data as {
      parts: { kind: string; call_id?: string; entries?: { repo: string }[] }[];
    }[];
    const part = messages.flatMap((message) => message.parts).find((one) => one.kind === 'spawn');
    expect(part?.entries?.map((entry) => entry.repo)).toEqual(['web', ctx.repos.billing.dir]);
    expect(part?.call_id).not.toBe('');
  });

  it('does not let a spawned Session spawn, join or lose the single-Session flow (2, 15)', async () => {
    const ctx = await start();
    const parent = await ctx.anonymous();
    await runSpawnSessions(ctx.spawner, parent, { sessions: [{ repo: 'web', task: 'one' }] }, 'call-a');
    const [child] = (await ctx.session(parent)).spawned as { id: string }[];
    expect(ctx.spawner.offers(child?.id ?? '')).toBe(false);
    expect(() => ctx.spawner.describe(child?.id ?? '', { sessions: [{ repo: 'billing', task: 'x' }] })).toThrow(
      /cannot start other Sessions/,
    );
    expect(ctx.spawner.offers(parent)).toBe(true);
  });
});
