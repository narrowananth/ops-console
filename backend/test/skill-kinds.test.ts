import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SessionKind, SKILL_LIMITS } from '@ops-console/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionKinds } from '../src/agent/session-kinds';
import { SKILL_CATALOG } from '../src/playbooks/skill-catalog';
import { type AgentDaemon, api, converse, gate, startAgentDaemon, until, WORKING_DIR } from './agent-fixtures';

const running: AgentDaemon[] = [];
const projectFolders: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const folder of projectFolders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function start() {
  const daemon = await startAgentDaemon();
  running.push(daemon);
  return { daemon, http: api(daemon) };
}

type Http = ReturnType<typeof api>;

const names = (body: { data: { items: { name: string }[] } }) => body.data.items.map((item) => item.name);

async function installCaveman(http: Http) {
  const installed = await http.post('/skill-packs/caveman/install');
  expect(installed.status).toBe(200);
}

async function custom(http: Http, name: string, description = `Use when ${name}.`) {
  const made = await http.post('/skills', { name, description, instructions: `Follow ${name}.` });
  expect(made.status).toBe(201);
  return made.body.data as { id: string };
}

/** A skill in the Repo's own folder, the way Claude Code reads it. */
async function projectSkill(name: string, description: string, header = true) {
  const folder = path.join(WORKING_DIR, '.claude', 'skills', name);
  projectFolders.push(path.join(WORKING_DIR, '.claude'));
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, 'SKILL.md'),
    header ? `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n` : 'No header here.\n',
  );
}

describe('Skill packs (Behavior 4, 5, 6)', () => {
  it('lists the catalog: Caveman with nine skills, Ops Console with nine', async () => {
    const { http } = await start();
    const { items } = (await http.get('/skill-packs')).body.data;
    expect(items.map((pack: { id: string }) => pack.id)).toEqual(['caveman', 'ops-console']);
    expect(items[0]).toMatchObject({ installed: false });
    expect(items[0].skills.map((skill: { name: string }) => skill.name)).toEqual([
      'caveman',
      'caveman-commit',
      'caveman-review',
      'investigate-first',
      'lean-build',
      'migration',
      'safe-refactor',
      'surgical-patch',
      'verify-and-stop',
    ]);
    expect(items[1]).toMatchObject({ installed: false });
    expect(items[1].skills.map((skill: { name: string }) => skill.name)).toEqual([
      'code-review',
      'commit-message',
      'grilling',
      'humanizer',
      'pr',
      'refactor',
      'retro',
      'ship',
      'spec',
    ]);
  });

  it('installs a pack once and refuses an unknown pack', async () => {
    const { http } = await start();
    await custom(http, 'zeta-method');
    expect((await http.post('/skill-packs/nope/install')).status).toBe(404);

    await installCaveman(http);
    await installCaveman(http);
    const { items } = (await http.get('/skills')).body.data;
    expect(items).toHaveLength(10);
    expect(items.map((item: { name: string }) => item.name)).toEqual([
      'caveman',
      'caveman-commit',
      'caveman-review',
      'investigate-first',
      'lean-build',
      'migration',
      'safe-refactor',
      'surgical-patch',
      'verify-and-stop',
      'zeta-method',
    ]);
    expect(items[0]).toMatchObject({ kind: 'builtin', pack: 'caveman', id: 'builtin:caveman/caveman' });
    expect(items[9]).toMatchObject({ kind: 'custom', pack: null });
    expect((await http.get('/skill-packs')).body.data.items[0].installed).toBe(true);
  });

  it('keeps a Built-in skill read-only (Behavior 3)', async () => {
    const { http } = await start();
    await installCaveman(http);
    const id = encodeURIComponent('builtin:caveman/migration');
    const edit = await http.patch(`/skills/${id}`, { description: 'Changed.' });
    expect([edit.status, edit.body.error.code]).toEqual([409, 'read_only']);
    expect((await http.delete(`/skills/${id}`)).body.error.code).toBe('read_only');
  });

  it('refuses a Custom name that is any built-in skill name, installed or not (Behavior 2)', async () => {
    const { http } = await start();
    for (const name of ['caveman', 'Caveman-Commit', 'PR', 'ship']) {
      const refused = await http.post('/skills', { name: name.toLowerCase(), description: 'd', instructions: 'i' });
      expect([refused.status, refused.body.error.code]).toEqual([409, 'duplicate']);
    }
    const ok = await custom(http, 'free-name');
    expect((await http.patch(`/skills/${ok.id}`, { name: 'surgical-patch' })).status).toBe(409);
  });
});

describe('Built-in skills on a Playbook (Behavior 7)', () => {
  it('holds Built-in and Custom together, counts both against eight, and drops them when the pack goes', async () => {
    const { http } = await start();
    await installCaveman(http);
    const mine = await custom(http, 'my-method');

    const unknown = await http.post('/playbooks', { name: 'Bad', skill_ids: ['builtin:ops-console/nothing'] });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'not_found']);

    const made = await http.post('/playbooks', {
      name: 'Mixed',
      skill_ids: [mine.id, 'builtin:caveman/caveman-commit'],
    });
    expect(made.status).toBe(201);
    expect(made.body.data.skills).toEqual([
      expect.objectContaining({ kind: 'builtin', name: 'caveman-commit', id: 'builtin:caveman/caveman-commit' }),
      expect.objectContaining({ kind: 'custom', name: 'my-method' }),
    ]);
    const held = (await http.get('/skills')).body.data.items.find(
      (item: { name: string }) => item.name === 'caveman-commit',
    );
    expect(held.playbooks).toEqual([{ id: made.body.data.id, name: 'Mixed' }]);

    // Nine across both kinds is one too many.
    const ids = SKILL_CATALOG[0]?.skills.slice(0, 8).map((skill) => `builtin:caveman/${skill.name}`) ?? [];
    const nine = await http.post('/playbooks', { name: 'Nine', skill_ids: [...ids, mine.id] });
    expect(nine.body.error.code).toBe('validation_failed');

    expect((await http.delete('/skill-packs/caveman/install')).status).toBe(204);
    const after = (await http.get('/playbooks')).body.data.items.find(
      (item: { name: string }) => item.name === 'Mixed',
    );
    expect(after.skills.map((item: { name: string }) => item.name)).toEqual(['my-method']);
    expect((await http.get('/skills')).body.data.items.map((item: { name: string }) => item.name)).toEqual([
      'my-method',
    ]);
    // A pack that is not installed cannot be attached.
    expect(
      (await http.patch(`/playbooks/${made.body.data.id}`, { skill_ids: ['builtin:caveman/caveman'] })).status,
    ).toBe(404);
  });
});

describe('The / menu (Behavior 8 to 12)', () => {
  it('lists Built-in and Custom for a Session with no Repo, A to Z', async () => {
    const { http } = await start();
    expect(names((await http.get('/skill-menu')).body)).toEqual([]);
    await installCaveman(http);
    await custom(http, 'alpha-method');
    const { items } = (await http.get('/skill-menu')).body.data;
    expect(items[0]).toMatchObject({ kind: 'custom', name: 'alpha-method', pack: null });
    expect(items[1]).toMatchObject({ kind: 'builtin', name: 'caveman', pack: 'caveman' });
    expect(items).toHaveLength(10);
  });

  it("adds the Repo's own skills to a Repo Session and skips a folder with no valid header", async () => {
    const { daemon, http } = await start();
    await installCaveman(http);
    await projectSkill('pr', 'Use when writing a PR body.');
    await projectSkill('broken', 'x', false);
    const session = daemon.createSession();
    const { items } = (await http.get(`/skill-menu?session_id=${session}`)).body.data;
    const project = items.filter((item: { kind: string }) => item.kind === 'project');
    expect(project).toEqual([{ kind: 'project', name: 'pr', description: 'Use when writing a PR body.', pack: null }]);
    expect(names({ data: { items } })).not.toContain('broken');
    // The same Repo, before its Session exists.
    const repo = (await http.get(`/sessions/${session}`)).body.data.repo_id as string;
    const early = (await http.get(`/skill-menu?repo_id=${repo}`)).body.data.items;
    expect(early.some((item: { name: string }) => item.name === 'pr')).toBe(true);
    expect((await http.get('/skill-menu?repo_id=nope')).status).toBe(404);
  });

  it('shows an Anonymous Session no Project skills, and a pull request reply Session no menu', async () => {
    const { daemon, http } = await start();
    await installCaveman(http);
    await projectSkill('pr', 'Use when writing a PR body.');
    daemon.app
      .get(SessionKinds)
      .register(SessionKind.Anonymous, { workingDir: () => WORKING_DIR, acceptsMessages: true });
    const anonymous = daemon.createSession({ kind: SessionKind.Anonymous });
    const anon = (await http.get(`/skill-menu?session_id=${anonymous}`)).body.data.items;
    expect(anon.some((item: { kind: string }) => item.kind === 'project')).toBe(false);
    expect(anon).toHaveLength(9);
    const review = daemon.createSession({ kind: SessionKind.PrReview });
    expect((await http.get(`/skill-menu?session_id=${review}`)).body.data.items).toEqual([]);
  });

  it('matches names first, then descriptions, A to Z, and shows a same name once per kind', async () => {
    const { daemon, http } = await start();
    await installCaveman(http);
    await projectSkill('caveman-commit', 'Project copy of commit rules.');
    await projectSkill('code-review', 'Review the changes.');
    await projectSkill('codebase-design', 'Shared vocabulary for deep modules.');
    const session = daemon.createSession();
    const match = (q: string) =>
      http
        .get(`/skill-menu?session_id=${session}&q=${encodeURIComponent(q)}`)
        .then((res) => res.body.data.items.map((item: { kind: string; name: string }) => `${item.kind}:${item.name}`));
    const code = await match('/code');
    // Names that hold "code" come first; then descriptions that do (caveman-review: "Compressed code review").
    expect(code.slice(0, 2)).toEqual(['project:code-review', 'project:codebase-design']);
    expect(code).toContain('builtin:caveman-review');
    expect(code.indexOf('builtin:caveman-review')).toBeGreaterThan(1);
    expect(await match('CAVEMAN-COM')).toEqual(['project:caveman-commit', 'builtin:caveman-commit']);
    // "pr": the skill named pr comes before names that only hold it, which come before descriptions.
    await projectSkill('pr', 'Use when writing a PR body.');
    await projectSkill('improve-architecture', 'Scan a codebase.');
    const pr = await match('pr');
    expect(pr.slice(0, 2)).toEqual(['project:pr', 'project:improve-architecture']);
    expect(await match('zzz-nothing')).toEqual([]);
  });
});

describe('Running a message (Behavior 13 to 16, 18, 20)', () => {
  const lastCall = (daemon: AgentDaemon) => daemon.sdk.calls.at(-1);
  const append = (daemon: AgentDaemon) =>
    (lastCall(daemon)?.options.systemPrompt as { append?: string } | undefined)?.append ?? '';

  async function withPlaybook(http: Http, skillIds: string[] = []) {
    const made = await http.post('/playbooks', { name: 'Held', rules: 'RULE-FROM-PLAYBOOK', skill_ids: skillIds });
    await http.put('/playbook-triggers/session_message', { playbook_id: made.body.data.id });
  }

  it('runs a Built-in skill alone with no Playbook rules or Skills, for that message only', async () => {
    const { daemon, http } = await start();
    await installCaveman(http);
    const other = await custom(http, 'playbook-skill');
    await withPlaybook(http, [other.id]);
    const session = daemon.createSession();

    await converse(daemon, session, '/caveman-commit only the tax fix');
    const call = lastCall(daemon);
    expect(call?.prompt).toBe('Use the "ops-console-skills:caveman-commit" skill for this task.\n\nonly the tax fix');
    expect(append(daemon)).not.toContain('RULE-FROM-PLAYBOOK');
    // The skill is added; the other skills the agent can find stay available.
    expect(call?.options.plugins).toHaveLength(1);
    expect(call?.options).not.toHaveProperty('skills');

    await converse(daemon, session, 'a plain message');
    expect(lastCall(daemon)?.prompt).toBe('a plain message');
    expect(append(daemon)).toContain('RULE-FROM-PLAYBOOK');
    expect(lastCall(daemon)?.options.skills).toEqual(['ops-console-skills:playbook-skill']);
  });

  it('hands a Custom skill to the run as a plugin holding that one skill, and removes it after (Behavior 20)', async () => {
    const { daemon, http } = await start();
    await custom(http, 'house-style');
    await withPlaybook(http);
    const held = gate();
    daemon.sdk.script({ wait: held.promise }, { text: 'Done.' });
    const session = daemon.createSession();
    const sent = await http.post(`/sessions/${session}/messages`, { text: '/house-style' });
    expect(sent.status).toBe(202);
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 1,
      'the run to start',
    );
    const folder = (lastCall(daemon)?.options.plugins?.[0] as { path: string } | undefined)?.path ?? '';
    expect(lastCall(daemon)?.prompt).toBe('Use the "ops-console-skills:house-style" skill for this task.');
    expect(await readFile(path.join(folder, 'skills', 'house-style', 'SKILL.md'), 'utf8')).toContain(
      'Follow house-style.',
    );
    expect(append(daemon)).not.toContain('RULE-FROM-PLAYBOOK');
    held.open();
    await until(
      () => existsSync(folder),
      (exists) => !exists,
      'the folder to go',
    );
  });

  it('runs a Project skill from the Repo with no plugin and no Playbook', async () => {
    const { daemon, http } = await start();
    await projectSkill('pr', 'Use when writing a PR body.');
    await withPlaybook(http);
    const session = daemon.createSession();
    await converse(daemon, session, '/pr for the tax fix');
    const call = lastCall(daemon);
    expect(call?.prompt).toBe('Use the "pr" skill for this task.\n\nfor the tax fix');
    expect(call?.options).not.toHaveProperty('plugins');
    expect(call?.options).not.toHaveProperty('skills');
    expect(append(daemon)).not.toContain('RULE-FROM-PLAYBOOK');
  });

  it('resolves a typed name Project first, then Custom, and runs the Playbook when it matches none', async () => {
    const { daemon, http } = await start();
    await installCaveman(http);
    await projectSkill('caveman-commit', 'Project copy.');
    await withPlaybook(http);
    const session = daemon.createSession();
    await converse(daemon, session, '/caveman-commit');
    expect(lastCall(daemon)?.prompt).toBe('Use the "caveman-commit" skill for this task.');
    await converse(daemon, session, '/no-such-skill hello');
    expect(lastCall(daemon)?.prompt).toBe('/no-such-skill hello');
    expect(append(daemon)).toContain('RULE-FROM-PLAYBOOK');
  });

  it('runs the exact skill picked from the menu, and refuses one that is gone without starting a run', async () => {
    const { daemon, http } = await start();
    await installCaveman(http);
    await projectSkill('caveman-commit', 'Project copy.');
    const session = daemon.createSession();
    await http.post(`/sessions/${session}/messages`, {
      text: '/caveman-commit',
      skill: { kind: 'builtin', name: 'caveman-commit' },
    });
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 1,
      'the run',
    );
    expect(lastCall(daemon)?.prompt).toBe('Use the "ops-console-skills:caveman-commit" skill for this task.');
    await until(
      async () => (await http.get(`/sessions/${session}`)).body.data.state,
      (state) => state === 'idle',
      'the run to end',
    );

    const before = daemon.sdk.calls.length;
    const gone = await http.post(`/sessions/${session}/messages`, {
      text: '/ghost do it',
      skill: { kind: 'custom', name: 'ghost' },
    });
    expect([gone.status, gone.body.error.code]).toEqual([404, 'skill_not_found']);
    expect(daemon.sdk.calls.length).toBe(before);
    expect((await http.get(`/sessions/${session}`)).body.data.state).toBe('idle');
    // A Project skill picked in a Session with no Repo is gone too.
    daemon.app
      .get(SessionKinds)
      .register(SessionKind.Anonymous, { workingDir: () => WORKING_DIR, acceptsMessages: true });
    const anonymous = daemon.createSession({ kind: SessionKind.Anonymous });
    const none = await http.post(`/sessions/${anonymous}/messages`, {
      text: '/caveman-commit',
      skill: { kind: 'project', name: 'caveman-commit' },
    });
    expect(none.body.error.code).toBe('skill_not_found');
  });

  it('shows the message as typed with its skill after a reload (Behavior 17)', async () => {
    const { daemon, http } = await start();
    await installCaveman(http);
    const session = daemon.createSession();
    await converse(daemon, session, '/caveman-review the auth change');
    await converse(daemon, session, 'thanks');
    const messages = (await http.get(`/sessions/${session}/messages`)).body.data;
    const users = messages.filter((message: { role: string }) => message.role === 'user');
    expect(users[0]).toMatchObject({
      parts: [{ kind: 'text', text: '/caveman-review the auth change' }],
      skill: { kind: 'builtin', name: 'caveman-review' },
    });
    expect(users[1].skill).toBeNull();
  });

  it('keeps the skill when the message is edited with a leading /name, and drops it when the name goes (Behavior 21)', async () => {
    const { daemon, http } = await start();
    await installCaveman(http);
    await withPlaybook(http);
    const session = daemon.createSession();
    await converse(daemon, session, '/caveman-commit first');
    const edit = async (text: string) => {
      const last = (await http.get(`/sessions/${session}/messages`)).body.data.findLast(
        (m: { role: string }) => m.role === 'user',
      );
      const res = await http.post(`/sessions/${session}/messages/${last.id}/edit`, { text });
      expect(res.status).toBe(202);
      await until(
        async () => (await http.get(`/sessions/${session}`)).body.data.state,
        (state) => state === 'idle',
        'the run to end',
      );
    };
    await edit('/caveman-review second');
    expect(lastCall(daemon)?.prompt).toBe('Use the "ops-console-skills:caveman-review" skill for this task.\n\nsecond');
    await edit('no skill any more');
    expect(lastCall(daemon)?.prompt).toBe('no skill any more');
    expect(append(daemon)).toContain('RULE-FROM-PLAYBOOK');
  });

  it('goes on with the same skill when a stopped run is played again (Behavior 21)', async () => {
    const { daemon, http } = await start();
    await installCaveman(http);
    const held = gate();
    daemon.sdk.script({ wait: held.promise });
    const session = daemon.createSession();
    await http.post(`/sessions/${session}/messages`, { text: '/caveman-review the diff' });
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 1,
      'the run to start',
    );
    expect((await http.post(`/sessions/${session}/stop`, {})).status).toBe(204);
    await until(
      async () => (await http.get(`/sessions/${session}`)).body.data.state,
      (state) => state === 'idle',
      'the run to stop',
    );
    expect((await http.post(`/sessions/${session}/resume`, {})).status).toBe(202);
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 2,
      'the second run',
    );
    expect(lastCall(daemon)?.prompt).toMatch(/^Use the "ops-console-skills:caveman-review" skill for this task\.\n\n/);
  });
});

describe('Skills after a pack goes (Behavior 6)', () => {
  it('drops the pack from the menu, and refuses a picked skill from it', async () => {
    const { daemon, http } = await start();
    await installCaveman(http);
    const session = daemon.createSession();
    expect((await http.get(`/skill-menu?session_id=${session}`)).body.data.items).toHaveLength(9);
    await http.delete('/skill-packs/caveman/install');
    expect((await http.get(`/skill-menu?session_id=${session}`)).body.data.items).toEqual([]);
    const refused = await http.post(`/sessions/${session}/messages`, {
      text: '/caveman',
      skill: { kind: 'builtin', name: 'caveman' },
    });
    expect(refused.body.error.code).toBe('skill_not_found');
  });
});

describe('The Ops Console pack', () => {
  const NAME = /^[a-z0-9-]+$/;

  it('holds only skills a run can write: a valid name, and a description and instructions within the limits', () => {
    for (const pack of SKILL_CATALOG) {
      for (const skill of pack.skills) {
        expect(skill.name).toMatch(NAME);
        expect(skill.name.length).toBeLessThanOrEqual(SKILL_LIMITS.name);
        expect(skill.description.length).toBeLessThanOrEqual(SKILL_LIMITS.description);
        expect(skill.instructions.length).toBeLessThanOrEqual(SKILL_LIMITS.instructions);
      }
    }
  });

  it('gives a skill message the whole pack, so /ship can run the skills it names, and leaves the other pack out', async () => {
    const { daemon, http } = await start();
    await http.post('/skill-packs/ops-console/install');
    await installCaveman(http);
    const session = daemon.createSession();
    const menu = (await http.get(`/skill-menu?session_id=${session}&q=ship`)).body.data.items;
    expect(menu[0]).toMatchObject({ kind: 'builtin', name: 'ship', pack: 'ops-console' });

    const running = gate();
    daemon.sdk.script({ wait: running.promise }, { text: 'Done.' });
    await http.post(`/sessions/${session}/messages`, { text: '/ship the skill-menu spec' });
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 1,
      'the run to start',
    );
    const call = daemon.sdk.calls[0];
    expect(call?.prompt).toBe('Use the "ops-console-skills:ship" skill for this task.\n\nthe skill-menu spec');
    expect(call?.options).not.toHaveProperty('skills');
    const folder = (call?.options.plugins?.[0] as { path: string } | undefined)?.path ?? '';
    expect(readdirSync(path.join(folder, 'skills')).sort()).toEqual(
      SKILL_CATALOG[1]?.skills.map((skill) => skill.name).sort(),
    );
    const text = await readFile(path.join(folder, 'skills', 'ship', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---\nname: "ship"\ndescription: "/);
    running.open();
    await until(
      async () => (await http.get(`/sessions/${session}`)).body.data.state,
      (state) => state === 'idle',
      'the run to end',
    );
  });
});

describe('The migration (Settled: Names)', () => {
  it('renames a Custom Skill that already has a built-in skill name, and again when that is taken', () => {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE sessions (id text primary key); CREATE TABLE playbooks (id text primary key); CREATE TABLE skills (id text primary key, name text not null, description text, instructions text); CREATE UNIQUE INDEX skills_name_idx ON skills (name COLLATE NOCASE);',
    );
    const add = db.prepare('INSERT INTO skills VALUES (?, ?, ?, ?)');
    for (const [id, name] of [
      ['1', 'Caveman'],
      ['2', 'migration'],
      ['3', 'migration-custom'],
      ['4', 'mine'],
    ] as const) {
      add.run(id, name, 'd', 'i');
    }
    const file = path.join(import.meta.dirname, '../drizzle/0030_skill_kinds.sql');
    for (const statement of readFileSync(file, 'utf8').split('--> statement-breakpoint')) db.exec(statement);
    const names = db.prepare('SELECT id, name FROM skills ORDER BY id').all();
    expect(names).toEqual([
      { id: '1', name: 'Caveman-custom' },
      { id: '2', name: 'migration-custom-2' },
      { id: '3', name: 'migration-custom' },
      { id: '4', name: 'mine' },
    ]);
  });
});
