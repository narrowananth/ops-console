import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const API = '/ecs/shop-api';
const WORKER = '/aws/lambda/shop-worker';
const GROUPS = [API, WORKER, '/ecs/billing'];

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
  ...extra,
});

const error = (status: number, code: string, message: string) => ({ status, json: { error: { code, message } } });

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

async function fillIdentity(pane: ReturnType<Page['locator']>, profile = 'shop-ro', region = 'us-east-1') {
  await pane.getByRole('textbox', { name: 'AWS profile' }).fill(profile);
  await pane.getByRole('textbox', { name: 'Region' }).fill(region);
}

test('connecting CloudWatch logs lists the groups of the typed profile and region, defaults each Service, and sends the picks', async ({
  page,
}) => {
  const connector = cloudwatch();
  const asked: URL[] = [];
  await page.route('**/api/connectors/cloudwatch_logs/log-groups*', (route) => {
    asked.push(new URL(route.request().url()));
    return route.fulfill({ json: { data: GROUPS.map((name) => ({ name })), meta: { next_cursor: null } } });
  });
  await page.route('**/api/connectors/cloudwatch_logs/connect', (route) => {
    Object.assign(connector, {
      status: 'ok',
      account_label: 'shop-ro',
      config: {
        profile: 'shop-ro',
        region: 'us-east-1',
        log_groups: [{ name: API, service: 'api', env: 'staging' }],
      },
    });
    return route.fulfill({ status: 202 });
  });
  const { main, pane } = await openPane(page, connector, 'Connect');
  await expect(pane.getByText('Connect CloudWatch logs to Ops Console')).toBeVisible();
  await expect(pane.getByText('Reached through aws CLI + CloudWatch MCP.')).toBeVisible();
  await expect(pane.getByText(/CloudWatchLogsReadOnlyAccess/)).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Sign in' })).toHaveCount(0);

  const connect = pane.getByRole('button', { name: 'Connect', exact: true });
  const find = pane.getByRole('button', { name: 'Find log groups' });
  await expect(connect).toBeDisabled();
  await expect(find).toBeDisabled();
  await fillIdentity(pane);
  await expect(connect).toBeDisabled();
  await find.click();

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

  const sent = page.waitForRequest((request) => request.url().endsWith('/api/connectors/cloudwatch_logs/connect'));
  await connect.click();
  expect((await sent).postDataJSON()).toEqual({
    profile: 'shop-ro',
    region: 'us-east-1',
    log_groups: [{ name: API, service: 'api', env: 'staging' }],
  });

  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(pane.getByRole('textbox', { name: 'AWS profile' })).toHaveValue('shop-ro');
  await expect(pane.getByRole('textbox', { name: 'Region' })).toHaveValue('us-east-1');
  await expect(main.getByRole('listitem', { name: 'CloudWatch logs' })).toContainText('shop-ro · us-east-1');
});

test('the picked groups of a connected Connector show with their Service and env, A to Z by group', async ({
  page,
}) => {
  const { pane } = await openPane(
    page,
    cloudwatch({
      status: 'ok',
      account_label: 'shop-ro',
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
});

test('two groups with one Service name and env are refused in the form until one changes', async ({ page }) => {
  await page.route('**/api/connectors/cloudwatch_logs/log-groups*', (route) =>
    route.fulfill({
      json: { data: ['/ecs/shop-api', '/aws/lambda/shop-api'].map((name) => ({ name })), meta: { next_cursor: null } },
    }),
  );
  const { pane } = await openPane(page, cloudwatch(), 'Connect');
  await fillIdentity(pane);
  await pane.getByRole('button', { name: 'Find log groups' }).click();
  const picker = pane.getByRole('list', { name: 'Log groups' });
  await picker.getByRole('checkbox', { name: '/ecs/shop-api' }).check();
  await picker.getByRole('checkbox', { name: '/aws/lambda/shop-api' }).check();

  const connect = pane.getByRole('button', { name: 'Connect', exact: true });
  await expect(pane.getByRole('alert')).toHaveText(
    'Two log groups are the Service shop-api in prod. Change a name or an env.',
  );
  await expect(connect).toBeDisabled();

  await pane
    .getByRole('listitem', { name: '/aws/lambda/shop-api' })
    .getByRole('textbox', { name: 'Env' })
    .fill('staging');
  await expect(pane.getByRole('alert')).toHaveCount(0);
  await expect(connect).toBeEnabled();
});

for (const [code, status, message] of [
  ['tool_missing', 422, 'aws is not installed: install the AWS CLI with `brew install awscli`, then Connect again'],
  ['log_group_not_found', 422, 'Log group /ecs/gone was not found in us-east-1'],
  ['duplicate_service', 422, 'Two log groups are the Service api in prod'],
] as const) {
  test(`a ${code} answer from the daemon shows its message and leaves the Connector unconnected`, async ({ page }) => {
    await page.route('**/api/connectors/cloudwatch_logs/log-groups*', (route) =>
      route.fulfill({ json: { data: [{ name: API }], meta: { next_cursor: null } } }),
    );
    await page.route('**/api/connectors/cloudwatch_logs/connect', (route) =>
      route.fulfill(error(status, code, message)),
    );
    const { pane } = await openPane(page, cloudwatch(), 'Connect');
    await fillIdentity(pane);
    await pane.getByRole('button', { name: 'Find log groups' }).click();
    await pane.getByRole('checkbox', { name: API }).check();
    await pane.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(pane.getByRole('alert')).toHaveText(message);
    await expect(pane.getByText('○ not connected')).toBeVisible();
  });
}

test('the picker shows loading, then an empty answer, then the daemon reason when it fails', async ({ page }) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let answers = 0;
  await page.route('**/api/connectors/cloudwatch_logs/log-groups*', async (route) => {
    answers++;
    if (answers === 1) {
      await gate;
      return route.fulfill({ json: { data: [], meta: { next_cursor: null } } });
    }
    return route.fulfill(error(502, 'upstream_failed', 'AWS profile shop-ro is signed out'));
  });
  const { pane } = await openPane(page, cloudwatch(), 'Connect');
  await fillIdentity(pane);
  const find = pane.getByRole('button', { name: 'Find log groups' });
  await find.click();
  await expect(pane.getByText('Reading log groups…')).toBeVisible();
  await expect(find).toBeDisabled();
  release();
  await expect(pane.getByText('shop-ro sees no log groups in us-east-1.')).toBeVisible();

  await pane.getByRole('textbox', { name: 'Region' }).fill('eu-west-1');
  await find.click();
  await expect(pane.getByRole('alert')).toHaveText('AWS profile shop-ro is signed out');
  await expect(pane.getByRole('list', { name: 'Log groups' })).toHaveCount(0);
});

test('signing in shows Waiting and Cancel, and Cancel stops the sign-in', async ({ page }) => {
  const connector = cloudwatch({
    sign_in: { code: null, url: 'https://sso.example.com/authorize' },
    config: { profile: 'shop-ro', region: 'us-east-1', log_groups: [{ name: API, service: 'api', env: 'prod' }] },
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

test('a profile that needs auth shows the command to run on the pane and Sign in on the row', async ({ page }) => {
  const detail = 'AWS profile shop-ro is signed out. Run `aws login --profile shop-ro`, then Connect again.';
  const { main, pane } = await openPane(
    page,
    cloudwatch({
      status: 'auth',
      status_detail: detail,
      config: { profile: 'shop-ro', region: 'us-east-1', log_groups: [{ name: API, service: 'api', env: 'prod' }] },
    }),
    'Sign in',
  );
  await expect(pane.getByRole('alert')).toHaveText(detail);
  await expect(pane.getByRole('textbox', { name: 'AWS profile' })).toHaveValue('shop-ro');
  await expect(pane.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
  await expect(main.getByRole('listitem', { name: 'CloudWatch logs' })).toContainText('needs auth');
});

test('a Connector that is down shows the reason on the pane and failed on the row', async ({ page }) => {
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
  await expect(pane.getByRole('alert')).toHaveText(detail);
  await expect(main.getByRole('listitem', { name: 'CloudWatch logs' })).toContainText('✕ failed');
});

test('a Connector being checked shows checking and cannot be connected again', async ({ page }) => {
  const { pane } = await openPane(
    page,
    cloudwatch({
      status: 'checking',
      config: { profile: 'shop-ro', region: 'us-east-1', log_groups: [{ name: API, service: 'api', env: 'prod' }] },
    }),
    'Manage',
  );
  await expect(pane.getByText('◌ checking')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Reconnect', exact: true })).toBeDisabled();
});

test('disconnecting CloudWatch logs says the AWS profile and account stay', async ({ page }) => {
  const connector = cloudwatch({
    status: 'ok',
    account_label: 'shop-ro',
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
