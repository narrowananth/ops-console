import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const SIGN_IN = 'Run ops-console open to sign in.';
const DAEMON_DOWN = 'The console daemon is not running. Run ops-console start.';

test('the URL from ops-console open signs in, hides the token and shows the shell', async ({ page }) => {
  await page.goto(`${daemon.url}/#token=${daemon.token}`);

  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Monitor' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Workspace' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Dev tools' })).toBeVisible();
  expect(page.url()).not.toContain(daemon.token);
  expect(page.url()).not.toContain('#');
  expect(await page.evaluate(() => sessionStorage.getItem('ops-console.token'))).toBe(daemon.token);

  await page.reload();
  await expect(nav.getByRole('link', { name: 'Monitor' })).toBeVisible();
});

test('the Settings drawer holds its five tabs', async ({ page }) => {
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('button', { name: 'Settings' }).click();

  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('tab')).toHaveText(['Agents', 'MCP servers', 'Connectors', 'Dev tools', 'Repos']);
  await expect(drawer.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');

  await drawer.getByRole('tab', { name: 'Repos' }).click();
  await expect(drawer.getByRole('tab', { name: 'Repos' })).toHaveAttribute('aria-selected', 'true');
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();
});

test('a client route loads the shell on a fresh page', async ({ page }) => {
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);
  await expect(page.getByRole('link', { name: 'Workspace' })).toHaveClass(/font-extrabold/);
});

test('without a token the shell asks to sign in', async ({ page }) => {
  await page.goto(daemon.url);
  await expect(page.getByRole('status')).toHaveText(SIGN_IN);
});

test('a token the daemon refuses asks to sign in', async ({ page }) => {
  await page.goto(`${daemon.url}/#token=not-the-token`);
  await expect(page.getByRole('status')).toHaveText(SIGN_IN);
});

test('a daemon that does not answer says to start it', async ({ page }) => {
  await page.route('**/api/health', (route) => route.abort('connectionrefused'));
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await expect(page.getByRole('status')).toHaveText(DAEMON_DOWN);
});
