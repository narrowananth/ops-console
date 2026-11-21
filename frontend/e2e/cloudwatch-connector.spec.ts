import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const API = '/ecs/shop-api';
const WORKER = '/aws/lambda/shop-worker';
const GROUPS = [API, WORKER, '/ecs/billing'];

const PROFILES = [
  { name: 'work', region: null },
  { name: 'shop-ro', region: 'us-east-1' },
  { name: 'default', region: 'us-west-2' },
];

const cloudwatch = (extra: Record<string, unknown> = {}) => ({
  id: 'cloudwatch_logs',
  name: 'CloudWatch logs',
  via: 'aws CLI + CloudWatch MCP',
  status: 'off',
  status_detail: null as string | null,
  account_label: null as string | null,
  login: null,
  config: { profile: '', region: '', log_groups: [] } as Record<string, unknown>,
  last_checked_at: null,
  sign_in: null as { code: string | null; url: string | null } | null,
  pick: null,
  ...extra,
});

const error = (status: number, code: string, message: string) => ({ status, json: { error: { code, message } } });

const list = (data: unknown[]) => ({ json: { data, meta: { next_cursor: null } } });

async function routeProfiles(page: Page, profiles: unknown[] = PROFILES) {
  await page.route('**/api/connectors/cloudwatch_logs/profiles', (route) => route.fulfill(list(profiles)));
}

async function openPane(page: Page, connector: ReturnType<typeof cloudwatch>, action: string) {
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [connector], meta: { next_cursor: null } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  await main
    .getByRole('listitem', { name: 'CloudWatch logs' })
    .getByRole('button', { name: action, exact: true })
    .click();
  return { main, pane: main.getByRole('complementary', { name: 'Integration' }) };
}

/** A Dropdown shows its current value on its button, and its options in a list that floats over the page. */
async function choose(page: Page, pane: Locator, picker: string, option: string | RegExp) {
  await pane.getByRole('button', { name: picker, exact: true }).click();
  await page.getByRole('option', { name: option }).click();
}

const connectButton = (pane: Locator) => pane.getByRole('button', { name: /^(Connect|Reconnect)$/ });
const sentConnect = (page: Page) =>
  page.waitForRequest((request) => request.url().endsWith('/api/connectors/cloudwatch_logs/connect'));

const signedIn = (extra: Record<string, unknown> = {}) =>
  cloudwatch({
    status: 'ok',
    account_label: 'shop-ro',
    config: { profile: 'shop-ro', region: 'us-east-1', log_groups: [] },
    ...extra,
  });

test('CloudWatch logs is not connected at first: profile and region pickers, no typed field, and Connect sends the pair', async ({
  page,
}) => {
  await routeProfiles(page);
  const connector = cloudwatch();
  await page.route('**/api/connectors/cloudwatch_logs/connect', (route) => {
    connector.sign_in = { code: null, url: 'https://sso.example.com/authorize' };
    return route.fulfill({ status: 202 });
  });
  const { main, pane } = await openPane(page, connector, 'Connect');
  await expect(pane.getByText('Connect CloudWatch logs to Ops Console')).toBeVisible();
  await expect(pane.getByText('Reached through aws CLI + CloudWatch MCP.')).toBeVisible();
  await expect(pane.getByText('○ not connected')).toBeVisible();
  await expect(main.getByRole('listitem', { name: 'CloudWatch logs' })).toContainText('○ not connected');
  await expect(pane.getByText(/CloudWatchLogsReadOnlyAccess/)).toBeVisible();
  await expect(pane.getByRole('textbox')).toHaveCount(0);
  await expect(pane.getByRole('region', { name: 'Sign in' })).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Log groups to read' })).toHaveCount(0);

  const profile = pane.getByRole('button', { name: 'AWS profile', exact: true });
  const region = pane.getByRole('button', { name: 'Region', exact: true });
  await expect(profile).toHaveText('default');
  await expect(region).toHaveText('us-west-2');
  await profile.click();
  await expect(page.getByRole('option')).toHaveText([/^default/, /^shop-ro/, /^work/]);
  await page.keyboard.press('Escape');

  const sent = sentConnect(page);
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({ profile: 'default', region: 'us-west-2' });
  await expect(pane.getByText('◌ signing in')).toBeVisible();
});

test('picking another profile takes that profile region, and a profile with none leaves Connect waiting for a region', async ({
  page,
}) => {
  await routeProfiles(page);
  const { pane } = await openPane(page, cloudwatch(), 'Connect');
  await choose(page, pane, 'AWS profile', /^shop-ro/);
  await expect(pane.getByRole('button', { name: 'Region', exact: true })).toHaveText('us-east-1');

  await choose(page, pane, 'AWS profile', /^work/);
  await expect(pane.getByRole('button', { name: 'Region', exact: true })).toHaveText('Choose a region');
  await expect(connectButton(pane)).toBeDisabled();

  await choose(page, pane, 'Region', 'eu-west-1');
  await expect(connectButton(pane)).toBeEnabled();
  const sent = sentConnect(page);
  await page.route('**/api/connectors/cloudwatch_logs/connect', (route) => route.fulfill({ status: 202 }));
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({ profile: 'work', region: 'eu-west-1' });
});

test('the Region picker lists AWS regions A to Z', async ({ page }) => {
  await routeProfiles(page);
  const { pane } = await openPane(page, cloudwatch(), 'Connect');
  await pane.getByRole('button', { name: 'Region', exact: true }).click();
  const names = await page.getByRole('option').allInnerTexts();
  expect(names.length).toBeGreaterThan(10);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
});

test('with no AWS profile on this Mac the pane says Connect creates default, and a region is chosen first', async ({
  page,
}) => {
  await routeProfiles(page, []);
  const { pane } = await openPane(page, cloudwatch(), 'Connect');
  await expect(pane.getByText(/No AWS profile on this Mac\. Connect creates `default`\./)).toBeVisible();
  await expect(connectButton(pane)).toBeDisabled();
  await choose(page, pane, 'Region', 'eu-central-1');
  const sent = sentConnect(page);
  await page.route('**/api/connectors/cloudwatch_logs/connect', (route) => route.fulfill({ status: 202 }));
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({ profile: 'default', region: 'eu-central-1' });
});

test('an AWS CLI too old for aws login stops Connect and the pane shows the version and the update command', async ({
  page,
}) => {
  const message =
    'AWS CLI 2.20.0 is too old for `aws login`: it needs 2.32.0. Update it with `brew upgrade awscli`, then Connect again.';
  await routeProfiles(page);
  await page.route('**/api/connectors/cloudwatch_logs/connect', (route) =>
    route.fulfill(error(409, 'invalid_state', message)),
  );
  const { pane } = await openPane(page, cloudwatch(), 'Connect');
  await connectButton(pane).click();
  await expect(pane.getByRole('alert')).toHaveText(message);
  await expect(pane.getByText('○ not connected')).toBeVisible();
});

test('a signed-in profile lists its log groups, defaults each Service, and sends the picks with the profile and region', async ({
  page,
}) => {
  await routeProfiles(page);
  const connector = signedIn();
  const asked: URL[] = [];
  await page.route('**/api/connectors/cloudwatch_logs/log-groups*', (route) => {
    asked.push(new URL(route.request().url()));
    return route.fulfill(list(GROUPS.map((name) => ({ name }))));
  });
  await page.route('**/api/connectors/cloudwatch_logs/connect', (route) => {
    Object.assign(connector, {
      config: { profile: 'shop-ro', region: 'us-east-1', log_groups: [{ name: API, service: 'api', env: 'staging' }] },
    });
    return route.fulfill({ status: 202 });
  });
  const { main, pane } = await openPane(page, connector, 'Manage');
  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'AWS profile', exact: true })).toHaveText('shop-ro');
  await expect(pane.getByRole('button', { name: 'Region', exact: true })).toHaveText('us-east-1');

  const groups = pane.getByRole('region', { name: 'Log groups to read' });
  const read = groups.getByRole('button', { name: 'Read these log groups' });
  await expect(read).toBeDisabled();
  await groups.getByRole('button', { name: 'Find log groups' }).click();

  const picker = pane.getByRole('list', { name: 'Log groups' });
  await expect(picker.getByRole('listitem')).toHaveText([
    /\/aws\/lambda\/shop-worker/,
    /\/ecs\/billing/,
    /\/ecs\/shop-api/,
  ]);
  expect(asked.map((url) => [url.searchParams.get('profile'), url.searchParams.get('region')])).toEqual([
    ['shop-ro', 'us-east-1'],
  ]);

  await expect(pane.getByRole('list', { name: 'Picked log groups' })).toHaveCount(0);
  await picker.getByRole('checkbox', { name: API }).check();
  const picked = pane.getByRole('listitem', { name: API });
  await expect(picked.getByRole('textbox', { name: 'Service name' })).toHaveValue('shop-api');
  await expect(picked.getByRole('textbox', { name: 'Env' })).toHaveValue('prod');
  await picked.getByRole('textbox', { name: 'Service name' }).fill('api');
  await picked.getByRole('textbox', { name: 'Env' }).fill('staging');

  const sent = sentConnect(page);
  await read.click();
  expect((await sent).postDataJSON()).toEqual({
    profile: 'shop-ro',
    region: 'us-east-1',
    log_groups: [{ name: API, service: 'api', env: 'staging' }],
  });
  await expect(main.getByRole('listitem', { name: 'CloudWatch logs' })).toContainText('shop-ro · us-east-1');
});

test('the picked groups of a connected Connector show with their Service and env, A to Z by group', async ({
  page,
}) => {
  await routeProfiles(page);
  const { pane } = await openPane(
    page,
    signedIn({
      config: {
        profile: 'shop-ro',
        region: 'us-east-1',
        log_groups: [
          { name: WORKER, service: 'worker', env: 'prod' },
          { name: API, service: 'api', env: 'prod' },
        ],
      },
    }),
    'Manage',
  );
  const picked = pane.getByRole('list', { name: 'Picked log groups' }).getByRole('listitem');
  await expect(picked).toHaveCount(2);
  await expect(picked.nth(0)).toHaveAccessibleName(WORKER);
  await expect(picked.nth(0).getByRole('textbox', { name: 'Service name' })).toHaveValue('worker');
  await expect(picked.nth(1)).toHaveAccessibleName(API);
  await expect(picked.nth(1).getByRole('textbox', { name: 'Service name' })).toHaveValue('api');
  await expect(pane.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
  await expect(pane.getByText('Reading 2 log groups in us-east-1 as shop-ro.')).toBeVisible();
});

test('two groups with one Service name and env are refused in the form until one changes', async ({ page }) => {
  await routeProfiles(page);
  await page.route('**/api/connectors/cloudwatch_logs/log-groups*', (route) =>
    route.fulfill(list(['/ecs/shop-api', '/aws/lambda/shop-api'].map((name) => ({ name })))),
  );
  const { pane } = await openPane(page, signedIn(), 'Manage');
  await pane.getByRole('button', { name: 'Find log groups' }).click();
  const picker = pane.getByRole('list', { name: 'Log groups' });
  await picker.getByRole('checkbox', { name: '/ecs/shop-api' }).check();
  await picker.getByRole('checkbox', { name: '/aws/lambda/shop-api' }).check();

  const read = pane.getByRole('button', { name: 'Read these log groups' });
  await expect(pane.getByRole('alert')).toHaveText(
    'Two log groups are the Service shop-api in prod. Change a name or an env.',
  );
  await expect(read).toBeDisabled();

  await pane
    .getByRole('listitem', { name: '/aws/lambda/shop-api' })
    .getByRole('textbox', { name: 'Env' })
    .fill('staging');
  await expect(pane.getByRole('alert')).toHaveCount(0);
  await expect(read).toBeEnabled();
});

for (const [code, status, message] of [
  ['tool_missing', 422, 'aws is not installed: install the AWS CLI with `brew install awscli`, then Connect again'],
  ['log_group_not_found', 422, 'Log group /ecs/gone was not found in us-east-1'],
  ['duplicate_service', 422, 'Two log groups are the Service api in prod'],
] as const) {
  test(`a ${code} answer from the daemon shows its message`, async ({ page }) => {
    await routeProfiles(page);
    await page.route('**/api/connectors/cloudwatch_logs/log-groups*', (route) => route.fulfill(list([{ name: API }])));
    await page.route('**/api/connectors/cloudwatch_logs/connect', (route) =>
      route.fulfill(error(status, code, message)),
    );
    const { pane } = await openPane(page, signedIn(), 'Manage');
    await pane.getByRole('button', { name: 'Find log groups' }).click();
    await pane.getByRole('checkbox', { name: API }).check();
    await pane.getByRole('button', { name: 'Read these log groups' }).click();
    await expect(pane.getByRole('alert')).toHaveText(message);
  });
}

test('the log group list shows loading, then an empty answer, then the daemon reason when it fails', async ({
  page,
}) => {
  await routeProfiles(page);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let answers = 0;
  await page.route('**/api/connectors/cloudwatch_logs/log-groups*', async (route) => {
    answers++;
    if (answers === 1) {
      await gate;
      return route.fulfill(list([]));
    }
    return route.fulfill(error(502, 'upstream_failed', 'AWS profile shop-ro is signed out'));
  });
  const { pane } = await openPane(page, signedIn(), 'Manage');
  const find = pane.getByRole('button', { name: 'Find log groups' });
  await find.click();
  await expect(pane.getByText('Reading log groups…')).toBeVisible();
  await expect(find).toBeDisabled();
  release();
  await expect(pane.getByText('shop-ro sees no log groups in us-east-1.')).toBeVisible();

  await choose(page, pane, 'Region', 'eu-west-1');
  await find.click();
  await expect(pane.getByRole('alert')).toHaveText('AWS profile shop-ro is signed out');
  await expect(pane.getByRole('list', { name: 'Log groups' })).toHaveCount(0);
});

test('signing in shows Waiting, the link and Cancel, and Cancel stops the sign-in', async ({ page }) => {
  await routeProfiles(page);
  const connector = cloudwatch({
    sign_in: { code: null, url: 'https://sso.example.com/authorize' },
    pick: null,
    config: { profile: 'shop-ro', region: 'us-east-1', log_groups: [] },
  });
  await page.route('**/api/connectors/cloudwatch_logs/sign-in', (route) => {
    connector.sign_in = null;
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Connect');
  await expect(pane.getByText('◌ signing in')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Waiting…' })).toBeDisabled();
  await expect(pane.getByRole('link', { name: /Open CloudWatch logs/ })).toHaveAttribute(
    'href',
    'https://sso.example.com/authorize',
  );
  await pane.getByRole('button', { name: 'Cancel' }).click();
  await expect(pane.getByRole('button', { name: 'Waiting…' })).toHaveCount(0);
  await expect(main.getByRole('listitem', { name: 'CloudWatch logs' })).toContainText('○ not connected');
});

test('a profile that needs auth shows the reason and Reconnect on the pane and row', async ({ page }) => {
  await routeProfiles(page);
  const detail = 'The AWS session for shop-ro has expired. Connect to sign in again.';
  const { main, pane } = await openPane(
    page,
    cloudwatch({
      status: 'auth',
      status_detail: detail,
      config: { profile: 'shop-ro', region: 'us-east-1', log_groups: [{ name: API, service: 'api', env: 'prod' }] },
    }),
    'Reconnect',
  );
  await expect(pane.getByRole('alert').first()).toHaveText(detail);
  await expect(pane.getByRole('button', { name: 'AWS profile', exact: true })).toHaveText('shop-ro');
  await expect(connectButton(pane)).toBeEnabled();
  await expect(main.getByRole('listitem', { name: 'CloudWatch logs' })).toContainText('needs auth');
});

test('a Connector that is down shows the reason on the pane and failed on the row', async ({ page }) => {
  await routeProfiles(page);
  const detail = 'Log group /ecs/gone was not found in us-east-1';
  const { main, pane } = await openPane(
    page,
    cloudwatch({
      status: 'fail',
      status_detail: detail,
      config: {
        profile: 'shop-ro',
        region: 'us-east-1',
        log_groups: [{ name: '/ecs/gone', service: 'gone', env: 'prod' }],
      },
    }),
    'Reconnect',
  );
  await expect(pane.getByRole('alert').first()).toHaveText(detail);
  await expect(main.getByRole('listitem', { name: 'CloudWatch logs' })).toContainText('✕ failed');
});

test('a Connector being checked shows checking and cannot be connected again', async ({ page }) => {
  await routeProfiles(page);
  const { pane } = await openPane(page, signedIn({ status: 'checking' }), 'Manage');
  await expect(pane.getByText('◌ checking')).toBeVisible();
  await expect(connectButton(pane)).toBeDisabled();
});

test('disconnecting CloudWatch logs says the AWS profile and account stay', async ({ page }) => {
  await routeProfiles(page);
  const connector = signedIn({
    config: { profile: 'shop-ro', region: 'us-east-1', log_groups: [{ name: API, service: 'api', env: 'prod' }] },
  });
  await page.route('**/api/connectors/cloudwatch_logs/credentials', (route) => {
    Object.assign(connector, { status: 'off' });
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Manage');
  await pane.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(pane.getByText('Your AWS profile and account stay as they are.')).toBeVisible();
  await expect(pane.getByText(/Signs out/)).toHaveCount(0);
  await pane.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(main.getByRole('listitem', { name: 'CloudWatch logs' })).toContainText('○ not connected');
});
