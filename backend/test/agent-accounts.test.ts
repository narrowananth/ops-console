import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { WsEvent } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentDaemon, api, converse, gate, listen, signIn, startAgentDaemon, until } from './agent-fixtures';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

async function start(options: Parameters<typeof startAgentDaemon>[0] = {}) {
  const daemon = await startAgentDaemon(options);
  running.push(daemon);
  return daemon;
}

type Account = { id: string; is_active: boolean; [key: string]: unknown };

async function accounts(daemon: AgentDaemon): Promise<{ data: Account[]; meta: Record<string, unknown> }> {
  return (await api(daemon).get('/agent-accounts')).body;
}

/** Adds an account and signs it in, as the operator would with the sign-in command. */
async function addSignedIn(daemon: AgentDaemon, label: string): Promise<{ id: string; configDir: string }> {
  const added = await api(daemon).post('/agent-accounts', { label });
  const configDir = path.join(daemon.dataDir, 'accounts', added.body.data.account.id);
  await signIn(configDir, `${label}@example.com`, 'pro');
  await api(daemon).post(`/agent-accounts/${added.body.data.account.id}/checks`);
  return { id: added.body.data.account.id, configDir };
}

/** One run under the active account that reports this usage. */
async function reportUsage(daemon: AgentDaemon, fiveHour: number, weekly: number, weeklyResetsInHours = 48) {
  daemon.sdk.script({
    rateLimit: {
      status: 'allowed',
      five_hour: { pct: fiveHour, resetsInHours: 2 },
      seven_day: { pct: weekly, resetsInHours: weeklyResetsInHours },
    },
  });
  await converse(daemon, daemon.createSession(), 'usage');
}

const switched = (events: WsEvent[]) =>
  events.flatMap((event) => (event.event === 'account.switched' ? [event.data] : []));

describe('the seeded account', () => {
  it("is the operator's own Claude Code login, active, and checked on first start", async () => {
    const daemon = await start();
    const list = await until(
      () => accounts(daemon),
      (body) => body.data[0]?.last_checked_at !== null,
      'the first check',
    );
    expect(list.data).toEqual([
      expect.objectContaining({
        label: 'default',
        position: 1,
        is_active: true,
        signed_in: true,
        email: 'operator@example.com',
        plan: 'max',
        five_hour_pct: null,
        weekly_pct: null,
        usage_seen_at: null,
      }),
    ]);
    expect(list.data[0]).not.toHaveProperty('config_dir');
    expect(list.meta).toEqual({ next_cursor: null, active_account_id: list.data[0]?.id, smart_pick: null });
  });
});

describe('adding and checking an account', () => {
  it('creates a config dir under the data directory and returns the sign-in command for it', async () => {
    const daemon = await start();
    const added = await api(daemon).post('/agent-accounts', { label: 'personal' });
    expect(added.status).toBe(201);
    const configDir = path.join(daemon.dataDir, 'accounts', added.body.data.account.id);
    expect(added.body.data).toEqual({
      account: expect.objectContaining({ label: 'personal', position: 2, signed_in: false, is_active: false }),
      sign_in_command: `CLAUDE_CONFIG_DIR='${configDir}' claude auth login`,
    });
    expect(existsSync(configDir)).toBe(true);

    await signIn(configDir, 'personal@example.com', 'pro');
    const checked = await api(daemon).post(`/agent-accounts/${added.body.data.account.id}/checks`);
    expect(checked.body.data).toMatchObject({ signed_in: true, email: 'personal@example.com', plan: 'pro' });
  });

  it('reports a check of a signed-out account as not signed in', async () => {
    const daemon = await start({ signedIn: false });
    const [seeded] = (await accounts(daemon)).data;
    const checked = await api(daemon).post(`/agent-accounts/${seeded?.id}/checks`);
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({ signed_in: false, email: null });
  });
});

describe('usage', () => {
  it('updates from each rate-limit event of a run, and reads 0% once a window is past its reset', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    await reportUsage(daemon, 42, 61);

    const [seeded] = (await accounts(daemon)).data;
    expect(seeded).toMatchObject({ five_hour_pct: 42, weekly_pct: 61, usage_seen_at: expect.any(String) });
    expect(Date.parse(String(seeded?.weekly_resets_at)) - Date.now()).toBeGreaterThan(47 * 3_600_000);
    expect(events.find((event) => event.event === 'account.updated')?.data).toMatchObject({
      five_hour_pct: 42,
      weekly_pct: 61,
    });

    await reportUsage(daemon, 30, 70, -1);
    expect((await accounts(daemon)).data[0]).toMatchObject({ five_hour_pct: 30, weekly_pct: 0 });
    close();
  });

  it('keeps the last values when an event arrives in a shape it does not know', async () => {
    const daemon = await start();
    await reportUsage(daemon, 42, 61);
    daemon.sdk.script({ rateLimitInfo: { status: 'throttled', unifiedWindows: { five_hour: { used: '99%' } } } });
    expect((await converse(daemon, daemon.createSession(), 'go')).state).toBe('idle');
    expect((await accounts(daemon)).data[0]).toMatchObject({ five_hour_pct: 42, weekly_pct: 61 });
  });
});

describe('switching accounts', () => {
  it('Use makes an account active; the next run carries the conversation over to it', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const personal = await addSignedIn(daemon, 'personal');
    const id = daemon.createSession();
    await converse(daemon, id, 'Remember the number 7');
    const [seeded] = (await accounts(daemon)).data;

    const used = await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    expect(used.body.data).toMatchObject({ id: personal.id, is_active: true });
    expect(switched(events)).toEqual([{ from: seeded?.id, to: personal.id, reason: 'manual', five_hour_pct: null }]);

    await converse(daemon, id, 'What was the number?');
    expect(daemon.sdk.calls[1]).toMatchObject({
      configDir: personal.configDir,
      sessionId: daemon.sdk.calls[0]?.sessionId,
    });
    expect((await api(daemon).get(`/sessions/${id}`)).body.data.account_id).toBe(personal.id);
    const messages = await api(daemon).get(`/sessions/${id}/messages`);
    expect(messages.body.data.map((message: { role: string }) => message.role)).toEqual([
      'user',
      'agent',
      'user',
      'agent',
    ]);
    close();
  });

  it('lets a run in progress finish on its own account', async () => {
    const daemon = await start();
    const personal = await addSignedIn(daemon, 'personal');
    const hold = gate();
    const id = daemon.createSession();
    daemon.sdk.script({ wait: hold.promise });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'long job' });
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    hold.open();
    await converse(daemon, daemon.createSession(), 'next');

    expect(daemon.sdk.calls.map((call) => call.configDir)).toEqual([daemon.home, personal.configDir]);
  });

  it('refuses Use of an account that is not signed in', async () => {
    const daemon = await start();
    const added = await api(daemon).post('/agent-accounts', { label: 'personal' });
    const used = await api(daemon).post(`/agent-accounts/${added.body.data.account.id}/activate`);
    expect(used.status).toBe(409);
    expect(used.body.error.code).toBe('invalid_state');
  });
});

describe('Auto-switch', () => {
  it('moves to the Smart pick when the active account reaches the threshold', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const personal = await addSignedIn(daemon, 'personal');
    const [seeded] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    await reportUsage(daemon, 10, 20);
    await api(daemon).post(`/agent-accounts/${seeded?.id}/activate`);

    await reportUsage(daemon, 96, 50);
    expect((await accounts(daemon)).meta.active_account_id).toBe(personal.id);
    expect(switched(events).at(-1)).toEqual({ from: seeded?.id, to: personal.id, reason: 'auto', five_hour_pct: 96 });
    close();
  });

  it('with Smart usage off, moves to the signed-in account with the lowest known 5-hour usage', async () => {
    const daemon = await start();
    const busy = await addSignedIn(daemon, 'busy');
    const quiet = await addSignedIn(daemon, 'quiet');
    const [seeded] = (await accounts(daemon)).data;
    for (const [account, fiveHour] of [
      [busy, 60],
      [quiet, 20],
    ] as const) {
      await api(daemon).post(`/agent-accounts/${account.id}/activate`);
      await reportUsage(daemon, fiveHour, 99);
    }
    await api(daemon).post(`/agent-accounts/${seeded?.id}/activate`);
    const setting = { active_account_id: seeded?.id, auto_switch: true, threshold: 90, smart_usage: false };
    await api(daemon).patch('/settings', { agent_accounts: setting });

    await reportUsage(daemon, 91, 10);
    expect((await accounts(daemon)).meta.active_account_id).toBe(quiet.id);
  });

  it('keeps the active account when no other has headroom, or when Auto-switch is off', async () => {
    const daemon = await start();
    const [seeded] = (await accounts(daemon)).data;
    await addSignedIn(daemon, 'unused');
    await reportUsage(daemon, 97, 50);
    expect((await accounts(daemon)).meta.active_account_id).toBe(seeded?.id);

    const other = await addSignedIn(daemon, 'other');
    await api(daemon).post(`/agent-accounts/${other.id}/activate`);
    await reportUsage(daemon, 5, 5);
    await api(daemon).post(`/agent-accounts/${seeded?.id}/activate`);
    const setting = { active_account_id: seeded?.id, auto_switch: false, threshold: 95, smart_usage: true };
    await api(daemon).patch('/settings', { agent_accounts: setting });
    await reportUsage(daemon, 99, 50);
    expect((await accounts(daemon)).meta.active_account_id).toBe(seeded?.id);
  });
});

describe('Smart usage', () => {
  it('marks the top pick in the list when it is not the active account, with a note per account', async () => {
    const daemon = await start();
    const personal = await addSignedIn(daemon, 'personal');
    await reportUsage(daemon, 50, 90, 72);
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    await reportUsage(daemon, 10, 35, 48);
    const [seeded] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${seeded?.id}/activate`);

    const list = await accounts(daemon);
    expect(list.meta.smart_pick).toEqual({
      account_id: personal.id,
      reason: '65% of its weekly quota is left and it resets in 2 days, use it first',
    });
    expect(list.data.map((account) => account.smart_note)).toEqual([
      '10% weekly left ÷ 3d = 3.3% / day',
      '65% weekly left ÷ 2d = 32.5% / day',
    ]);

    const smartOff = { active_account_id: seeded?.id, auto_switch: true, threshold: 95, smart_usage: false };
    await api(daemon).patch('/settings', { agent_accounts: smartOff });
    const off = await accounts(daemon);
    expect(off.meta.smart_pick).toBeNull();
    expect(off.data[0]).not.toHaveProperty('smart_note');
  });

  it('reports Use of the Smart pick as a smart switch', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const personal = await addSignedIn(daemon, 'personal');
    await reportUsage(daemon, 50, 90);
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    await reportUsage(daemon, 10, 10);
    const [seeded] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${seeded?.id}/activate`);

    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    expect(switched(events).map((event) => event.reason)).toEqual(['manual', 'manual', 'smart']);
    close();
  });
});

describe('a run rejected for its limit', () => {
  it('resumes once on the account Auto-switch picks', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const personal = await addSignedIn(daemon, 'personal');
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    await reportUsage(daemon, 10, 10);
    const [seeded] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${seeded?.id}/activate`);

    const id = daemon.createSession();
    await converse(daemon, id, 'first');
    daemon.sdk.script({ rejected: true });
    const session = await converse(daemon, id, 'second');

    expect(session).toMatchObject({ state: 'idle', account_id: personal.id });
    expect(switched(events).at(-1)).toMatchObject({ from: seeded?.id, to: personal.id, reason: 'rate_limited' });
    const [rejected, resumed] = daemon.sdk.calls.slice(-2);
    expect(resumed).toMatchObject({ prompt: 'second', configDir: personal.configDir, sessionId: rejected?.sessionId });
    close();
  });

  it('fails with rate_limited when Auto-switch has no account to move to', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const id = daemon.createSession();
    daemon.sdk.script({ rejected: true });
    expect((await converse(daemon, id, 'go')).state).toBe('failed');
    await until(() => events.some((event) => event.event === 'session.finished'), Boolean);
    expect(events.find((event) => event.event === 'session.finished')?.data).toMatchObject({
      status: 'failed',
      error_code: 'rate_limited',
    });
    expect(daemon.sdk.calls).toHaveLength(1);
    close();
  });
});

describe('removing an account', () => {
  it('moves its Sessions to the active account, signs it out and deletes the row', async () => {
    const daemon = await start();
    const personal = await addSignedIn(daemon, 'personal');
    const [seeded] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    const id = daemon.createSession();
    await converse(daemon, id, 'Remember the number 7');
    await api(daemon).post(`/agent-accounts/${seeded?.id}/activate`);
    const { events, close } = await listen(daemon);

    expect((await api(daemon).delete(`/agent-accounts/${personal.id}`)).status).toBe(204);
    await until(() => events.some((event) => event.event === 'session.updated'), Boolean, 'session.updated');
    expect(events.find((event) => event.event === 'session.updated')?.data).toMatchObject({
      session_id: id,
      account_id: seeded?.id,
    });
    close();
    expect((await accounts(daemon)).data.map((account) => account.id)).toEqual([seeded?.id]);
    expect(existsSync(path.join(personal.configDir, 'fake-auth.json'))).toBe(false);
    expect((await api(daemon).get(`/sessions/${id}`)).body.data.account_id).toBe(seeded?.id);
    const copied = await readdir(path.join(daemon.home, 'projects'), { recursive: true });
    expect(copied).toContainEqual(expect.stringContaining(`${daemon.sdk.calls[0]?.sessionId}.jsonl`));
    expect((await api(daemon).get(`/sessions/${id}/messages`)).body.data).toHaveLength(2);
  });

  it('refuses the active account, the seeded account and one with a run going', async () => {
    const daemon = await start();
    const personal = await addSignedIn(daemon, 'personal');
    const [seeded] = (await accounts(daemon)).data;
    const refused = async (accountId: string | undefined) => {
      const response = await api(daemon).delete(`/agent-accounts/${accountId}`);
      return [response.status, response.body.error?.code];
    };

    expect(await refused(seeded?.id)).toEqual([409, 'invalid_state']);
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    expect(await refused(personal.id)).toEqual([409, 'invalid_state']);

    const hold = gate();
    daemon.sdk.script({ wait: hold.promise });
    await api(daemon).post(`/sessions/${daemon.createSession()}/messages`, { text: 'long job' });
    await api(daemon).post(`/agent-accounts/${seeded?.id}/activate`);
    expect(await refused(personal.id)).toEqual([409, 'invalid_state']);
    hold.open();
  });
});

describe('the agent_accounts setting', () => {
  it('refuses a threshold outside 50 to 100', async () => {
    const daemon = await start();
    const { meta } = await accounts(daemon);
    for (const threshold of [40, 101]) {
      const response = await api(daemon).patch('/settings', {
        agent_accounts: { active_account_id: meta.active_account_id, auto_switch: true, threshold, smart_usage: true },
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toEqual({
        code: 'validation_failed',
        message: expect.stringContaining('agent_accounts'),
      });
    }
  });
});
