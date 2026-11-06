import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { WsEvent } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../src/accounts/accounts.service';
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
  const added = await api(daemon).post('/agent-accounts');
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

describe('a fresh install', () => {
  it('has no Claude account and no active account', async () => {
    const daemon = await start({ signedIn: false });
    expect(await accounts(daemon)).toEqual({
      data: [],
      meta: { next_cursor: null, active_account_id: null, smart_pick: null },
    });
  });

  it('refuses a message until an account is signed in', async () => {
    const daemon = await start({ signedIn: false });
    const sent = await api(daemon).post(`/sessions/${daemon.createSession()}/messages`, { text: 'hello' });
    expect(sent.status).toBe(409);
    expect(sent.body.error.code).toBe('invalid_state');
  });

  it('makes the first account to sign in the active one, without a switch event', async () => {
    const daemon = await start({ signedIn: false });
    const { events, close } = await listen(daemon);
    const { id } = await addSignedIn(daemon, 'personal');
    expect((await accounts(daemon)).meta.active_account_id).toBe(id);
    expect(switched(events)).toEqual([]);
    close();
  });
});

describe('the first account', () => {
  it('is active, signed in and checked', async () => {
    const daemon = await start();
    const list = await accounts(daemon);
    expect(list.data).toEqual([
      expect.objectContaining({
        label: 'operator@example.com',
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

describe('signing in an account', () => {
  const login = (mode: string) => {
    process.env.FAKE_LOGIN = mode;
    return () => {
      delete process.env.FAKE_LOGIN;
    };
  };

  it('runs the CLI sign-in, then checks the account', async () => {
    const restore = login('personal@example.com');
    try {
      const daemon = await start();
      const added = await api(daemon).post('/agent-accounts');
      const id = added.body.data.account.id;
      const started = await api(daemon).post(`/agent-accounts/${id}/logins`);
      expect(started.status).toBe(200);
      const signedIn = await until(
        async () => (await accounts(daemon)).data.find((account) => account.id === id),
        (account) => account?.signed_in === true && account.signing_in === false,
        'the sign-in',
      );
      expect(signedIn).toMatchObject({ email: 'personal@example.com', plan: 'pro' });
    } finally {
      restore();
    }
  });

  it('reads signing_in while the browser sign-in waits, and cancel stops it and deletes the new account', async () => {
    const restore = login('hang');
    try {
      const daemon = await start();
      const { events, close } = await listen(daemon);
      const added = await api(daemon).post('/agent-accounts');
      const id = added.body.data.account.id;
      const started = await api(daemon).post(`/agent-accounts/${id}/logins`);
      expect(started.body.data).toMatchObject({ signing_in: true, signed_in: false });

      const cancelled = await api(daemon).delete(`/agent-accounts/${id}/logins`);
      expect(cancelled.status).toBe(204);
      expect((await accounts(daemon)).data.map((row) => row.id)).not.toContain(id);
      expect(existsSync(path.join(daemon.dataDir, 'accounts', id))).toBe(false);
      await until(() => events.some((event) => event.event === 'account.removed'), Boolean, 'account.removed');
      close();
    } finally {
      restore();
    }
  });

  it('starts the sign-in again on a re-login while one waits, and the trash icon deletes it', async () => {
    const restore = login('hang');
    try {
      const daemon = await start();
      const added = await api(daemon).post('/agent-accounts');
      const id = added.body.data.account.id;
      await api(daemon).post(`/agent-accounts/${id}/logins`);
      const again = await api(daemon).post(`/agent-accounts/${id}/logins`);
      expect(again.body.data).toMatchObject({ signing_in: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await accounts(daemon)).data.find((row) => row.id === id)).toMatchObject({ signing_in: true });

      expect((await api(daemon).delete(`/agent-accounts/${id}`)).status).toBe(204);
      expect((await accounts(daemon)).data.map((row) => row.id)).not.toContain(id);
    } finally {
      restore();
    }
  });

  it('deletes the new account when the sign-in fails, as when the operator declines it', async () => {
    const restore = login('fail');
    try {
      const daemon = await start();
      const added = await api(daemon).post('/agent-accounts');
      const id = added.body.data.account.id;
      await api(daemon).post(`/agent-accounts/${id}/logins`);
      await until(
        async () => (await accounts(daemon)).data.some((row) => row.id === id),
        (present) => !present,
        'the failed sign-in',
      );
    } finally {
      restore();
    }
  });

  it('signs in by link: no browser tab, the link on the account, the pasted code signs it in', async () => {
    const restore = login('code:friend@example.com');
    try {
      const daemon = await start();
      const added = await api(daemon).post('/agent-accounts');
      const id = added.body.data.account.id;
      const started = await api(daemon).post(`/agent-accounts/${id}/logins`).send({ via: 'link' });
      expect(started.status).toBe(200);
      expect(started.body.data).toMatchObject({ signing_in: true, sign_in_link: { expires_at: expect.any(String) } });
      const waiting = await until(
        async () => (await accounts(daemon)).data.find((row) => row.id === id),
        (row) => (row?.sign_in_link as { url: string | null } | null)?.url != null,
        'the sign-in link',
      );
      expect(waiting?.sign_in_link).toMatchObject({
        url: 'https://claude.example.com/oauth/authorize?code=true&state=fake-state',
      });
      const link = waiting?.sign_in_link as { expires_at: string };
      const minutes = (Date.parse(link.expires_at) - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(14);
      // `true` stands in for the browser, so no tab opens on this Mac.
      const browser = readFileSync(path.join(daemon.dataDir, 'accounts', id, 'fake-login-browser.txt'), 'utf8');
      expect(browser).toBe('true');

      const signedIn = await api(daemon)
        .post(`/agent-accounts/${id}/logins/code`)
        .send({ code: ' https://platform.example.com/oauth/code/callback?code=good&state=fake-state ' });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data).toMatchObject({
        email: 'friend@example.com',
        signed_in: true,
        signing_in: false,
        sign_in_link: null,
      });
    } finally {
      restore();
    }
  });

  it('gives a new link when the CLI turns the code down, and keeps the new account', async () => {
    const restore = login('code:friend@example.com');
    try {
      const daemon = await start();
      const added = await api(daemon).post('/agent-accounts');
      const id = added.body.data.account.id;
      await api(daemon).post(`/agent-accounts/${id}/logins`).send({ via: 'link' });
      const turnedDown = await api(daemon).post(`/agent-accounts/${id}/logins/code`).send({ code: 'typo#fake-state' });
      expect(turnedDown.status).toBe(422);
      expect(turnedDown.body.error.message).toBe(
        "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. The old link no longer works: send the new one.",
      );
      expect((await accounts(daemon)).data.find((row) => row.id === id)).toMatchObject({
        signing_in: true,
        sign_in_link: { expires_at: expect.any(String) },
      });

      const signedIn = await api(daemon).post(`/agent-accounts/${id}/logins/code`).send({ code: 'good#fake-state' });
      expect(signedIn.body.data).toMatchObject({ email: 'friend@example.com', signed_in: true });
    } finally {
      restore();
    }
  });

  it('refuses a code when no sign-in by link waits, and a browser sign-in has no link', async () => {
    const restore = login('hang');
    try {
      const daemon = await start();
      const added = await api(daemon).post('/agent-accounts');
      const id = added.body.data.account.id;
      const code = () => api(daemon).post(`/agent-accounts/${id}/logins/code`).send({ code: 'good#fake-state' });
      expect((await code()).body.error.code).toBe('invalid_state');
      const started = await api(daemon).post(`/agent-accounts/${id}/logins`);
      expect(started.body.data).toMatchObject({ signing_in: true, sign_in_link: null });
      expect((await code()).status).toBe(409);
      expect((await api(daemon).post(`/agent-accounts/${id}/logins/code`).send({ code: ' ' })).status).toBe(400);
    } finally {
      restore();
    }
  });

  it('keeps an account that signed in before when its re-login fails or is cancelled', async () => {
    const restore = login('fail');
    try {
      const daemon = await start();
      const { id } = await addSignedIn(daemon, 'personal');
      await api(daemon).post(`/agent-accounts/${id}/logout`);
      await api(daemon).post(`/agent-accounts/${id}/logins`);
      const account = await until(
        async () => (await accounts(daemon)).data.find((row) => row.id === id),
        (row) => row?.signing_in === false,
        'the failed re-login',
      );
      expect(account).toMatchObject({ label: 'personal@example.com', signed_in: false });
    } finally {
      restore();
    }
  });
});

describe('signing out an account', () => {
  it('signs an added account out of its config dir and keeps the row', async () => {
    const daemon = await start();
    const { id, configDir } = await addSignedIn(daemon, 'personal');
    const out = await api(daemon).post(`/agent-accounts/${id}/logout`);
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ signed_in: false, email: null });
    expect(existsSync(path.join(configDir, 'fake-auth.json'))).toBe(false);
  });

  it('moves the active account to another signed-in one', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    const { id } = await addSignedIn(daemon, 'personal');
    await api(daemon).post(`/agent-accounts/${id}/activate`);
    await api(daemon).post(`/agent-accounts/${id}/logout`);
    expect((await accounts(daemon)).meta.active_account_id).toBe(primary?.id);
  });

  it('leaves no account active when the only signed-in one signs out', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${primary?.id}/logout`);
    const after = await accounts(daemon);
    expect(after.meta.active_account_id).toBeNull();
    expect(after.data[0]).toMatchObject({ signed_in: false, is_active: false });
  });

  it('takes the next account that signs in as active once none is', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${primary?.id}/logout`);
    const { id } = await addSignedIn(daemon, 'personal');
    expect((await accounts(daemon)).meta.active_account_id).toBe(id);
  });
});

describe('adding the same Claude account twice', () => {
  it('signs the second one out and deletes it, and leaves the first untouched', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    const added = await api(daemon).post('/agent-accounts');
    const id = added.body.data.account.id;
    const configDir = path.join(daemon.dataDir, 'accounts', id);
    await signIn(configDir, 'Operator@Example.com');

    const checked = await api(daemon).post(`/agent-accounts/${id}/checks`);
    expect([checked.status, checked.body.error?.code]).toEqual([409, 'invalid_state']);
    const after = await accounts(daemon);
    expect(after.data.map((account) => account.id)).toEqual([primary?.id]);
    expect(after.data[0]).toMatchObject({ is_active: true, signed_in: true });
    expect(existsSync(configDir)).toBe(false);
  });

  it('signs an existing account out when its re-login lands on another account’s email', async () => {
    const daemon = await start();
    const second = await addSignedIn(daemon, 'second');
    await signIn(second.configDir, 'operator@example.com');
    const checked = await api(daemon).post(`/agent-accounts/${second.id}/checks`);
    expect(checked.status).toBe(409);
    expect((await accounts(daemon)).data.find((account) => account.id === second.id)).toMatchObject({
      signed_in: false,
      label: 'second@example.com',
    });
  });

  it('lets an account check again as itself', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    expect((await api(daemon).post(`/agent-accounts/${primary?.id}/checks`)).status).toBe(200);
  });
});

describe('adding and checking an account', () => {
  it('creates a config dir under the data directory, returns the sign-in command for it and labels the account with its email once signed in', async () => {
    const daemon = await start();
    const added = await api(daemon).post('/agent-accounts');
    expect(added.status).toBe(201);
    const configDir = path.join(daemon.dataDir, 'accounts', added.body.data.account.id);
    expect(added.body.data).toEqual({
      account: expect.objectContaining({ label: 'New account', position: 2, signed_in: false, is_active: false }),
      sign_in_command: `CLAUDE_CONFIG_DIR='${configDir}' claude auth login`,
    });
    expect(existsSync(configDir)).toBe(true);

    await signIn(configDir, 'personal@example.com', 'pro');
    const checked = await api(daemon).post(`/agent-accounts/${added.body.data.account.id}/checks`);
    expect(checked.body.data).toMatchObject({
      label: 'personal@example.com',
      signed_in: true,
      email: 'personal@example.com',
      plan: 'pro',
    });
  });

  it('reports a check of a signed-out account as not signed in', async () => {
    const daemon = await start();
    const added = await api(daemon).post('/agent-accounts');
    const checked = await api(daemon).post(`/agent-accounts/${added.body.data.account.id}/checks`);
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({ signed_in: false, email: null });
  });
});

describe('usage read from Anthropic', () => {
  const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

  it('shows an idle account its 5-hour and weekly usage, then updates it on the next poll', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    const configDir = path.join(daemon.dataDir, 'accounts', String(primary?.id));
    daemon.usage.set(configDir, {
      fiveHour: { pct: 12, resetsAt: hoursFromNow(2) },
      weekly: { pct: 35, resetsAt: hoursFromNow(72) },
    });
    await daemon.app.get(AccountsService).pollUsage();
    expect((await accounts(daemon)).data[0]).toMatchObject({
      five_hour_pct: 12,
      weekly_pct: 35,
      usage_seen_at: expect.any(String),
    });

    daemon.usage.set(configDir, {
      fiveHour: { pct: 40, resetsAt: hoursFromNow(2) },
      weekly: { pct: 36, resetsAt: hoursFromNow(72) },
    });
    await daemon.app.get(AccountsService).pollUsage();
    expect((await accounts(daemon)).data[0]).toMatchObject({ five_hour_pct: 40, weekly_pct: 36 });
  });

  it('keeps the last usage when Anthropic does not answer, and skips accounts that are signed out', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    const configDir = path.join(daemon.dataDir, 'accounts', String(primary?.id));
    daemon.usage.set(configDir, { fiveHour: { pct: 12, resetsAt: hoursFromNow(2) }, weekly: null });
    await daemon.app.get(AccountsService).pollUsage();
    daemon.usage.set(configDir, new Error('usage request failed (429)'));
    await daemon.app.get(AccountsService).pollUsage();
    expect((await accounts(daemon)).data[0]).toMatchObject({ five_hour_pct: 12, weekly_pct: null });

    const out = await addSignedIn(daemon, 'other');
    await api(daemon).post(`/agent-accounts/${out.id}/logout`);
    daemon.usage.set(out.configDir, { fiveHour: { pct: 90, resetsAt: hoursFromNow(1) }, weekly: null });
    await daemon.app.get(AccountsService).pollUsage();
    expect((await accounts(daemon)).data.find((row) => row.id === out.id)).toMatchObject({ five_hour_pct: null });
  });

  it('auto-switches when the polled usage of the active account reaches the threshold', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    const other = await addSignedIn(daemon, 'other');
    daemon.usage.set(path.join(daemon.dataDir, 'accounts', String(primary?.id)), {
      fiveHour: { pct: 97, resetsAt: hoursFromNow(2) },
      weekly: { pct: 10, resetsAt: hoursFromNow(72) },
    });
    daemon.usage.set(other.configDir, {
      fiveHour: { pct: 5, resetsAt: hoursFromNow(2) },
      weekly: { pct: 10, resetsAt: hoursFromNow(72) },
    });
    await daemon.app.get(AccountsService).pollUsage();
    expect((await accounts(daemon)).meta.active_account_id).toBe(other.id);
  });

  it('drops a reading taken as another added account: that folder is signed out and the active account moves', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    const other = await addSignedIn(daemon, 'other');
    const primaryDir = path.join(daemon.dataDir, 'accounts', String(primary?.id));
    await reportUsage(daemon, 100, 61);
    // A sign-in run under the primary's folder, such as `/login`, replaced its login with the other account's.
    await signIn(primaryDir, 'other@example.com', 'pro');
    daemon.usage.set(primaryDir, {
      email: 'other@example.com',
      fiveHour: { pct: 100, resetsAt: hoursFromNow(1) },
      weekly: { pct: 61, resetsAt: hoursFromNow(48) },
    });
    await daemon.app.get(AccountsService).pollUsage();

    const after = await accounts(daemon);
    expect(after.data.find((row) => row.id === primary?.id)).toMatchObject({ signed_in: false, five_hour_pct: null });
    expect(after.meta.active_account_id).toBe(other.id);
    expect(existsSync(path.join(primaryDir, 'fake-auth.json'))).toBe(false);
  });
});

describe('usage', () => {
  it('updates from each rate-limit event of a run, and reads 0% once a window is past its reset', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    await reportUsage(daemon, 42, 61);

    const [primary] = (await accounts(daemon)).data;
    expect(primary).toMatchObject({ five_hour_pct: 42, weekly_pct: 61, usage_seen_at: expect.any(String) });
    expect(Date.parse(String(primary?.weekly_resets_at)) - Date.now()).toBeGreaterThan(47 * 3_600_000);
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
    const [primary] = (await accounts(daemon)).data;

    const used = await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    expect(used.body.data).toMatchObject({ id: personal.id, is_active: true });
    expect(switched(events)).toEqual([{ from: primary?.id, to: personal.id, reason: 'manual', five_hour_pct: null }]);

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
    const added = await api(daemon).post('/agent-accounts');
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
    const [primary] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    await reportUsage(daemon, 10, 20);
    await api(daemon).post(`/agent-accounts/${primary?.id}/activate`);

    await reportUsage(daemon, 96, 50);
    expect((await accounts(daemon)).meta.active_account_id).toBe(personal.id);
    expect(switched(events).at(-1)).toMatchObject({ from: primary?.id, to: personal.id, reason: 'smart' });
    close();
  });

  it('with Smart usage off, moves to the signed-in account with the lowest known 5-hour usage', async () => {
    const daemon = await start();
    const busy = await addSignedIn(daemon, 'busy');
    const quiet = await addSignedIn(daemon, 'quiet');
    const [primary] = (await accounts(daemon)).data;
    for (const [account, fiveHour] of [
      [busy, 60],
      [quiet, 20],
    ] as const) {
      await api(daemon).post(`/agent-accounts/${account.id}/activate`);
      await reportUsage(daemon, fiveHour, 99);
    }
    await api(daemon).post(`/agent-accounts/${primary?.id}/activate`);
    const setting = { active_account_id: primary?.id, auto_switch: true, threshold: 90, smart_usage: false };
    await api(daemon).patch('/settings', { agent_accounts: setting });

    await reportUsage(daemon, 91, 10);
    expect((await accounts(daemon)).meta.active_account_id).toBe(quiet.id);
  });

  it('keeps the active account when no other has headroom, or when Auto-switch is off', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    await addSignedIn(daemon, 'unused');
    await reportUsage(daemon, 97, 50);
    expect((await accounts(daemon)).meta.active_account_id).toBe(primary?.id);

    const other = await addSignedIn(daemon, 'other');
    await api(daemon).post(`/agent-accounts/${other.id}/activate`);
    await reportUsage(daemon, 5, 5);
    await api(daemon).post(`/agent-accounts/${primary?.id}/activate`);
    const setting = { active_account_id: primary?.id, auto_switch: false, threshold: 95, smart_usage: false };
    await api(daemon).patch('/settings', { agent_accounts: setting });
    await reportUsage(daemon, 99, 50);
    expect((await accounts(daemon)).meta.active_account_id).toBe(primary?.id);
  });
});

describe('Smart usage', () => {
  it('marks the top pick in the list when it is not the active account, with a note per account', async () => {
    const daemon = await start();
    const personal = await addSignedIn(daemon, 'personal');
    await reportUsage(daemon, 50, 90, 72);
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    await reportUsage(daemon, 10, 35, 48);
    const [primary] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${primary?.id}/activate`);

    const list = await accounts(daemon);
    expect(list.meta.smart_pick).toEqual({
      account_id: personal.id,
      reason: '65% of its weekly quota is left and it resets in 2 days, use it first',
    });
    expect(list.data.map((account) => account.smart_note)).toEqual([
      '10% weekly left ÷ 3d = 3.3% / day',
      '65% weekly left ÷ 2d = 32.5% / day',
    ]);

    const smartOff = { active_account_id: primary?.id, auto_switch: true, threshold: 95, smart_usage: false };
    await api(daemon).patch('/settings', { agent_accounts: smartOff });
    const off = await accounts(daemon);
    expect(off.meta.smart_pick).toBeNull();
    expect(off.data[0]).not.toHaveProperty('smart_note');
  });

  it('moves to the Smart pick on its own, and stops when Smart usage is turned off', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const [primary] = (await accounts(daemon)).data;
    const personal = await addSignedIn(daemon, 'personal');
    const off = { active_account_id: primary?.id, auto_switch: true, threshold: 95, smart_usage: false };
    await api(daemon).patch('/settings', { agent_accounts: off });
    await reportUsage(daemon, 50, 90);
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    await reportUsage(daemon, 10, 10);
    await api(daemon).post(`/agent-accounts/${primary?.id}/activate`);
    expect((await accounts(daemon)).meta.active_account_id).toBe(primary?.id);

    await api(daemon).patch('/settings', { agent_accounts: { ...off, smart_usage: true } });
    const list = await accounts(daemon);
    expect(list.meta.active_account_id).toBe(personal.id);
    expect(list.meta.smart_pick).toMatchObject({ account_id: personal.id });
    expect(switched(events).at(-1)).toMatchObject({ from: primary?.id, to: personal.id, reason: 'smart' });
    close();
  });

  it('reports Use of the Smart pick as a smart switch', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const personal = await addSignedIn(daemon, 'personal');
    await reportUsage(daemon, 50, 90);
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    await reportUsage(daemon, 10, 10);
    const [primary] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${primary?.id}/activate`);

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
    const [primary] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${primary?.id}/activate`);

    const id = daemon.createSession();
    await converse(daemon, id, 'first');
    daemon.sdk.script({ rejected: true });
    const session = await converse(daemon, id, 'second');

    expect(session).toMatchObject({ state: 'idle', account_id: personal.id });
    expect(switched(events).at(-1)).toMatchObject({ from: primary?.id, to: personal.id, reason: 'rate_limited' });
    const [rejected, resumed] = daemon.sdk.calls.slice(-2);
    expect(resumed).toMatchObject({ prompt: 'second', configDir: personal.configDir, sessionId: rejected?.sessionId });
    close();
  });

  it('keeps the Network allowlist it started with when it resumes on another account (Network Behavior 11)', async () => {
    const daemon = await start();
    const personal = await addSignedIn(daemon, 'personal');
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    await reportUsage(daemon, 10, 10);
    const [primary] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${primary?.id}/activate`);

    const id = daemon.createSession();
    await converse(daemon, id, 'first');
    const before = daemon.sdk.calls.length;
    let release = () => {};
    daemon.sdk.script({ wait: new Promise((resolve) => (release = () => resolve(null))) }, { rejected: true });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'second' });
    await until(
      () => daemon.sdk.calls.length,
      (calls) => calls === before + 1,
    );
    // The operator edits the list while the run waits; the account switch does not start a new list.
    await api(daemon).post('/network-allowlist/domains', { domain: 'npm.example.com' });
    release();
    await until(
      () => daemon.sdk.calls.length,
      (calls) => calls === before + 2,
    );
    await until(
      async () => (await api(daemon).get(`/sessions/${id}`)).body.data.state,
      (state) => state === 'idle' || state === 'failed',
      'the run to end',
    );
    const [started, resumed] = daemon.sdk.calls
      .slice(before)
      .map((call) => call.options.sandbox?.network?.allowedDomains);
    expect(resumed).toEqual(started);
    expect(resumed).not.toContain('npm.example.com');
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

describe('a run whose account cannot sign in', () => {
  it('marks the account signed out and resumes once on the next signed-in one', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const personal = await addSignedIn(daemon, 'personal');
    const [primary] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${primary?.id}/activate`);

    const id = daemon.createSession();
    daemon.sdk.script({ signInExpired: true });
    const session = await converse(daemon, id, 'go');

    expect(session).toMatchObject({ state: 'idle', account_id: personal.id });
    expect(switched(events).at(-1)).toMatchObject({ from: primary?.id, to: personal.id, reason: 'sign_in_failed' });
    const list = await accounts(daemon);
    expect(list.data.find((account: { id: string }) => account.id === primary?.id)).toMatchObject({ signed_in: false });
    expect(daemon.sdk.calls.at(-1)).toMatchObject({ prompt: 'go', configDir: personal.configDir });
    close();
  });

  it('fails with unauthorized when no other account is signed in', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const id = daemon.createSession();
    daemon.sdk.script({ signInExpired: true });
    expect((await converse(daemon, id, 'go')).state).toBe('failed');
    await until(() => events.some((event) => event.event === 'session.finished'), Boolean);
    expect(events.find((event) => event.event === 'session.finished')?.data).toMatchObject({
      status: 'failed',
      error_code: 'unauthorized',
    });
    expect(daemon.sdk.calls).toHaveLength(1);
    close();
  });
});

describe('removing an account', () => {
  it('moves its Sessions to the active account, signs it out and deletes the row', async () => {
    const daemon = await start();
    const personal = await addSignedIn(daemon, 'personal');
    const [primary] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    const id = daemon.createSession();
    await converse(daemon, id, 'Remember the number 7');
    await api(daemon).post(`/agent-accounts/${primary?.id}/activate`);
    const { events, close } = await listen(daemon);

    expect((await api(daemon).delete(`/agent-accounts/${personal.id}`)).status).toBe(204);
    await until(() => events.some((event) => event.event === 'session.updated'), Boolean, 'session.updated');
    expect(events.find((event) => event.event === 'session.updated')?.data).toMatchObject({
      session_id: id,
      account_id: primary?.id,
    });
    close();
    expect((await accounts(daemon)).data.map((account) => account.id)).toEqual([primary?.id]);
    expect(existsSync(path.join(personal.configDir, 'fake-auth.json'))).toBe(false);
    expect((await api(daemon).get(`/sessions/${id}`)).body.data.account_id).toBe(primary?.id);
    const copied = await readdir(path.join(daemon.home, 'projects'), { recursive: true });
    expect(copied).toContainEqual(expect.stringContaining(`${daemon.sdk.calls[0]?.sessionId}.jsonl`));
    expect((await api(daemon).get(`/sessions/${id}/messages`)).body.data).toHaveLength(2);
  });

  it('hands the active account to another signed-in one when it is removed', async () => {
    const daemon = await start();
    const personal = await addSignedIn(daemon, 'personal');
    const [primary] = (await accounts(daemon)).data;
    expect((await api(daemon).delete(`/agent-accounts/${primary?.id}`)).status).toBe(204);
    const after = await accounts(daemon);
    expect(after.meta.active_account_id).toBe(personal.id);
    expect(after.data.map((account) => account.id)).toEqual([personal.id]);
  });

  it('removes the only account and leaves none active', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    expect((await api(daemon).delete(`/agent-accounts/${primary?.id}`)).status).toBe(204);
    const after = await accounts(daemon);
    expect(after.data).toEqual([]);
    expect(after.meta.active_account_id).toBeNull();
  });

  it('removes an active account that is signed out', async () => {
    const daemon = await start();
    const added = await api(daemon).post('/agent-accounts');
    await api(daemon).post(`/agent-accounts/${added.body.data.account.id}/checks`);
    expect((await api(daemon).delete(`/agent-accounts/${added.body.data.account.id}`)).status).toBe(204);
  });

  it('refuses an account with a run going', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    const hold = gate();
    daemon.sdk.script({ wait: hold.promise });
    const sessionId = daemon.createSession();
    await api(daemon).post(`/sessions/${sessionId}/messages`, { text: 'long job' });
    const response = await api(daemon).delete(`/agent-accounts/${primary?.id}`);
    expect([response.status, response.body.error?.code]).toEqual([409, 'invalid_state']);
    hold.open();
    // The run writes its end to the store; the daemon must not stop first.
    await until(
      async () => (await api(daemon).get(`/sessions/${sessionId}`)).body.data.state,
      (state) => state === 'idle',
      'the run to end',
    );
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

describe('disabling an account', () => {
  const setEnabled = (daemon: AgentDaemon, id: string, enabled: boolean) =>
    api(daemon).patch(`/agent-accounts/${id}`, { enabled });

  it('enables every account at first, and keeps the switch', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    expect(primary).toMatchObject({ enabled: true });

    const off = await setEnabled(daemon, primary?.id ?? '', false);
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({ enabled: false, signed_in: true });
    expect((await accounts(daemon)).data[0]).toMatchObject({ enabled: false });
    expect((await setEnabled(daemon, primary?.id ?? '', true)).body.data).toMatchObject({ enabled: true });
  });

  it('refuses a body that is not an enabled flag, and an account that does not exist', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    expect((await api(daemon).patch(`/agent-accounts/${primary?.id}`, { enabled: 'no' })).status).toBe(400);
    expect((await setEnabled(daemon, 'missing', false)).status).toBe(404);
  });

  it('refuses Use of a disabled account', async () => {
    const daemon = await start();
    const personal = await addSignedIn(daemon, 'personal');
    await setEnabled(daemon, personal.id, false);
    const used = await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    expect(used.status).toBe(409);
    expect(used.body.error.code).toBe('invalid_state');
  });

  it('hands the active role over, with reason disabled, when the active account is disabled', async () => {
    const daemon = await start();
    const { events, close } = await listen(daemon);
    const [primary] = (await accounts(daemon)).data;
    const personal = await addSignedIn(daemon, 'personal');

    await setEnabled(daemon, primary?.id ?? '', false);
    expect((await accounts(daemon)).meta.active_account_id).toBe(personal.id);
    expect(switched(events).at(-1)).toMatchObject({ from: primary?.id, to: personal.id, reason: 'disabled' });
    close();
  });

  it('runs on the account that stays enabled, never on the disabled one', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    const personal = await addSignedIn(daemon, 'personal');
    await setEnabled(daemon, primary?.id ?? '', false);
    await converse(daemon, daemon.createSession(), 'go');
    expect(daemon.sdk.calls.map((call) => call.configDir)).toEqual([personal.configDir]);
  });

  it('skips a disabled account in Smart pick and says so in its note', async () => {
    const daemon = await start();
    const personal = await addSignedIn(daemon, 'personal');
    await reportUsage(daemon, 50, 90, 72);
    await api(daemon).post(`/agent-accounts/${personal.id}/activate`);
    await reportUsage(daemon, 10, 35, 48);
    const [primary] = (await accounts(daemon)).data;
    await api(daemon).post(`/agent-accounts/${primary?.id}/activate`);
    expect((await accounts(daemon)).meta.smart_pick).toMatchObject({ account_id: personal.id });

    await setEnabled(daemon, personal.id, false);
    const list = await accounts(daemon);
    expect(list.meta.smart_pick).toMatchObject({ account_id: primary?.id });
    expect(list.data.find((account) => account.id === personal.id)?.smart_note).toBe('disabled, skipped');
    expect(list.meta.active_account_id).toBe(primary?.id);
  });

  it('leaves no account active when the last enabled one is disabled, and refuses runs with a reason', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    await setEnabled(daemon, primary?.id ?? '', false);
    expect((await accounts(daemon)).meta.active_account_id).toBeNull();

    const sent = await api(daemon).post(`/sessions/${daemon.createSession()}/messages`, { text: 'hello' });
    expect(sent.status).toBe(409);
    expect(sent.body.error.code).toBe('invalid_state');
    expect(sent.body.error.message).toContain('every Claude account is disabled');
  });

  it('makes an account active when it is enabled while none is, and not otherwise', async () => {
    const daemon = await start();
    const [primary] = (await accounts(daemon)).data;
    await setEnabled(daemon, primary?.id ?? '', false);
    await setEnabled(daemon, primary?.id ?? '', true);
    expect((await accounts(daemon)).meta.active_account_id).toBe(primary?.id);

    const personal = await addSignedIn(daemon, 'personal');
    await setEnabled(daemon, personal.id, false);
    await setEnabled(daemon, personal.id, true);
    expect((await accounts(daemon)).meta.active_account_id).toBe(primary?.id);
  });

  it('does not take a disabled account as active when it signs in', async () => {
    const daemon = await start({ signedIn: false });
    const added = await api(daemon).post('/agent-accounts');
    const id = added.body.data.account.id;
    await setEnabled(daemon, id, false);
    await signIn(path.join(daemon.dataDir, 'accounts', id), 'later@example.com', 'pro');
    await api(daemon).post(`/agent-accounts/${id}/checks`);
    expect((await accounts(daemon)).meta.active_account_id).toBeNull();
  });
});
