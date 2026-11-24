import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const IDLE = { waiting: false, since: null, pending: 0 };
const PENDING = 'Agent runs are off on Linux until the Run sandbox is verified there';

/** The daemon of a Linux machine, as the Permissions page reads it: no Full Disk Access, systemd, the Secret Service. */
async function mockLinux(
  page: Page,
  options: { keychain?: unknown; login?: unknown; sandbox?: unknown } = {},
): Promise<void> {
  const answer = (pattern: string, data: unknown) => page.route(pattern, (route) => route.fulfill({ json: { data } }));
  await answer('**/api/terminals/disk-access', { granted: null, app_path: null });
  await answer(
    '**/api/terminals/start-at-login',
    options.login ?? { on: true, dev_build: false, manager: 'systemd', lingering: false },
  );
  await answer(
    '**/api/terminals/keychain',
    options.keychain ?? { available: true, reason: null, store: 'secret_service' },
  );
  await answer('**/api/terminals/keychain-wait', IDLE);
  await answer('**/api/terminals/keychain-handover', { refused: false, reason: null });
  await answer('**/api/terminals/run-sandbox', options.sandbox ?? { status: 'unavailable', reason: PENDING });
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Permissions' }).click();
}

const row = (page: Page, name: string) => page.getByRole('main').getByRole('listitem', { name });

test('Permissions on Linux has no Full Disk Access, and shows systemd, lingering and the Secret Service', async ({
  page,
}) => {
  await mockLinux(page);
  const main = page.getByRole('main');
  await expect(main).toContainText('On this machine');
  await expect(main).not.toContainText('On this Mac');
  await expect(row(page, 'Full Disk Access')).toHaveCount(0);

  const login = row(page, 'Start at login');
  await expect(login).toContainText('● on');
  await expect(login).toContainText('systemd user service');
  await expect(login).toContainText('loginctl enable-linger $USER');
  await expect(login.getByRole('button')).toHaveCount(0);

  const keychain = row(page, 'Keychain');
  await expect(keychain).toContainText('Secret Service');
  await expect(keychain).not.toContainText('macOS');
});

test('lingering on drops the lingering line, and a stopped service says to run ops-console start', async ({ page }) => {
  await mockLinux(page, { login: { on: false, dev_build: false, manager: 'systemd', lingering: true } });
  const login = row(page, 'Start at login');
  await expect(login).toContainText('✕ off');
  await expect(login).toContainText('ops-console start');
  await expect(login).not.toContainText('loginctl enable-linger');
});

test('a dev build on Linux reads off · dev build', async ({ page }) => {
  await mockLinux(page, { login: { on: false, dev_build: true, manager: 'systemd', lingering: null } });
  await expect(row(page, 'Start at login')).toContainText('off · dev build');
});

test('with no Secret Service the Keychain row is unavailable and says why', async ({ page }) => {
  const reason = 'no Secret Service answered: no D-Bus session';
  await mockLinux(page, { keychain: { available: false, reason, store: 'secret_service' } });
  const keychain = row(page, 'Keychain');
  await expect(keychain).toContainText('✕ unavailable');
  await expect(keychain).toContainText('No Secret Service is running');
  await expect(keychain).toContainText(reason);
});

test('the Run sandbox row on Linux says runs are off and what is not settled', async ({ page }) => {
  await mockLinux(page);
  const sandbox = row(page, 'Run sandbox');
  await expect(sandbox).toContainText('✕ unavailable');
  await expect(sandbox).toContainText(PENDING);
  await expect(sandbox).toContainText('not settled on Linux yet');
  await expect(sandbox).not.toContainText('login Keychain');
});

test('Repos asks for a typed path when no folder dialog is installed', async ({ page }) => {
  await page.route('**/api/repos/folder-dialog', (route) => route.fulfill({ json: { data: { available: false } } }));
  const posted: unknown[] = [];
  await page.route('**/api/repos', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(route.request().postDataJSON());
    return route.fulfill({
      status: 400,
      json: { error: { code: 'validation_failed', message: 'not a git repository' } },
    });
  });
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Repos' }).click();

  await expect(page.getByRole('button', { name: /Local folder/ })).toHaveCount(0);
  const path = page.getByRole('textbox', { name: 'Folder path' });
  await path.fill('/home/dev/code/orders-api');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect.poll(() => posted).toEqual([{ path: '/home/dev/code/orders-api' }]);
});

test('Repos keeps the Browse button where a folder dialog exists', async ({ page }) => {
  await page.route('**/api/repos/folder-dialog', (route) => route.fulfill({ json: { data: { available: true } } }));
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Repos' }).click();
  await expect(page.getByRole('button', { name: /Local folder/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Folder path' })).toHaveCount(0);
});
