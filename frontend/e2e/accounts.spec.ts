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
  await page.getByRole('navigation').getByRole('link', { name: 'Agents & accounts' }).click();

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
