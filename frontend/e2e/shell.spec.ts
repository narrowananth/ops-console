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
  await expect(nav.getByRole('link', { name: 'Sessions' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Pull requests' })).toBeVisible();
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

test('the sidebar holds every page, and Setup is no page of it', async ({ page }) => {
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link')).toHaveText([
    'Sessions',
    'Pull requests',
    'Monitor',
    'Dev tools',
    'Integrations',
    'Connections',
    'Repos',
    'Accounts & Usage',
    'Agent runs',
    'Playbooks',
    'Skills',
  ]);

  await nav.getByRole('link', { name: 'Repos' }).click();
  await expect(page.getByRole('heading', { name: 'Repos' })).toBeVisible();
  expect(page.url()).toContain('/repos');

  await nav.getByRole('link', { name: 'Integrations' }).click();
  await expect(page.getByRole('button', { name: /Setup agent/ })).toHaveCount(0);
  await nav.getByRole('link', { name: 'Connections' }).click();
  await expect(page.getByRole('button', { name: /Setup agent/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(nav.getByRole('link', { name: 'Monitor' })).toHaveAttribute('title', 'Monitor');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
});

test('Full Disk Access reads off with its steps, opens System Settings, and reads on when the window comes back', async ({
  page,
}) => {
  let granted = false;
  let opened = 0;
  await page.route('**/api/terminals/disk-access', (route) =>
    route.fulfill({ json: { data: { granted, app_path: '/Applications/Ops Console.app' } } }),
  );
  await page.route('**/api/terminals/disk-access/settings', (route) => {
    opened += 1;
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);
  const disk = page.getByRole('main').getByRole('listitem', { name: 'Full Disk Access' });
  await expect(disk).toContainText('off');
  await expect(disk).toContainText('Drag Ops Console from the Finder window');
  await expect(disk).toContainText('ops-console stop');
  await disk.getByRole('button', { name: 'Open System Settings' }).click();
  await expect.poll(() => opened).toBe(1);

  granted = true;
  await disk.getByRole('button', { name: 'Check again' }).click();
  await expect(disk).toContainText('on');
  await expect(disk.getByRole('button')).toHaveCount(0);
});

test('pnpm dev runs as Ops Console (dev), and asks for Full Disk Access under that name', async ({ page }) => {
  await page.route('**/api/terminals/disk-access', (route) =>
    route.fulfill({ json: { data: { granted: false, app_path: '/repo/backend/.data/Ops Console (dev).app' } } }),
  );
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);
  const disk = page.getByRole('main').getByRole('listitem', { name: 'Full Disk Access' });
  await expect(disk).toContainText('Drag Ops Console (dev) from the Finder window');
  await expect(disk).toContainText('stop pnpm dev and run it again');
  await expect(disk.getByRole('button', { name: 'Open System Settings' })).toBeVisible();
});

test('a daemon that is no app reads off · dev build, with nothing to open', async ({ page }) => {
  await page.route('**/api/terminals/disk-access', (route) =>
    route.fulfill({ json: { data: { granted: false, app_path: null } } }),
  );
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);
  const disk = page.getByRole('main').getByRole('listitem', { name: 'Full Disk Access' });
  await expect(disk).toContainText('off · dev build');
  await expect(disk.getByRole('button', { name: 'Open System Settings' })).toHaveCount(0);
});

test('Start at login shows in the On this machine section, after Notifications', async ({ page }) => {
  await page.route('**/api/terminals/start-at-login', (route) =>
    route.fulfill({ json: { data: { on: true, dev_build: false } } }),
  );
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);
  const main = page.getByRole('main');
  const login = main.getByRole('listitem', { name: 'Start at login' });
  await expect(login).toContainText('on');
  await expect(login.getByRole('button', { name: 'Open Login Items' })).toBeVisible();
  const headings = await main.getByRole('heading', { level: 2 }).allTextContents();
  expect(headings.indexOf('On this machine')).toBeGreaterThan(headings.indexOf('Notifications'));
});

test('Accounts & Usage leaves the same gap above On this machine as between its other sections (Behavior 1)', async ({
  page,
}) => {
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);
  await expect(page.locator('#on-this-machine')).toBeVisible();
  const above = await page.locator('#notifications').boundingBox();
  const below = await page.locator('#on-this-machine').boundingBox();
  expect(above && below).toBeTruthy();
  if (!above || !below) return;
  expect(below.y - (above.y + above.height)).toBeGreaterThanOrEqual(24);
});

test('two neighbouring sidebar items never touch, so the selected one’s shadow and a hovered one stay apart (Behavior 2)', async ({
  page,
}) => {
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  const nav = page.getByRole('navigation', { name: 'Ops Console' });
  const links = nav.getByRole('link');
  const count = await links.count();
  for (let at = 1; at < count; at += 1) {
    const [a, b] = [await links.nth(at - 1).boundingBox(), await links.nth(at).boundingBox()];
    if (!a || !b || b.y < a.y) continue;
    // Items of one group sit closer than the gap between groups; none sits closer than 6 px.
    expect(b.y - (a.y + a.height), `item ${at}`).toBeGreaterThanOrEqual(6);
  }
});

test('a visit to /setup or /permissions opens the Sessions page, and no screen names the Setup agent', async ({
  page,
}) => {
  for (const old of ['/setup', '/permissions']) {
    await page.goto(`${daemon.url}${old}#token=${daemon.token}`);
    await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/sessions');
  }
  await expect(page.getByRole('navigation').getByRole('link', { name: /Setup|Permissions/ })).toHaveCount(0);
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

test('Connect asks for nothing, shows GitHub its one-time code and sign-in page, and Cancel stops it', async ({
  page,
}) => {
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
    pick: null,
  };
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [github], meta: { next_cursor: null } } }),
  );
  await page.route('**/api/connectors/github/connect', (route) => {
    github.sign_in = { code: 'WXYZ-1234', url: 'https://github.com/login/device' };
    return route.fulfill({ status: 202 });
  });
  await page.route('**/api/connectors/github/sign-in', (route) => {
    github.sign_in = null;
    return route.fulfill({ json: { data: github } });
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

  await step.getByRole('button', { name: 'Cancel' }).click();
  await expect(step.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  await expect(step).not.toContainText('WXYZ-1234');
  await expect(step.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
});

test('slashdocs asks for its server, saves it, then connects through its CLI', async ({ page }) => {
  const slashdocs = {
    id: 'slashdocs',
    name: 'slashdocs',
    via: 'slashdocs CLI',
    status: 'off',
    status_detail: null,
    account_label: null as string | null,
    login: null as string | null,
    config: { server: '' },
    last_checked_at: null,
    sign_in: null,
    pick: null,
  };
  const calls: string[] = [];
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [slashdocs], meta: { next_cursor: null } } }),
  );
  await page.route('**/api/connectors/slashdocs', (route) => {
    calls.push(`PATCH ${JSON.stringify(route.request().postDataJSON())}`);
    slashdocs.config = route.request().postDataJSON().config;
    return route.fulfill({ json: { data: slashdocs } });
  });
  await page.route('**/api/connectors/slashdocs/connect', (route) => {
    calls.push('connect');
    Object.assign(slashdocs, { status: 'ok', login: 'operator@example.com', account_label: 'slashdocs.example.com' });
    return route.fulfill({ status: 202 });
  });
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const drawer = page.getByRole('main');
  await drawer
    .getByRole('listitem', { name: 'slashdocs' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click();

  await drawer.getByRole('textbox', { name: 'slashdocs server' }).fill('slashdocs.example.com');
  const step = drawer.getByRole('region', { name: 'Sign in' });
  await step.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect(step).toContainText('Signed in as operator@example.com · slashdocs.example.com.');
  expect(calls).toEqual(['PATCH {"config":{"server":"slashdocs.example.com"}}', 'connect']);
});

test('a client route loads the shell on a fresh page', async ({ page }) => {
  await page.goto(`${daemon.url}/pull-requests#token=${daemon.token}`);
  await expect(page.getByRole('link', { name: 'Pull requests' })).toHaveClass(/font-extrabold/);
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
  await page.goto(`${daemon.url}/pull-requests?pr=r1%2F7#token=${daemon.token}`);
  const nav = page.getByRole('navigation');
  await expect(page).toHaveURL(/\/pull-requests\?pr=r1%2F7$/);

  await nav.getByRole('link', { name: 'Integrations' }).click();
  await page
    .getByRole('list', { name: 'Integrations' })
    .getByRole('listitem', { name: 'Shopify' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click();
  await expect(page).toHaveURL(/\/integrations\?open=connector%3Ashopify$/);

  // The sidebar brings each page back as it was left.
  await nav.getByRole('link', { name: 'Pull requests' }).click();
  await expect(page).toHaveURL(/\/pull-requests\?pr=r1%2F7$/);
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
  await page.goto(`${daemon.url}/pull-requests#token=${daemon.token}`);
  const whose = page.getByRole('group', { name: 'Whose pull requests' });
  await whose.getByRole('button', { name: 'All', exact: true }).click();
  await page.reload();
  await expect(whose.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(() => localStorage.setItem('ops-console:workspace.pr-whose', '"nobody"'));
  await page.reload();
  await expect(whose.getByRole('button', { name: 'Mine', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a control explains itself on hover and on keyboard focus, then keeps its title', async ({ page }) => {
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  const tip = page.getByRole('tooltip');

  await collapse.hover();
  await expect(tip).toHaveText('Collapse sidebar');
  await expect(collapse).toHaveAccessibleDescription('Collapse sidebar');
  await page.mouse.move(600, 400);
  await expect(tip).toHaveCount(0);
  await expect(collapse).toHaveAttribute('title', 'Collapse sidebar');

  await collapse.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(tip).toHaveText('Collapse sidebar');
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
});

test('the Sessions page has no page bar: the Session header is the top bar and the transcript sits right under it', async ({
  page,
}) => {
  const now = '2026-10-31T10:00:00.000Z';
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('**/api/repos', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'r1',
            name: 'apis',
            path: '/work/apis',
            host: 'github',
            remote_slug: 'example/apis',
            origin_slug: null,
            default_branch: 'main',
            created_at: now,
            branch: 'main',
            dirty: false,
            missing: false,
            session_count: 1,
          },
        ],
        meta: { next_cursor: null },
      },
    }),
  );
  const session = {
    id: 's1',
    kind: 'repo',
    title: 'fresh start',
    model: 'claude-opus-5-5',
    effort: 'medium',
    access_mode: 'auto',
    account_id: null,
    repo_id: 'r1',
    branch: 'main',
    pr_number: null,
    pr_action: null,
    connection_ids: null,
    extra_repo_ids: [],
    pull_request: null,
    pull_requests: [],
    alert_id: null,
    state: 'idle',
    last_message_preview: null,
    last_error: null,
    created_at: now,
    last_active_at: now,
    playbook: null,
    queued_message: null,
    spawned_by: null,
    spawned: [],
    subagents: [],
  };
  await page.route(/\/api\/sessions\?kind=repo/, (route) => route.fulfill({ json: { data: [session] } }));
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: [] } }));
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);

  const sessionHeader = page.locator('header').filter({ has: page.getByRole('heading', { name: 'fresh start' }) });
  await expect(sessionHeader).toBeVisible();
  const box = await sessionHeader.boundingBox();
  expect(box?.y).toBeLessThan(60);
  // The page title stays for assistive tech and the heading outline.
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toHaveCount(1);
});

test('a page with an action gets one slim bar and keeps the action in it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${daemon.url}/playbooks#token=${daemon.token}`);

  const bar = page.locator('header').filter({ has: page.getByRole('heading', { name: 'Playbooks', level: 1 }) });
  const action = bar.getByRole('button', { name: 'New Playbook' });
  await expect(action).toBeVisible();
  const box = await bar.boundingBox();
  expect(box?.height).toBeLessThan(48);
  const actionBox = await action.boundingBox();
  expect(actionBox?.height).toBeLessThanOrEqual(box?.height ?? 0);
});
