import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const NEEDS = 'ops-console:agent-runs.alert-needs-you';
const ENDS = 'ops-console:agent-runs.alert-ends';
const HEALTH = 'ops-console:notify.alert-health';

/** A browser that allows alerts: the headless one answers `denied` whatever the context grants. */
const allowAlerts = (page: Page) =>
  page.addInitScript(() => {
    Object.defineProperty(window, 'Notification', {
      value: class {
        static permission = 'granted';
        static requestPermission = async () => 'granted';
      },
    });
  });

/** The accounts the Agents page reads, with one account signed in. */
async function agents(page: Page) {
  const account = {
    id: 'a1',
    label: 'ops@example.com',
    position: 1,
    signed_in: true,
    signing_in: false,
    enabled: true,
    email: 'ops@example.com',
    plan: 'pro',
    five_hour_pct: 10,
    five_hour_resets_at: null,
    weekly_pct: 10,
    weekly_resets_at: null,
    usage_seen_at: null,
    last_checked_at: null,
    created_at: '2026-11-06T10:00:00.000Z',
    is_active: true,
    sign_in_link: null,
  };
  await page.route('**/api/agent-accounts', (route) =>
    route.fulfill({
      json: { data: [account], meta: { next_cursor: null, active_account_id: 'a1', smart_pick: null } },
    }),
  );
}

const stored = (page: Page, key: string) => page.evaluate((one) => localStorage.getItem(one), key);

test('the desktop alerts are set in Notifications on Accounts & Usage, and each asks the browser', async ({ page }) => {
  await allowAlerts(page);
  await agents(page);
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);

  const section = page.getByRole('region', { name: 'Notifications' });
  for (const name of [
    'Alert when a run needs me',
    'Alert when a run ends',
    'Alert when a connection or integration breaks',
  ]) {
    await expect(section.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'false');
  }
  await expect(section).toContainText(
    'A desktop alert when a Connection, Connector or MCP server stops working, and when it recovers.',
  );
  await section.getByRole('switch', { name: 'Alert when a run needs me' }).click();
  await section.getByRole('switch', { name: 'Alert when a run ends' }).click();
  await section.getByRole('switch', { name: 'Alert when a connection or integration breaks' }).click();
  await expect.poll(() => stored(page, NEEDS)).toBe('true');
  await expect.poll(() => stored(page, ENDS)).toBe('true');
  await expect.poll(() => stored(page, HEALTH)).toBe('true');
});

test('a refused browser shows why, and leaves the switch off', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Notification', {
      value: class {
        static permission = 'denied';
        static requestPermission = async () => 'denied';
      },
    });
  });
  await agents(page);
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);
  const sw = page.getByRole('switch', { name: 'Alert when a run ends' });
  await sw.click();
  await expect(page.getByRole('alert')).toContainText('The browser did not allow alerts.');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
});

test('the Agent runs page has no Alerts card, and its pill reads the status and links to Notifications', async ({
  page,
}) => {
  await allowAlerts(page);
  await agents(page);
  await page.route('**/api/agent-runs', (route) => route.fulfill({ json: { data: [], meta: { next_cursor: null } } }));
  await page.goto(`${daemon.url}/agent-runs#token=${daemon.token}`);

  await expect(page.getByRole('region', { name: 'Alerts' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Alert when a run needs me' })).toHaveCount(0);
  const pill = page.getByRole('link', { name: 'Alerts off' });
  await expect(pill).toHaveAttribute('href', '/agents#notifications');
  await expect(pill).toHaveAttribute('title', 'Set in Accounts & Usage › Notifications');

  await page.evaluate((key) => localStorage.setItem(key, 'true'), ENDS);
  await page.reload();
  await expect(page.getByRole('link', { name: 'Alerts on' })).toBeVisible();

  await page.getByRole('link', { name: 'Alerts on' }).click();
  await expect(page).toHaveURL(/\/agents#notifications$/);
  await expect(page.getByRole('region', { name: 'Notifications' })).toBeInViewport();
});

test('the pill says blocked when the browser refused alerts', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Notification', {
      value: class {
        static permission = 'denied';
        static requestPermission = async () => 'denied';
      },
    });
  });
  await page.route('**/api/agent-runs', (route) => route.fulfill({ json: { data: [], meta: { next_cursor: null } } }));
  await page.goto(`${daemon.url}/agent-runs#token=${daemon.token}`);
  await expect(page.getByRole('link', { name: 'Alerts blocked' })).toBeVisible();
});

test('the tabs move with the arrow keys, and a link to #notifications opens the Accounts tab', async ({ page }) => {
  await agents(page);
  await page.route('**/api/agent-accounts/usage**', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'x', message: 'no' } } }),
  );
  await page.goto(`${daemon.url}/agents?tab=usage#token=${daemon.token}`);
  await expect(page.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => {
    history.pushState(null, '', '/agents?tab=usage#notifications');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('tab', { name: /Accounts/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page).not.toHaveURL(/tab=usage/);
  const accounts = page.getByRole('tab', { name: /Accounts/ });
  await accounts.focus();
  await accounts.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/tab=usage/);
  await page.getByRole('tab', { name: 'Usage' }).press('ArrowLeft');
  await expect(accounts).toHaveAttribute('aria-selected', 'true');
  await expect(accounts).toContainText('1');
  await expect(page.getByRole('tabpanel')).toBeVisible();
});
