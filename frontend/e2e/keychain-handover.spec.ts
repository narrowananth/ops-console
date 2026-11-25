import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const REFUSED = 'Handover refused: previous app failed its check';
const REASON = 'its bundle fails `codesign --verify --strict`: a sealed resource is missing or invalid';

const IDLE = { waiting: false, since: null, pending: 0 };

async function mockStatus(page: Page, handover: () => unknown, wait: unknown = IDLE) {
  await page.route('**/api/terminals/keychain-handover', (route) => route.fulfill({ json: { data: handover() } }));
  await page.route('**/api/terminals/keychain-wait', (route) => route.fulfill({ json: { data: wait } }));
  await page.route('**/api/terminals/disk-access', (route) =>
    route.fulfill({ json: { data: { granted: true, app_path: '/Applications/Ops Console.app' } } }),
  );
  await page.route('**/api/terminals/run-sandbox', (route) =>
    route.fulfill({ json: { data: { status: 'on', reason: null } } }),
  );
  await page.route('**/api/terminals/start-at-login', (route) =>
    route.fulfill({ json: { data: { on: true, dev_build: false } } }),
  );
}

const refusal = (page: Page) => page.getByRole('main').getByRole('alert', { name: 'Keychain handover' });

test('Accounts & Usage shows a refused Keychain handover with its reason, read-only, and again after a reload', async ({
  page,
}) => {
  const since = '2026-11-04T09:30:00.000Z';
  await mockStatus(page, () => ({ refused: true, reason: REASON }), { waiting: true, since, pending: 1 });
  await page.routeWebSocket('**/ws', () => {});
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);

  const row = refusal(page);
  await expect(row).toContainText(REFUSED);
  await expect(row).toContainText(REASON);
  await expect(row.getByRole('button')).toHaveCount(0);
  await expect(row.getByRole('switch')).toHaveCount(0);

  await page.reload();
  await expect(row).toContainText(REFUSED);
  await expect(row).toContainText(REASON);
});

test('an open Accounts & Usage page shows the refusal when the daemon sends it', async ({ page }) => {
  let handover: { refused: boolean; reason: string | null } = { refused: false, reason: null };
  await mockStatus(page, () => handover);
  let push = null as ((data: unknown) => void) | null;
  await page.routeWebSocket('**/ws', (socket) => {
    push = (data) =>
      socket.send(JSON.stringify({ event: 'keychain.handover_refused', at: new Date().toISOString(), data }));
  });
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);

  await expect(page.getByRole('main').getByRole('listitem', { name: 'Keychain' })).toBeVisible();
  await expect(refusal(page)).toHaveCount(0);

  handover = { refused: true, reason: REASON };
  await expect.poll(() => push !== null).toBe(true);
  push?.(handover);
  await expect(refusal(page)).toContainText(REFUSED);
  await expect(refusal(page)).toContainText(REASON);
});

test('Accounts & Usage shows no refusal when the handover went through', async ({ page }) => {
  await mockStatus(page, () => ({ refused: false, reason: null }));
  await page.routeWebSocket('**/ws', () => {});
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);
  await expect(page.getByRole('main').getByRole('listitem', { name: 'Keychain' })).toBeVisible();
  await expect(refusal(page)).toHaveCount(0);
});
