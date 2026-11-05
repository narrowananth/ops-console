import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessMode, SKILL_LIMITS } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime';
import { type AgentDaemon, api, converse, gate, startAgentDaemon, until } from './agent-fixtures';

const running: AgentDaemon[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

async function start() {
  const daemon = await startAgentDaemon();
  running.push(daemon);
  return { daemon, http: api(daemon) };
}

type Http = ReturnType<typeof api>;

const skill = (name: string, extra: object = {}) => ({
  name,
  description: `Use when the work calls for ${name}.`,
  instructions: `Follow the ${name} method.`,
  ...extra,
});

async function createSkill(http: Http, name: string, extra: object = {}) {
  const created = await http.post('/skills', skill(name, extra));
  expect(created.status).toBe(201);
  return created.body.data as { id: string; name: string };
}

async function createPlaybook(http: Http, name: string, skillIds: string[] = []) {
  const created = await http.post('/playbooks', { name, skill_ids: skillIds });
  expect(created.status).toBe(201);
  return created.body.data as { id: string; skills: { id: string; name: string }[] };
}

describe('Skills', () => {
  it('lists Skills A to Z with the Playbooks that hold each (Behavior 1)', async () => {
    const { http } = await start();
    expect((await http.get('/skills')).body.data.items).toEqual([]);
    const zebra = await createSkill(http, 'zebra-method');
    const alpha = await createSkill(http, 'alpha-method');
    await createPlaybook(http, 'Second', [zebra.id]);
    await createPlaybook(http, 'First', [zebra.id, alpha.id]);

    const { items } = (await http.get('/skills')).body.data;
    expect(items.map((item: { name: string }) => item.name)).toEqual(['alpha-method', 'zebra-method']);
    expect(items[1].playbooks.map((playbook: { name: string }) => playbook.name)).toEqual(['First', 'Second']);
  });

  it('refuses a bad name, an empty field, a field over its limit, and a name taken ignoring case (Behavior 2, 3)', async () => {
    const { http } = await start();
    for (const body of [
      skill('Has Capitals'),
      skill('under_score'),
      skill('has space'),
      skill('x'.repeat(SKILL_LIMITS.name + 1)),
      skill('ok', { description: '' }),
      skill('ok', { instructions: '   ' }),
      skill('ok', { description: 'd'.repeat(SKILL_LIMITS.description + 1) }),
      skill('ok', { instructions: 'i'.repeat(SKILL_LIMITS.instructions + 1) }),
    ]) {
      expect((await http.post('/skills', body)).body.error.code).toBe('validation_failed');
    }
    expect((await http.get('/skills')).body.data.items).toEqual([]);

    const first = await createSkill(http, 'debugging');
    const other = await createSkill(http, 'review');
    const clash = await http.post('/skills', skill('debugging'));
    expect([clash.status, clash.body.error.code]).toEqual([409, 'duplicate']);
    expect((await http.patch(`/skills/${other.id}`, { name: 'debugging' })).status).toBe(409);
    // Saving a Skill under its own name is no clash.
    expect((await http.patch(`/skills/${first.id}`, { name: 'debugging', description: 'New text.' })).status).toBe(200);
  });

  it('edits a Skill, and renaming shows in every Playbook that holds it (Behavior 5)', async () => {
    const { http } = await start();
    const made = await createSkill(http, 'old-name');
    const playbook = await createPlaybook(http, 'Holder', [made.id]);
    const patched = await http.patch(`/skills/${made.id}`, { name: 'new-name', instructions: 'Changed.' });
    expect(patched.body.data).toMatchObject({ name: 'new-name', instructions: 'Changed.' });
    const held = (await http.get('/playbooks')).body.data.items.find((item: { id: string }) => item.id === playbook.id);
    expect(held.skills).toEqual([{ id: made.id, name: 'new-name', description: expect.any(String) }]);
    expect((await http.patch('/skills/nope', { name: 'x' })).status).toBe(404);
  });

  it('deleting a Skill takes it off its Playbooks and leaves them (Behavior 4)', async () => {
    const { http } = await start();
    const made = await createSkill(http, 'going');
    const keep = await createSkill(http, 'staying');
    const playbook = await createPlaybook(http, 'Holder', [made.id, keep.id]);
    expect((await http.delete(`/skills/${made.id}`)).status).toBe(204);
    expect((await http.delete(`/skills/${made.id}`)).status).toBe(404);
    const held = (await http.get('/playbooks')).body.data.items.find((item: { id: string }) => item.id === playbook.id);
    expect(held.skills.map((item: { name: string }) => item.name)).toEqual(['staying']);
  });
});

describe('Skills on a Playbook', () => {
  it('holds up to eight, A to Z, refuses a ninth, a repeat and an unknown Skill (Behavior 6, 7)', async () => {
    const { http } = await start();
    const ids: string[] = [];
    for (const name of ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a', 'i']) ids.push((await createSkill(http, name)).id);

    const nine = await http.post('/playbooks', { name: 'Nine', skill_ids: ids });
    expect([nine.status, nine.body.error.code]).toEqual([400, 'validation_failed']);
    const twice = await http.post('/playbooks', { name: 'Twice', skill_ids: [ids[0], ids[0]] });
    expect(twice.status).toBe(400);
    const unknown = await http.post('/playbooks', { name: 'Unknown', skill_ids: ['nope'] });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'not_found']);

    const eight = await createPlaybook(http, 'Eight', ids.slice(0, 8));
    expect(eight.skills.map((item) => item.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    // Removing a Skill from a Playbook does not delete it.
    const patched = await http.patch(`/playbooks/${eight.id}`, { skill_ids: [ids[0]] });
    expect(patched.body.data.skills.map((item: { name: string }) => item.name)).toEqual(['h']);
    expect((await http.get('/skills')).body.data.items).toHaveLength(9);
    // A patch that leaves skill_ids out keeps them.
    expect((await http.patch(`/playbooks/${eight.id}`, { rules: 'New.' })).body.data.skills).toHaveLength(1);
  });

  it('lets a read-only Trigger hold Skills; built-ins hold none (Behavior 8)', async () => {
    const { http } = await start();
    const made = await createSkill(http, 'reader');
    const playbook = await createPlaybook(http, 'Review it', [made.id]);
    expect((await http.put('/playbook-triggers/review_pr', { playbook_id: playbook.id })).status).toBe(200);
    const items = (await http.get('/playbooks')).body.data.items;
    expect(
      items.filter((item: { builtin: boolean }) => item.builtin).every((item: { skills: [] }) => !item.skills.length),
    ).toBe(true);
    expect((await http.patch('/playbooks/builtin:verify', { skill_ids: [made.id] })).status).toBe(409);
  });
});

describe('Skills in a run', () => {
  const optionsOf = (daemon: AgentDaemon) => daemon.sdk.calls.at(-1)?.options;

  async function holdSessionMessage(http: Http, ids: string[]) {
    const playbook = await createPlaybook(http, 'With Skills', ids);
    await http.put('/playbook-triggers/session_message', { playbook_id: playbook.id });
    return playbook;
  }

  it('hands the run its Skills as a plugin the sandbox can read, and removes it when the run ends (Behavior 11, 16)', async () => {
    const { daemon, http } = await start();
    const first = await createSkill(http, 'debugging', { description: 'Use it: "quoted" and\nmultiline.' });
    const second = await createSkill(http, 'review');
    await holdSessionMessage(http, [first.id, second.id]);

    const held = gate();
    daemon.sdk.script({ wait: held.promise }, { text: 'Done.' });
    const session = daemon.createSession();
    expect((await http.post(`/sessions/${session}/messages`, { text: 'go' })).status).toBe(202);
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 1,
      'the run to start',
    );

    const options = optionsOf(daemon);
    const plugin = options?.plugins?.[0];
    expect(plugin).toMatchObject({ type: 'local' });
    const folder = (plugin as { path: string }).path;
    expect(options?.skills).toEqual(['ops-console-skills:debugging', 'ops-console-skills:review']);
    expect(
      (options?.sandbox as { filesystem?: { allowRead?: string[] } } | undefined)?.filesystem?.allowRead,
    ).toContain(folder);
    expect(JSON.parse(await readFile(path.join(folder, '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({
      name: 'ops-console-skills',
    });
    const text = await readFile(path.join(folder, 'skills', 'debugging', 'SKILL.md'), 'utf8');
    expect(text).toContain('Follow the debugging method.');
    expect(text).toMatch(/^---\nname: "debugging"\ndescription: "Use it: \\"quoted\\" and\\nmultiline\."\n---/);
    // The text reaches the agent through the Skill tool, not the prompt.
    expect((options?.systemPrompt as { append?: string } | undefined)?.append).not.toContain(
      'Follow the debugging method.',
    );

    held.open();
    await until(
      async () => (await http.get(`/sessions/${session}`)).body.data.state,
      (state) => state === 'idle',
      'the run to end',
    );
    expect(existsSync(folder)).toBe(false);
  });

  it('runs a Playbook with no Skills as before (Behavior 13)', async () => {
    const { daemon, http } = await start();
    await holdSessionMessage(http, []);
    await converse(daemon, daemon.createSession(), 'go');
    expect(optionsOf(daemon)).not.toHaveProperty('plugins');
    expect(optionsOf(daemon)).not.toHaveProperty('skills');
  });

  it('keeps the safety lines after the Playbook rules with Skills attached, and merge stays denied (Behavior 12)', async () => {
    const { daemon, http } = await start();
    const merge = await createSkill(http, 'merge-it', { instructions: 'Merge the pull request.' });
    const playbook = await createPlaybook(http, 'With rules', [merge.id]);
    await http.patch(`/playbooks/${playbook.id}`, { rules: 'RULE-FROM-PLAYBOOK' });
    await http.put('/playbook-triggers/session_message', { playbook_id: playbook.id });
    await converse(daemon, daemon.createSession(), 'go');
    const append = (optionsOf(daemon)?.systemPrompt as { append?: string } | undefined)?.append ?? '';
    expect(append.indexOf('RULE-FROM-PLAYBOOK')).toBeGreaterThan(-1);
    expect(append.indexOf('RULE-FROM-PLAYBOOK')).toBeLessThan(append.indexOf('Console safety rules'));
    expect(optionsOf(daemon)?.disallowedTools).toEqual(expect.arrayContaining(['Bash(gh pr merge:*)']));
  });

  it("reads the Playbook's Skills at each message (Behavior 10)", async () => {
    const { daemon, http } = await start();
    const made = await createSkill(http, 'first-skill');
    await holdSessionMessage(http, [made.id]);
    const session = daemon.createSession();
    await converse(daemon, session, 'one');
    expect(optionsOf(daemon)?.skills).toEqual(['ops-console-skills:first-skill']);
    await http.patch(`/skills/${made.id}`, { name: 'renamed-skill' });
    await converse(daemon, session, 'two');
    expect(optionsOf(daemon)?.skills).toEqual(['ops-console-skills:renamed-skill']);
    await http.delete(`/skills/${made.id}`);
    await converse(daemon, session, 'three');
    expect(optionsOf(daemon)).not.toHaveProperty('skills');
  });

  it('fails the run with the reason when the Skills cannot be handed over, and never runs without them (Behavior 15)', async () => {
    const { daemon, http } = await start();
    await holdSessionMessage(http, [(await createSkill(http, 'needed')).id]);
    // A file where the temp folder should be makes the run's folder impossible to make.
    const blocker = path.join(daemon.dataDir, 'not-a-folder');
    await writeFile(blocker, 'in the way');
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = blocker;
    try {
      const session = daemon.createSession();
      const summary = await daemon.app.get(AgentRuntime).runFor(session, 'go', null, {
        skills: [{ id: 'x', name: 'needed', description: 'd', instructions: 'i' }],
      }).finished;
      expect(summary).toMatchObject({ ok: false });
      expect(summary.failure).toMatch(/^could not hand the Skills to the run: /);
      expect(daemon.sdk.ran).toEqual([]);
    } finally {
      if (tmp === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
      else process.env.TMPDIR = tmp;
    }
  });

  it('removes the folder of a run the operator stops (Behavior 16)', async () => {
    const { daemon, http } = await start();
    await holdSessionMessage(http, [(await createSkill(http, 'stopped')).id]);
    const held = gate();
    daemon.sdk.script({ wait: held.promise });
    const session = daemon.createSession();
    await http.post(`/sessions/${session}/messages`, { text: 'go' });
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 1,
      'the run to start',
    );
    const folder = (optionsOf(daemon)?.plugins?.[0] as { path?: string } | undefined)?.path ?? '';
    expect(existsSync(folder)).toBe(true);
    expect((await http.post(`/sessions/${session}/stop`, {})).status).toBe(204);
    await until(
      () => existsSync(folder),
      (exists) => !exists,
      'the folder to go',
    );
  });

  it('gives two Sessions their own copies (Behavior 16)', async () => {
    const { daemon, http } = await start();
    await holdSessionMessage(http, [(await createSkill(http, 'shared')).id]);
    const a = gate();
    const b = gate();
    daemon.sdk.script({ wait: a.promise }, { text: 'a' });
    daemon.sdk.script({ wait: b.promise }, { text: 'b' });
    const sessions = [daemon.createSession(), daemon.createSession()];
    for (const id of sessions) await http.post(`/sessions/${id}/messages`, { text: 'go' });
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 2,
      'both runs to start',
    );
    const folders = daemon.sdk.calls.map((call) => (call.options.plugins?.[0] as { path?: string } | undefined)?.path);
    expect(new Set(folders).size).toBe(2);
    a.open();
    await until(
      () => existsSync(folders[0] ?? ''),
      (exists) => !exists,
      'the first folder to go',
    );
    expect(existsSync(folders[1] ?? '')).toBe(true);
    b.open();
    await until(
      () => existsSync(folders[1] ?? ''),
      (exists) => !exists,
      'the second folder to go',
    );
  });

  it("records a Skill the agent loads in the Action Log, by the Skill's name (Behavior 14)", async () => {
    const { daemon, http } = await start();
    const session = daemon.createSession({ access_mode: AccessMode.Full });
    daemon.sdk.script({ tool: 'Skill', input: { skill: 'ops-console-skills:debugging' } }, { text: 'Done.' });
    await converse(daemon, session, 'go');
    const rows = (await http.get(`/action-log?session_id=${session}`)).body.data;
    expect(rows).toEqual([expect.objectContaining({ kind: 'skill', command: 'Skill debugging', outcome: 'ok' })]);
  });
});
