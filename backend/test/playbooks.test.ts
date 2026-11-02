import { PlaybookTrigger, PR_DESCRIPTION_RULE } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_RULES, BUILTIN_STEPS } from '../src/playbooks/builtins';
import { type AgentDaemon, api, converse, startAgentDaemon } from './agent-fixtures';

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

const step = (title: string, writes = false, block = 'custom') => ({
  block,
  title,
  instructions: `Do ${title.toLowerCase()}.`,
  writes,
});

async function create(http: Http, name: string, extra: object = {}) {
  const created = await http.post('/playbooks', { name, ...extra });
  expect(created.status).toBe(201);
  return created.body.data as { id: string; name: string; jira_ticket: boolean };
}

const list = (http: Http) => http.get('/playbooks').then((res) => res.body.data);

describe('Playbooks and Triggers', () => {
  it('lists the seven built-ins, each on its Trigger, and the ten Step blocks', async () => {
    const { http } = await start();
    const { items, blocks } = await list(http);
    expect(items.map((p: { id: string; triggers: string[] }) => [p.id, p.triggers])).toEqual([
      ['builtin:verify', ['verify']],
      ['builtin:fix', ['fix']],
      ['builtin:review_pr', ['review_pr']],
      ['builtin:check_reply', ['check_reply']],
      ['builtin:address_comments', ['address_comments']],
      ['builtin:thread_reply', ['thread_reply']],
      ['builtin:session_message', ['session_message']],
    ]);
    // Each built-in carries its rules and steps, and Duplicate saves it within the limits.
    for (const trigger of Object.values(PlaybookTrigger)) {
      const builtin = items.find((p: { id: string }) => p.id === `builtin:${trigger}`);
      expect(builtin.rules).not.toBe('');
      expect(builtin).toMatchObject({
        rules: BUILTIN_RULES[trigger],
        steps: BUILTIN_STEPS[trigger],
        jira_ticket: false,
      });
      const copy = await http.post('/playbooks', {
        name: `${trigger} copy`,
        rules: builtin.rules,
        branches: builtin.branches,
        steps: builtin.steps,
      });
      expect([copy.status, copy.body.data?.steps]).toEqual([201, builtin.steps]);
    }
    const tags = (id: string) =>
      items.find((p: { id: string }) => p.id === id).steps.map((s: { writes: boolean }) => s.writes);
    // Review PR runs its tests in a scratch copy; the chats have no steps.
    expect(tags('builtin:review_pr')).toContain(true);
    expect(tags('builtin:thread_reply')).toEqual([]);
    expect(tags('builtin:session_message')).toEqual([]);
    expect(blocks.map((b: { title: string; writes: boolean }) => [b.title, b.writes])).toEqual([
      ['Trace the log through the code', false],
      ['Find the Repo that owns it', false],
      ['Find who else uses it', false],
      ['Read real data from Connections', false],
      ['Replay the request locally', true],
      ['Make mock data', true],
      ['Run the tests', true],
      ['Test a lasting fix', true],
      ['Check PROD readiness', false],
      ['Custom step', false],
    ]);
  });

  it('keeps built-ins read-only', async () => {
    const { http } = await start();
    for (const response of [
      await http.patch('/playbooks/builtin:verify', { rules: 'x' }),
      await http.delete('/playbooks/builtin:verify'),
    ]) {
      expect([response.status, response.body.error.code]).toEqual([409, 'invalid_state']);
    }
  });

  it('holds the limits, and a name once without regard to case', async () => {
    const { http } = await start();
    const empty = await create(http, 'Checkout deep check');
    expect(empty).toMatchObject({ rules: '', steps: [], triggers: [], builtin: false, jira_ticket: false });
    const ticketed = await create(http, 'Ticketed fix', { jira_ticket: true });
    expect(ticketed).toMatchObject({ jira_ticket: true });
    await http.patch(`/playbooks/${ticketed.id}`, { rules: 'Keep it small.' });
    await http.patch(`/playbooks/${empty.id}`, { jira_ticket: true });
    const saved = (await list(http)).items;
    const ticket = (id: string) => saved.find((p: { id: string }) => p.id === id).jira_ticket;
    expect([ticket(ticketed.id), ticket(empty.id)]).toEqual([true, true]);
    expect((await http.patch(`/playbooks/${empty.id}`, { jira_ticket: 'yes' })).body.error.code).toBe(
      'validation_failed',
    );
    const refused = [
      await http.post('/playbooks', { name: 'x'.repeat(61) }),
      await http.post('/playbooks', { name: 'a', rules: 'r'.repeat(8001) }),
      await http.post('/playbooks', { name: 'a', steps: Array.from({ length: 13 }, (_, i) => step(`S${i}`)) }),
      await http.post('/playbooks', { name: 'a', steps: [step('t'.repeat(81))] }),
      await http.post('/playbooks', { name: 'a', steps: [{ ...step('S'), instructions: 'i'.repeat(4001) }] }),
      await http.post('/playbooks', { name: 'a', steps: [step('S', false, 'no_such_block')] }),
    ];
    expect(refused.map((r) => r.body.error.code)).toEqual(Array(6).fill('validation_failed'));
    const twice = await http.post('/playbooks', { name: 'CHECKOUT deep check' });
    expect([twice.status, twice.body.error.code]).toEqual([409, 'duplicate']);
    const other = await create(http, 'Safe DB fix');
    const renamed = await http.patch(`/playbooks/${other.id}`, { name: 'checkout DEEP check' });
    expect(renamed.body.error.code).toBe('duplicate');
  });

  it('attaches one Playbook to several Triggers, replaces one, and detaches back to the built-in', async () => {
    const { http } = await start();
    const deep = await create(http, 'Checkout deep check', { steps: [step('Trace')] });
    const safe = await create(http, 'Safe DB fix');
    await http.put('/playbook-triggers/verify', { playbook_id: deep.id });
    const attached = await http.put('/playbook-triggers/session_message', { playbook_id: deep.id });
    expect(attached.status).toBe(200);
    const holding = (items: { id: string; triggers: string[] }[], id: string) =>
      items.find((p) => p.id === id)?.triggers;
    expect(holding(attached.body.data, deep.id)).toEqual(['verify', 'session_message']);
    expect(holding(attached.body.data, 'builtin:verify')).toEqual([]);

    const replaced = await http.put('/playbook-triggers/verify', { playbook_id: safe.id });
    expect(holding(replaced.body.data, deep.id)).toEqual(['session_message']);
    expect(holding(replaced.body.data, safe.id)).toEqual(['verify']);

    const detached = await http.put('/playbook-triggers/verify', { playbook_id: null });
    expect(holding(detached.body.data, safe.id)).toEqual([]);
    expect(holding(detached.body.data, 'builtin:verify')).toEqual(['verify']);

    expect((await http.put('/playbook-triggers/scan', { playbook_id: null })).body.error.code).toBe(
      'validation_failed',
    );
    expect((await http.put('/playbook-triggers/verify', { playbook_id: 'nope' })).body.error.code).toBe('not_found');
  });

  it('puts the built-ins back on every Trigger a deleted Playbook held', async () => {
    const { http } = await start();
    const safe = await create(http, 'Safe DB fix');
    await http.put('/playbook-triggers/fix', { playbook_id: safe.id });
    await http.put('/playbook-triggers/session_message', { playbook_id: safe.id });
    expect((await http.delete(`/playbooks/${safe.id}`)).status).toBe(204);
    const { items } = await list(http);
    expect(items.map((p: { id: string }) => p.id)).not.toContain(safe.id);
    expect(items.filter((p: { triggers: string[] }) => p.triggers.length === 1)).toHaveLength(7);
    expect((await http.delete(`/playbooks/${safe.id}`)).body.error.code).toBe('not_found');
  });

  it('takes a scratch copy step on Review PR, on attach and on save', async () => {
    const { http } = await start();
    const mock = await create(http, 'Mocks', { steps: [step('Trace'), step('Make mock data', true)] });
    const attach = await http.put('/playbook-triggers/review_pr', { playbook_id: mock.id });
    expect(attach.status).toBe(200);
    expect(attach.body.data.find((p: { id: string }) => p.id === mock.id).triggers).toEqual(['review_pr']);
    const prod = await create(http, 'PROD readiness', { steps: [step('Check')] });
    await http.put('/playbook-triggers/review_pr', { playbook_id: prod.id });
    const save = await http.patch(`/playbooks/${prod.id}`, { steps: [step('Check'), step('Run the tests', true)] });
    expect(save.status).toBe(200);
    expect(save.body.data).toMatchObject({
      triggers: ['review_pr'],
      steps: [
        { title: 'Check', writes: false },
        { title: 'Run the tests', writes: true },
      ],
    });

    // Check reply and Address comments take one too (Behavior 5).
    for (const trigger of ['check_reply', 'address_comments']) {
      const held = await http.put(`/playbook-triggers/${trigger}`, { playbook_id: mock.id });
      expect(held.status).toBe(200);
    }
  });
});

describe('Playbooks in chats', () => {
  const append = (daemon: AgentDaemon) =>
    (daemon.sdk.calls.at(-1)?.options.systemPrompt as { append: string } | undefined)?.append ?? '';

  it("puts Session message's rules into each turn, read at the turn, before the safety lines", async () => {
    const { daemon, http } = await start();
    const session = daemon.createSession();
    await converse(daemon, session, 'hello');
    // The built-in's rules, when no Playbook holds the Trigger.
    expect(append(daemon)).toContain(`The operator's rules for this work:\n${BUILTIN_RULES.session_message}`);
    expect(append(daemon)).toMatch(/No value read from a PROD Connection goes into a file/);
    expect(append(daemon)).toContain(PR_DESCRIPTION_RULE);
    expect((await http.get(`/sessions/${session}`)).body.data.playbook).toBeNull();

    const safe = await create(http, 'Safe DB fix', { rules: 'Never touch the orders table.' });
    await http.put('/playbook-triggers/session_message', { playbook_id: safe.id });
    await converse(daemon, session, 'again');
    const text = append(daemon);
    expect(text).not.toContain(BUILTIN_RULES.session_message);
    expect(text.indexOf('Never touch the orders table.')).toBeGreaterThan(-1);
    expect(text.indexOf('Never touch the orders table.')).toBeLessThan(text.indexOf('Console safety rules'));
    expect(text.indexOf(PR_DESCRIPTION_RULE)).toBeLessThan(text.indexOf('Never touch the orders table.'));
    expect((await http.get(`/sessions/${session}`)).body.data.playbook).toEqual({ id: safe.id, name: 'Safe DB fix' });

    await http.patch(`/playbooks/${safe.id}`, { rules: 'Ask before any migration.' });
    await converse(daemon, session, 'third');
    expect(append(daemon)).toContain('Ask before any migration.');
    expect(append(daemon)).not.toContain('Never touch the orders table.');
  });
});
