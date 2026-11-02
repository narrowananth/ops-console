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
  expect(await page.evaluate(() => localStorage.getItem('ops-console.token'))).toBe(daemon.token);

  await page.reload();
  await expect(nav.getByRole('link', { name: 'Monitor' })).toBeVisible();

  // Closing the tab and opening the console again stays signed in.
  const again = await page.context().newPage();
  await page.close();
  await again.goto(daemon.url);
  await expect(again.getByRole('navigation').getByRole('link', { name: 'Monitor' })).toBeVisible();
});

test('the sidebar holds every page, and the Setup agent buttons open it', async ({ page }) => {
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link')).toHaveText([
    'Monitor',
    'Workspace',
    'Dev tools',
    'Integrations',
    'Connections',
    'Repos',
    'Setup agent',
    'Agents & accounts',
    'Playbooks',
  ]);

  await nav.getByRole('link', { name: 'Repos' }).click();
  await expect(page.getByRole('heading', { name: 'Repos' })).toBeVisible();
  expect(page.url()).toContain('/repos');

  for (const [link, button] of [
    ['Integrations', 'Add with Setup agent →'],
    ['Connections', 'Import with Setup agent →'],
  ]) {
    await nav.getByRole('link', { name: link }).click();
    await page.getByRole('button', { name: button }).click();
    await expect(page.getByRole('heading', { name: 'Setup agent' })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Start setup agent' })).toBeVisible();

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(nav.getByRole('link', { name: 'Monitor' })).toHaveAttribute('title', 'Monitor');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
});

test('the installed app starts the Setup agent only once Full Disk Access is on', async ({ page }) => {
  let granted = false;
  let opened = 0;
  await page.route('**/api/terminals/disk-access', (route) =>
    route.fulfill({ json: { data: { granted, app_path: '/Applications/Ops Console.app' } } }),
  );
  await page.route('**/api/terminals/disk-access/settings', (route) => {
    opened += 1;
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Setup agent' }).click();
  const drawer = page.getByRole('main');

  const permissions = drawer.getByRole('region', { name: 'Permissions' });
  const disk = permissions.getByRole('listitem', { name: 'Full Disk Access' });
  await expect(disk).toContainText('✕ off');
  await expect(disk).toContainText('Drag Ops Console from the Finder window');
  await expect(disk).toContainText('ops-console stop');
  await expect(permissions.getByRole('listitem', { name: 'Keychain' })).toContainText('asks each time');
  await expect(permissions.getByRole('img', { name: 'Ops Console logo' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Start setup agent' })).toBeDisabled();
  await disk.getByRole('button', { name: 'Open System Settings' }).click();
  await expect.poll(() => opened).toBe(1);

  granted = true;
  await disk.getByRole('button', { name: 'Check again' }).click();
  await expect(disk).toContainText('● on');
  await expect(drawer.getByRole('button', { name: 'Start setup agent' })).toBeEnabled();
});

test('pnpm dev runs as Ops Console (dev), and asks for Full Disk Access under that name', async ({ page }) => {
  await page.route('**/api/terminals/disk-access', (route) =>
    route.fulfill({ json: { data: { granted: false, app_path: '/repo/backend/.data/Ops Console (dev).app' } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Setup agent' }).click();
  const disk = page.getByRole('main').getByRole('listitem', { name: 'Full Disk Access' });
  await expect(disk).toContainText('✕ off');
  await expect(disk).toContainText('Drag Ops Console (dev) from the Finder window');
  await expect(disk).toContainText('stop pnpm dev and run it again');
  await expect(disk.getByRole('button', { name: 'Open System Settings' })).toBeVisible();
});

test('a daemon that is no app reads off · dev build and the Setup agent still starts', async ({ page }) => {
  await page.route('**/api/terminals/disk-access', (route) =>
    route.fulfill({ json: { data: { granted: false, app_path: null } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Setup agent' }).click();
  const drawer = page.getByRole('main');

  const disk = drawer.getByRole('listitem', { name: 'Full Disk Access' });
  await expect(disk).toContainText('off · dev build');
  await expect(disk.getByRole('button', { name: 'Open System Settings' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Start setup agent' })).toBeEnabled();
});

test('the Setup agent and its unsent line survive a page switch, and only Close ends it', async ({ page }) => {
  let running = true;
  let closed = 0;
  await page.route('**/api/terminals', (route) =>
    route.fulfill({ json: { data: running ? [{ id: 't1', kind: 'setup' }] : [] } }),
  );
  await page.route('**/api/terminals/t1', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    closed += 1;
    running = false;
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Setup agent' }).click();
  const drawer = page.getByRole('main');
  await expect(drawer.getByText('Setup agent running')).toBeVisible();

  await drawer.getByRole('textbox', { name: 'Message to Claude' }).fill('import my local databases');
  await page.getByRole('navigation').getByRole('link', { name: 'Repos' }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Setup agent' }).click();
  await expect(drawer.getByText('Setup agent running')).toBeVisible();
  await expect(drawer.getByRole('textbox', { name: 'Message to Claude' })).toHaveValue('import my local databases');
  expect(closed).toBe(0);

  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => closed).toBe(1);
  await expect(drawer.getByRole('button', { name: 'Start setup agent' })).toBeVisible();
});

test('Integrations lists Connectors and MCP servers, each labelled, and opens one beside the list', async ({
  page,
}) => {
  const server = (name: string, usedBy: string | null) => ({
    name,
    scope: 'user',
    repo_id: null,
    transport: 'http',
    target: 'https://mcp.example.com/mcp',
    config_file: '~/.claude.json',
    auth: 'oauth',
    status: 'ok',
    status_detail: null,
    tools: ['search'],
    tool_count: 1,
    env_keys: [],
    has_headers: false,
    enabled: true,
    registered: true,
    used_by: usedBy,
  });
  await page.route('**/api/mcp-servers', (route) =>
    route.fulfill({
      json: {
        data: [server('atlassian', 'jira'), server('sentry-tools', null)],
        meta: { next_cursor: null, connection_server_count: 0 },
      },
    }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const drawer = page.getByRole('main');

  const list = drawer.getByRole('list', { name: 'Integrations' });
  for (const name of ['Jira', 'Slack', 'GitHub', 'Shopify']) {
    await expect(list.getByRole('listitem', { name })).toContainText('Connector');
  }
  await expect(list.getByRole('listitem', { name: 'sentry-tools' })).toContainText('MCP');
  await expect(list.getByRole('listitem', { name: 'Shopify' })).toContainText('not connected');
  // Jira's row stands for its server.
  await expect(list.getByRole('listitem', { name: 'atlassian' })).toHaveCount(0);

  await list.getByRole('listitem', { name: 'sentry-tools' }).getByRole('button').first().click();
  await expect(drawer.getByText('Tools', { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await list.getByRole('listitem', { name: 'Shopify' }).getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(drawer.getByText('Connect Shopify to Ops Console')).toBeVisible();
  await expect(drawer.getByText('Reached through Shopify Dev MCP.')).toBeVisible();
});

test('Connect asks for nothing and shows GitHub its one-time code and sign-in page', async ({ page }) => {
  const github = {
    id: 'github',
    name: 'GitHub',
    via: 'gh CLI + GitHub MCP',
    status: 'off',
    status_detail: null,
    account_label: null,
    login: null,
    config: { org: null },
    last_checked_at: null,
    sign_in: null as { code: string | null; url: string | null } | null,
  };
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [github], meta: { next_cursor: null } } }),
  );
  await page.route('**/api/connectors/github/connect', (route) => {
    github.sign_in = { code: 'WXYZ-1234', url: 'https://github.com/login/device' };
    return route.fulfill({ status: 202 });
  });
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const drawer = page.getByRole('main');
  await drawer.getByRole('listitem', { name: 'GitHub' }).getByRole('button', { name: 'Connect', exact: true }).click();

  const step = drawer.getByRole('region', { name: 'Sign in' });
  await expect(step).toContainText("Opens GitHub's sign-in page in your browser. Nothing to fill in here.");
  await expect(drawer.getByRole('textbox')).toHaveCount(0);
  await step.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(step).toContainText('WXYZ-1234');
  await expect(step.getByRole('link', { name: 'Open GitHub ↗' })).toHaveAttribute(
    'href',
    'https://github.com/login/device',
  );
  await expect(step.getByRole('button', { name: 'Waiting…' })).toBeDisabled();
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

test('picks stay through page switches, reloads and reopening the console', async ({ page, context }) => {
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);
  const nav = page.getByRole('navigation');
  await page.getByRole('tab', { name: 'Pull requests' }).click();
  await expect(page).toHaveURL(/\/workspace\?tab=pulls$/);

  await nav.getByRole('link', { name: 'Integrations' }).click();
  await page
    .getByRole('list', { name: 'Integrations' })
    .getByRole('listitem', { name: 'Shopify' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click();
  await expect(page).toHaveURL(/\/integrations\?open=connector%3Ashopify$/);

  // The sidebar brings each page back as it was left.
  await nav.getByRole('link', { name: 'Workspace' }).click();
  await expect(page.getByRole('tab', { name: 'Pull requests' })).toHaveAttribute('aria-selected', 'true');
  await nav.getByRole('link', { name: 'Integrations' }).click();
  await expect(page.getByText('Connect Shopify to Ops Console')).toBeVisible();

  await page.reload();
  await expect(page.getByText('Connect Shopify to Ops Console')).toBeVisible();

  // A new tab at `/` opens the last page, still signed in.
  const again = await context.newPage();
  await page.close();
  await again.goto(daemon.url);
  await expect(again).toHaveURL(/\/integrations\?open=connector%3Ashopify$/);
  await expect(again.getByText('Connect Shopify to Ops Console')).toBeVisible();
});

test('a stored choice that no longer reads falls back to the default', async ({ page }) => {
  await page.goto(`${daemon.url}/workspace?tab=pulls#token=${daemon.token}`);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(() => localStorage.setItem('ops-console:workspace.pr-mine', '"not a boolean"'));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Mine', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('Shift+Enter adds a line to the Setup agent request; Enter sends the lines as one request', async ({ page }) => {
  const sent: unknown[] = [];
  await page.route('**/api/terminals', (route) => route.fulfill({ json: { data: [{ id: 't1', kind: 'setup' }] } }));
  await page.routeWebSocket('**/terminals/t1', (ws) =>
    ws.onMessage((message) => sent.push(JSON.parse(String(message)))),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Setup agent' }).click();
  const box = page.getByRole('main').getByRole('textbox', { name: 'Message to Claude' });

  await box.click();
  await box.pressSequentially('add vajro-test-db');
  await box.press('Shift+Enter');
  await box.pressSequentially('read only');
  await expect(box).toHaveValue('add vajro-test-db\nread only');
  expect(sent.filter((m) => (m as { type: string }).type === 'line')).toEqual([]);

  await box.press('Enter');
  await expect
    .poll(() => sent.filter((m) => (m as { type: string }).type === 'line'))
    .toEqual([{ type: 'line', text: 'add vajro-test-db\nread only' }]);
  await expect(box).toHaveValue('');
});
