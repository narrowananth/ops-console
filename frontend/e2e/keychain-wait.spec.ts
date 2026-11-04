import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const MESSAGE = "Keychain is waiting for the Mac's password prompt";
const SINCE = '2026-11-04T09:30:00.000Z';

test('a Keychain wait shows a banner on every page and in Permissions until it ends', async ({ page }) => {
  let wait: { waiting: boolean; since: string | null; pending: number } = { waiting: true, since: SINCE, pending: 1 };
  await page.route('**/api/terminals/keychain-wait', (route) => route.fulfill({ json: { data: wait } }));
  await page.route('**/api/terminals/disk-access', (route) =>
    route.fulfill({ json: { data: { granted: true, app_path: '/Applications/Ops Console.app' } } }),
  );
  await page.route('**/api/terminals/run-sandbox', (route) =>
    route.fulfill({ json: { data: { status: 'on', reason: null } } }),
  );
  let push = null as ((data: unknown) => void) | null;
  await page.routeWebSocket('**/ws', (socket) => {
    push = (data) =>
      socket.send(JSON.stringify({ event: 'keychain.wait_changed', at: new Date().toISOString(), data }));
  });

  // A page that loads in the middle of a wait shows the banner.
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  const banner = page.getByRole('alert', { name: 'Keychain wait' });
  await expect(banner).toContainText(MESSAGE);
  await expect(banner).toContainText('Answer it on the Mac.');

  // It follows the operator to the other pages, and Permissions shows the same state.
  await page.getByRole('navigation').getByRole('link', { name: 'Permissions' }).click();
  await expect(banner).toBeVisible();
  const keychain = page.getByRole('region', { name: 'Permissions' }).getByRole('listitem', { name: 'Keychain' });
  await expect(keychain).toContainText('waiting since');
  await expect(keychain).toContainText(MESSAGE);

  // The last pending call ends: the daemon says so and both go.
  wait = { waiting: false, since: null, pending: 0 };
  await expect.poll(() => push !== null).toBe(true);
  push?.(wait);
  await expect(banner).toHaveCount(0);
  await expect(keychain).toContainText('asks each time');
});

test('Permissions reads the Run sandbox as on, or unavailable with the reason, and has no control for it', async ({
  page,
}) => {
  let sandbox: { status: string; reason: string | null } = { status: 'on', reason: null };
  await page.route('**/api/terminals/run-sandbox', (route) => route.fulfill({ json: { data: sandbox } }));
  await page.route('**/api/terminals/keychain-wait', (route) =>
    route.fulfill({ json: { data: { waiting: false, since: null, pending: 0 } } }),
  );
  await page.route('**/api/terminals/disk-access', (route) =>
    route.fulfill({ json: { data: { granted: true, app_path: '/Applications/Ops Console.app' } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await expect(page.getByRole('alert', { name: 'Keychain wait' })).toHaveCount(0);

  await page.getByRole('navigation').getByRole('link', { name: 'Permissions' }).click();
  const row = page.getByRole('region', { name: 'Permissions' }).getByRole('listitem', { name: 'Run sandbox' });
  await expect(row).toContainText('● on');
  await expect(row.getByRole('button')).toHaveCount(0);
  await expect(row.getByRole('switch')).toHaveCount(0);

  sandbox = { status: 'unavailable', reason: 'sandbox-exec is not permitted' };
  await page.reload();
  await expect(row).toContainText('✕ unavailable');
  await expect(row).toContainText('sandbox-exec is not permitted');
});
