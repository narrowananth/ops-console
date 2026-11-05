import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILT_IN_NETWORK_DOMAINS } from '@ops-console/shared';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const BUILT_IN = BUILT_IN_NETWORK_DOMAINS.length;
const inOrder = (domains: string[]) =>
  domains.toSorted(new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare);

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const api = (method: string, url: string, body?: unknown) =>
  fetch(`${daemon.url}/api${url}`, {
    method,
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

type Allowlist = { built_in: string[]; from_repos: { domain: string; repo: string }[]; added: string[] };
const read = async (): Promise<Allowlist> =>
  ((await (await api('GET', '/network-allowlist')).json()) as { data: Allowlist }).data;

/** The daemon is shared by every spec: leave no domain behind. */
test.afterEach(async () => {
  for (const domain of (await read()).added) {
    await api('DELETE', `/network-allowlist/domains/${encodeURIComponent(domain)}`);
  }
});

/** The page asks the Mac-only gates too; they are not what these tests check, so they are answered. */
async function openRow(page: Page) {
  await page.route('**/api/terminals/run-sandbox', (route) =>
    route.fulfill({ json: { data: { status: 'on', reason: null } } }),
  );
  await page.route('**/api/terminals/keychain-wait', (route) =>
    route.fulfill({ json: { data: { waiting: false, since: null, pending: 0 } } }),
  );
  await page.route('**/api/terminals/disk-access', (route) =>
    route.fulfill({ json: { data: { granted: true, app_path: '/Applications/Ops Console.app' } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Permissions' }).click();
  return page.getByRole('region', { name: 'Permissions' }).getByRole('listitem', { name: 'Network allowlist' });
}

test('Permissions counts the allowed domains and shows Built-in and Added by you, with no switch', async ({ page }) => {
  const folder = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-allowlist-')), 'billing');
  mkdirSync(folder);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: folder });
  execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.example.com/acme/billing.git'], { cwd: folder });
  const imported = await api('POST', '/repos', { path: folder });
  const repo = ((await imported.json()) as { data: { id: string } }).data;
  try {
    await api('POST', '/network-allowlist/domains', { domain: 'npm.example.com' });
    const row = await openRow(page);
    await expect(row).toContainText(`Network allowlist: ${BUILT_IN + 2} domains`);
    await expect(row.getByRole('switch')).toHaveCount(0);

    await row.getByRole('button', { name: new RegExp(`Network allowlist: ${BUILT_IN + 2} domains`) }).click();
    const builtIn = row.getByRole('list', { name: 'Built-in' });
    // A Repo's host is built in; the list never names the Repo.
    await expect(builtIn.getByRole('listitem')).toHaveText(
      inOrder([...BUILT_IN_NETWORK_DOMAINS, 'gitlab.example.com']),
    );
    await expect(row).not.toContainText('billing');
    await expect(builtIn.getByRole('button')).toHaveCount(0);
    await expect(row.getByRole('list', { name: 'Added by you' })).toContainText('npm.example.com');
  } finally {
    await api('DELETE', `/repos/${repo.id}`);
  }
});

test('the operator adds, repeats and removes a domain, and a reload shows the same list', async ({ page }) => {
  const row = await openRow(page);
  await row.getByRole('button', { name: /Network allowlist/ }).click();
  const added = row.getByRole('list', { name: 'Added by you' });
  await expect(added).toContainText('None added');

  const input = row.getByRole('textbox', { name: 'Domain' });
  await input.fill('  NPM.example.com ');
  await row.getByRole('button', { name: 'Add' }).click();
  await expect(added.getByRole('listitem')).toContainText(['npm.example.com']);
  await expect(row).toContainText(`Network allowlist: ${BUILT_IN + 1} domains`);
  await expect(input).toHaveValue('');

  // The same domain again, and a built-in one, change nothing.
  for (const again of ['npm.example.com', 'github.com']) {
    await input.fill(again);
    await row.getByRole('button', { name: 'Add' }).click();
    await expect(input).toHaveValue('');
  }
  await expect(added.getByRole('listitem')).toHaveCount(1);
  await expect(row).toContainText(`Network allowlist: ${BUILT_IN + 1} domains`);

  // A browser that opens the page later reads the same list.
  await page.reload();
  await expect(row).toContainText(`Network allowlist: ${BUILT_IN + 1} domains`);

  await row.getByRole('button', { name: /Network allowlist/ }).click();
  await added.getByRole('button', { name: 'Remove npm.example.com' }).click();
  await expect(added).toContainText('None added');
  await expect(row).toContainText(`Network allowlist: ${BUILT_IN} domains`);
});

test('a value the console refuses shows why, saves nothing and clears when edited', async ({ page }) => {
  const row = await openRow(page);
  await row.getByRole('button', { name: /Network allowlist/ }).click();
  const input = row.getByRole('textbox', { name: 'Domain' });

  for (const [value, message] of [
    ['', 'Enter a hostname'],
    ['*', 'A bare * would allow every host.'],
    ['https://npm.example.com', 'without https://'],
  ] as const) {
    await input.fill(value);
    await row.getByRole('button', { name: 'Add' }).click();
    await expect(row.getByRole('alert')).toContainText(message);
  }
  expect((await read()).added).toEqual([]);
  await input.fill('npm.example.com');
  await expect(row.getByRole('alert')).toHaveCount(0);
  await expect(row.getByText('Add example.com too')).toBeVisible();
});

test('a list that cannot be read shows the error and reads again on retry', async ({ page }) => {
  let failing = true;
  await page.route('**/api/network-allowlist', (route) =>
    failing
      ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'The list could not be read.' } } })
      : route.fallback(),
  );
  const row = await openRow(page);
  await expect(row).toContainText('Could not read the list');
  failing = false;
  await row.getByRole('button', { name: 'Retry' }).click();
  await expect(row).toContainText(`Network allowlist: ${BUILT_IN} domains`);
});
