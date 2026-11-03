import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const latest = {
  version: '0.1.3',
  published_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  url: 'https://example.com/releases/tag/v0.1.3',
  notes: '- Connectors: Cancel a sign-in',
};
const base = {
  current: '0.1.2',
  latest: { ...latest, version: '0.1.2' },
  status: 'up_to_date',
  checked_at: new Date().toISOString(),
  error: null,
  auto_update: true,
  runs_going: 0,
  updated: null,
};

/** Answers `/api/updates` with `state`, and records what the page sends. */
async function updates(page: Page, state: Record<string, unknown>) {
  const sent: { url: string; body: unknown }[] = [];
  let current = { ...base, ...state };
  await page.route('**/api/updates**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: { data: current } });
    sent.push({ url: new URL(request.url()).pathname, body: request.postDataJSON() });
    if (new URL(request.url()).pathname === '/api/updates') {
      const when = (request.postDataJSON() as { when: string }).when;
      current = { ...current, status: when === 'now' ? 'updating' : 'waiting' };
    }
    return route.fulfill({ status: 202, json: { data: current } });
  });
  return sent;
}

const open = (page: Page) => page.goto(`${daemon.url}/#token=${daemon.token}`);

test('the footer shows the installed version, and its panel the latest one and auto-update', async ({ page }) => {
  await updates(page, {});
  await open(page);

  const line = page.getByRole('button', { name: 'Ops Console version' });
  await expect(line).toHaveText('v0.1.2·✓ Up to date');
  await expect(page.getByRole('region', { name: 'Update' })).toHaveCount(0);

  await line.click();
  const panel = page.getByRole('dialog', { name: 'Ops Console version' });
  await expect(panel.getByText('Installed')).toBeVisible();
  await expect(panel.getByRole('switch', { name: 'Update automatically' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('button', { name: /^Update to/ })).toHaveCount(0);
});

test('with auto-update off a newer version shows a card, and Update installs it', async ({ page }) => {
  const sent = await updates(page, { latest, status: 'available', auto_update: false });
  await open(page);

  const card = page.getByRole('region', { name: 'Update' });
  await expect(card).toContainText('Update available');
  await expect(card).toContainText('v0.1.3');
  await expect(card).toContainText("You're on v0.1.2 · released 2h ago");
  await expect(card.getByRole('link', { name: "What's new" })).toHaveAttribute('href', latest.url);
  await expect(page.getByRole('button', { name: 'Ops Console version' })).toContainText('v0.1.3 ready');

  await card.getByRole('button', { name: 'Update' }).click();
  await expect(card).toContainText('Updating to v0.1.3…');
  expect(sent).toEqual([{ url: '/api/updates', body: { when: 'now' } }]);
});

test('Update with agent runs going asks first; Wait until idle installs once they end', async ({ page }) => {
  const sent = await updates(page, { latest, status: 'available', auto_update: false, runs_going: 2 });
  await open(page);

  const card = page.getByRole('region', { name: 'Update' });
  await card.getByRole('button', { name: 'Update' }).click();
  await expect(card.getByRole('alert')).toContainText('2 agent runs going. They stop when the console restarts.');
  await card.getByRole('button', { name: 'Wait until idle' }).click();

  await expect(card).toContainText('v0.1.3 waits for agent runs');
  await expect(card).toContainText('It installs once 2 agent runs finish.');
  expect(sent).toEqual([{ url: '/api/updates', body: { when: 'idle' } }]);
});

test('a failed update says why and offers Try again', async ({ page }) => {
  await updates(page, {
    latest,
    status: 'failed',
    error: 'The update to 0.1.3 did not install: could not download',
  });
  await open(page);

  const card = page.getByRole('region', { name: 'Update' });
  await expect(card).toContainText('Update to v0.1.3 failed');
  await expect(card.getByRole('alert')).toHaveText('The update to 0.1.3 did not install: could not download');
  await expect(card.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('the panel switches auto-update and checks now', async ({ page }) => {
  const sent = await updates(page, {});
  let patched: unknown = null;
  await page.route('**/api/settings', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patched = route.request().postDataJSON();
    return route.fulfill({ json: { data: {} } });
  });
  await open(page);

  await page.getByRole('button', { name: 'Ops Console version' }).click();
  const panel = page.getByRole('dialog', { name: 'Ops Console version' });
  await panel.getByRole('switch', { name: 'Update automatically' }).click();
  await expect.poll(() => patched).toEqual({ updates: { auto_update: false } });

  await panel.getByRole('button', { name: 'Check now' }).click();
  await expect.poll(() => sent.map((call) => call.url)).toEqual(['/api/updates/checks']);
});

test('after an update a notification says so once, until it is closed', async ({ page }) => {
  await updates(page, { updated: { from: '0.1.1', at: new Date().toISOString(), automatic: true } });
  await open(page);

  const notice = page.getByRole('status', { name: 'Ops Console updated' });
  await expect(notice).toContainText('Updated to v0.1.2');
  await expect(notice).toContainText('Updated automatically at');
  await notice.getByRole('button', { name: 'Close' }).click();
  await expect(notice).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Ops Console version' })).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test('the collapsed sidebar keeps the version with a dot for a newer one', async ({ page }) => {
  await updates(page, { latest, status: 'available', auto_update: false });
  await open(page);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();

  const line = page.getByRole('button', { name: 'Ops Console version' });
  await expect(line).toHaveText('v0.1.2');
  await expect(line).toHaveAttribute('title', 'v0.1.3 is out. Opens the version panel.');
  await expect(page.getByRole('region', { name: 'Update' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
});
