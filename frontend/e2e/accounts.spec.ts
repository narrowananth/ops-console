import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const LINK = 'https://claude.example.com/cai/oauth/authorize?code=true&state=fake-state';

const account = (change: Record<string, unknown>) => ({
  id: 'acc-1',
  label: 'New account',
  position: 1,
  signed_in: false,
  signing_in: false,
  enabled: true,
  email: null,
  plan: null,
  five_hour_pct: null,
  five_hour_resets_at: null,
  weekly_pct: null,
  weekly_resets_at: null,
  usage_seen_at: null,
  last_checked_at: null,
  created_at: new Date().toISOString(),
  is_active: false,
  sign_in_link: null,
  ...change,
});

/** Answers `/api/agent-accounts` as the daemon would for a sign-in by link, and records what the page sends. */
async function accounts(page: Page) {
  const sent: { path: string; body: unknown }[] = [];
  let list: ReturnType<typeof account>[] = [];
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await page.route('**/api/agent-accounts**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api', '');
    if (request.method() === 'GET') {
      return route.fulfill({
        json: { data: list, meta: { next_cursor: null, active_account_id: null, smart_pick: null } },
      });
    }
    sent.push({ path, body: request.postDataJSON() });
    if (path === '/agent-accounts') {
      list = [account({})];
      return route.fulfill({ status: 201, json: { data: { account: list[0], sign_in_command: 'claude auth login' } } });
    }
    if (path === '/agent-accounts/acc-1/logins') {
      list = [account({ signing_in: true, sign_in_link: { url: LINK, expires_at: expiresAt } })];
      return route.fulfill({ json: { data: list[0] } });
    }
    if (path === '/agent-accounts/acc-1/logins/code') {
      if ((request.postDataJSON() as { code: string }).code !== 'good#fake-state') {
        return route.fulfill({
          status: 422,
          json: {
            error: {
              code: 'validation_failed',
              message: "That code wasn't accepted. The old link no longer works: send the new one.",
            },
          },
        });
      }
      list = [account({ label: 'friend@example.com', email: 'friend@example.com', signed_in: true, plan: 'pro' })];
      return route.fulfill({ json: { data: list[0] } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'no such route' } } });
  });
  return sent;
}

test('Add by sign-in link shows the link and signs in with the pasted code', async ({ page }) => {
  const sent = await accounts(page);
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Accounts & Usage' }).click();

  await expect(page.getByRole('button', { name: '+ Add in this browser' })).toBeVisible();
  await page.getByRole('button', { name: '+ Add by sign-in link' }).click();

  const dialog = page.getByRole('dialog', { name: 'Sign in by link' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Open link' })).toHaveAttribute('href', LINK);
  await expect(dialog).toContainText('claude.example.com/cai/oauth/authorize');
  await expect(dialog).toContainText(/the link stops working in 1[45]:\d\d/);
  expect(sent.map((call) => call.body)).toContainEqual({ via: 'link' });

  const box = dialog.getByRole('textbox', { name: 'Code from Anthropic' });
  await box.fill('typo#fake-state');
  await dialog.getByRole('button', { name: 'Sign in with code' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    "That code wasn't accepted. The old link no longer works: send the new one.",
  );

  // Closing keeps the sign-in; the row's Show link opens it again.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole('listitem', { name: 'New account' });
  await expect(row).toContainText('Waiting for a sign-in through the link.');
  await row.getByRole('button', { name: 'Show link' }).click();

  await box.fill('good#fake-state');
  await box.press('Enter');
  await expect(dialog.getByRole('status')).toHaveText(
    'Signed in as friend@example.com. The account is in the list now.',
  );
  expect(sent.at(-1)).toEqual({ path: '/agent-accounts/acc-1/logins/code', body: { code: 'good#fake-state' } });
});

test('Use CLIProxy needs a key first, then pauses the accounts and switching and shows in the sidebar', async ({
  page,
}) => {
  const sent: { method: string; path: string; body: unknown }[] = [];
  let hub = {
    enabled: false,
    address: 'http://127.0.0.1:8317',
    has_key: false,
    status: 'no_key',
    status_detail: null as string | null,
    checked_at: null as string | null,
  };
  const list = [account({ label: 'ops@example.com', email: 'ops@example.com', signed_in: true, is_active: true })];
  await page.route('**/api/agent-accounts**', (route) =>
    route.fulfill({ json: { data: list, meta: { next_cursor: null, active_account_id: 'acc-1', smart_pick: null } } }),
  );
  await page.route('**/api/cliproxy**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api', '');
    if (request.method() !== 'GET') sent.push({ method: request.method(), path, body: request.postDataJSON() });
    // CLIProxy is not running when the key is saved, and answers by the time of Check.
    if (path === '/cliproxy/key' && request.method() === 'PUT') {
      hub = { ...hub, has_key: true, status: 'unreachable', status_detail: 'Nothing answers at http://127.0.0.1:8317' };
    }
    if (path === '/cliproxy/checks') {
      hub = { ...hub, status: 'connected', status_detail: null, checked_at: new Date().toISOString() };
    }
    return route.fulfill({ json: { data: hub } });
  });
  await page.route('**/api/settings', async (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as { cliproxy?: typeof hub };
      sent.push({ method: 'PATCH', path: '/settings', body });
      if (body.cliproxy) hub = { ...hub, ...body.cliproxy };
      return route.fulfill({ response: await route.fetch({ method: 'GET' }) });
    }
    return route.fallback();
  });
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);

  const toggle = page.getByRole('switch', { name: 'Use CLIProxy' });
  await expect(toggle).toBeDisabled();
  await expect(page.getByText('No API key')).toBeVisible();
  await page.getByLabel('CLIProxy API key').fill('sk-test');
  await page.getByRole('button', { name: 'Save' }).nth(1).click();
  await expect(page.getByText('Not reachable')).toBeVisible();
  await expect(page.getByLabel('CLIProxy API key')).toHaveValue('');
  expect(sent[0]).toEqual({ method: 'PUT', path: '/cliproxy/key', body: { key: 'sk-test' } });
  // Not installed or not started: the toggle stays off until CLIProxy answers.
  await expect(toggle).toBeDisabled();
  await expect(page.getByText(/Turns on once CLIProxy answers: install it/)).toBeVisible();
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText('Connected')).toBeVisible();
  await expect(toggle).toBeEnabled();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(sent.at(-1)).toEqual({
    method: 'PATCH',
    path: '/settings',
    body: { cliproxy: { enabled: true, address: 'http://127.0.0.1:8317' } },
  });
  await expect(page.getByRole('status')).toHaveText(
    'CLIProxy manages Claude accounts and quota now. Turn off Use CLIProxy to manage them here.',
  );
  // The accounts and their switching are out of reach.
  await expect(page.locator('[inert] [aria-label="Auto-switch accounts"]')).toHaveCount(1);
  await expect(page.locator('[inert] section[aria-label="Claude Code accounts"]')).toHaveCount(1);
  await expect(page.locator('[inert] [aria-label="Use CLIProxy"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Claude account hub' })).toContainText('connected');

  await page.getByLabel('CLIProxy address').fill('https://proxy.example.com');
  await expect(page.getByRole('button', { name: 'Save' }).first()).toBeDisabled();
});

const hub = (enabled: boolean) => ({
  enabled,
  address: 'http://127.0.0.1:8317',
  has_key: true,
  status: 'connected',
  status_detail: null,
  checked_at: null,
});

const signedIn = (id: string, email: string, change: Record<string, unknown> = {}) =>
  account({ id, label: email, email, signed_in: true, plan: 'pro', ...change });

/** The accounts the page lists, and what it sends when a switch or Use is clicked. */
async function listAccounts(page: Page, list: ReturnType<typeof account>[], active: string | null, proxied = false) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  await page.route('**/api/cliproxy**', (route) => route.fulfill({ json: { data: hub(proxied) } }));
  await page.route('**/api/agent-accounts**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api', '');
    if (request.method() === 'GET') {
      return route.fulfill({
        json: { data: list, meta: { next_cursor: null, active_account_id: active, smart_pick: null } },
      });
    }
    const body = request.postDataJSON();
    sent.push({ method: request.method(), path, body });
    const target = list.find((one) => path.startsWith(`/agent-accounts/${one.id}`));
    if (request.method() === 'PATCH' && target) target.enabled = (body as { enabled: boolean }).enabled;
    return route.fulfill({ json: { data: target } });
  });
  return sent;
}

test('the Enable switch of an account sends the change, and a disabled account reads Disabled with Use off', async ({
  page,
}) => {
  const list = [
    signedIn('a1', 'ops@example.com', { is_active: true }),
    signedIn('a2', 'sam@example.com'),
    signedIn('a3', 'dev@example.com'),
  ];
  const sent = await listAccounts(page, list, 'a1');
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);

  const sam = page.getByRole('listitem', { name: 'sam@example.com' });
  await expect(page.getByRole('switch', { name: 'Enabled sam@example.com' })).toHaveAttribute('aria-checked', 'true');
  await expect(sam.getByRole('button', { name: 'Use' })).toBeEnabled();

  await page.getByRole('switch', { name: 'Enabled sam@example.com' }).click();
  await expect.poll(() => sent).toEqual([{ method: 'PATCH', path: '/agent-accounts/a2', body: { enabled: false } }]);
  await expect(page.getByRole('switch', { name: 'Enabled sam@example.com' })).toHaveAttribute('aria-checked', 'false');
  await expect(sam).toContainText('DISABLED');
  await expect(sam).toContainText('Disabled: skipped by Use, Smart pick and failover. Runs going on it finish.');
  await expect(sam.getByRole('button', { name: 'Use' })).toBeDisabled();
  await expect(sam.getByRole('button', { name: 'Use' })).toHaveAttribute('title', 'Enable this account first');

  await page.getByRole('switch', { name: 'Enabled sam@example.com' }).click();
  await expect
    .poll(() => sent.at(-1))
    .toEqual({ method: 'PATCH', path: '/agent-accounts/a2', body: { enabled: true } });
  await expect(sam.getByRole('button', { name: 'Use' })).toBeEnabled();
});

test('disabling the active account asks first and names the account runs move to', async ({ page }) => {
  const list = [
    signedIn('a1', 'ops@example.com', { is_active: true }),
    signedIn('a2', 'sam@example.com', { five_hour_pct: 60 }),
    signedIn('a3', 'dev@example.com', { five_hour_pct: 10 }),
  ];
  const sent = await listAccounts(page, list, 'a1');
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);

  await page.getByRole('switch', { name: 'Enabled ops@example.com' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Disable ops@example.com?' });
  await expect(dialog).toContainText('It is the active account. Runs going on it finish.');
  await expect(dialog).toContainText('New runs move to dev@example.com.');
  expect(sent).toEqual([]);

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent).toEqual([]);

  await page.getByRole('switch', { name: 'Enabled ops@example.com' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disable' }).click();
  await expect.poll(() => sent).toEqual([{ method: 'PATCH', path: '/agent-accounts/a1', body: { enabled: false } }]);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('disabling the only enabled account says no account will be active, and the page shows every account is disabled', async ({
  page,
}) => {
  const list = [signedIn('a1', 'ops@example.com', { is_active: true })];
  const sent = await listAccounts(page, list, 'a1');
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);

  await expect(page.getByText('Every Claude account is disabled.')).toHaveCount(0);
  await page.getByRole('switch', { name: 'Enabled ops@example.com' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('No account will be active');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disable' }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(page.getByRole('alert').filter({ hasText: 'Every Claude account is disabled.' })).toBeVisible();
});

test('the switch of a signed-out account and every switch under CLIProxy are dimmed with the reason', async ({
  page,
}) => {
  const list = [
    signedIn('a1', 'ops@example.com', { is_active: true }),
    account({ id: 'a2', label: 'team@example.com' }),
  ];
  await listAccounts(page, list, 'a1');
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);

  const out = page.getByRole('switch', { name: 'Enabled team@example.com' });
  await expect(out).toBeDisabled();
  await expect(out).toHaveAttribute('title', 'Sign in first');
  await expect(page.getByRole('switch', { name: 'Enabled ops@example.com' })).toBeEnabled();

  const proxied = await page.context().newPage();
  await listAccounts(proxied, [signedIn('a1', 'ops@example.com', { is_active: true })], 'a1', true);
  await proxied.goto(`${daemon.url}/agents#token=${daemon.token}`);
  const sw = proxied.locator('[role=switch][aria-label="Enabled ops@example.com"]');
  await expect(sw).toBeDisabled();
  await expect(sw).toHaveAttribute('title', 'CLIProxy picks the account');
});
