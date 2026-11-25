import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const list = (data: unknown[]) => ({ json: { data, meta: { next_cursor: null } } });

/** Opens the Services menu in the toolbar. */
const openServices = (page: Page) =>
  page.getByRole('button', { name: /^\d+ Services/, description: /^The Services in / }).click();

const NAMES = ['api-analytics', 'api-nxt', 'apis', 'cron-nxt', 'forwarder', 'js-sdk', 'push-nxt', 'webhook', 'zeta'];

const alertOf = (id: string, severity: string, path: string, extra: Record<string, unknown> = {}) => ({
  id,
  route: { id: `r-${id}`, method: 'POST', path },
  service: { id: 'sv1', name: 'apis', env: 'prod', repo_id: null, repo_url: null },
  connector: 'datadog',
  fingerprint: id,
  http_status: 500,
  source: 'scan',
  severity,
  status: 'open',
  title: `Failure on ${path}`,
  log_line: `status=500 path=${path}`,
  event_count: 12,
  first_seen_at: ago(30),
  last_seen_at: ago(1),
  resolved_at: null,
  regression_count: 0,
  waiting_since: null,
  source_query: 'service:apis',
  session_id: null,
  last_scanned_at: ago(1),
  scan_overdue: false,
  awaiting_prod_check: false,
  ...extra,
});

async function routeMonitor(page: Page) {
  const datadog = {
    id: 'datadog',
    name: 'Datadog',
    via: 'pup',
    status: 'ok',
    status_detail: null,
    account_label: null,
    login: null,
    config: {},
    last_checked_at: ago(1),
    sign_in: null,
    pick: null,
  };
  await page.route('**/api/connectors', (route) => route.fulfill(list([datadog])));
  await page.route('**/api/services', (route) => route.fulfill(list([])));
  await page.route(/\/api\/scans(\?.*)?$/, (route) =>
    route.fulfill(
      list([
        {
          id: 's1',
          connector: 'datadog',
          triggered_by: 'operator',
          service_id: null,
          window_size: '1h',
          envs: ['prod'],
          services: NAMES,
          status_codes: [],
          status: 'ok',
          error_code: null,
          error_message: null,
          notes: [],
          started_at: ago(0.3),
          finished_at: ago(0.2),
        },
      ]),
    ),
  );
  await page.route(/\/api\/alerts(\?.*)?$/, (route) =>
    route.fulfill(
      list([
        alertOf('a1', 'low', '/v1/low'),
        alertOf('a2', 'high', '/v1/orders'),
        alertOf('a3', 'medium', '/v1/notify'),
        alertOf('a4', 'high', '/v1/events', { status: 'verified' }),
      ]),
    ),
  );
  await page.route(/\/api\/monitor\/log-services/, (route) =>
    route.fulfill(list(NAMES.map((name, index) => ({ name, envs: ['prod'], errors: (index + 1) * 100 })))),
  );
  await page.route(/\/api\/monitor\/status-codes/, (route) =>
    route.fulfill(
      list([
        { code: 400, count: 10 },
        { code: 500, count: 20 },
      ]),
    ),
  );
}

test('Services show tick boxes on hover, count ticks above the list, and Scan reads only the ticked', async ({
  page,
}) => {
  await routeMonitor(page);
  const started = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/scans'));
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await expect(page.getByRole('button', { name: /^Scan 9 Services · 1h|^Scan 9 Services · 24h/ })).toBeVisible();
  await openServices(page);
  const services = page.getByRole('list', { name: 'Services' });
  await expect(services.getByRole('listitem')).toHaveCount(NAMES.length);
  await expect(page.getByText('Tick Services to Scan')).toBeVisible();

  // Hidden until hover, and no "Untick" line under the button.
  const box = page.getByRole('checkbox', { name: 'Scan apis' });
  await expect(box).toHaveCSS('opacity', '0');
  await services.getByRole('listitem').filter({ hasText: /^apis/ }).hover();
  await expect(box).toHaveCSS('opacity', '1');

  await box.check();
  await page.getByRole('checkbox', { name: 'Scan webhook' }).check();
  await expect(page.locator('strong', { hasText: '2 ticked' })).toBeVisible();
  await expect(page.getByText(/Untick/)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Scan 2 ticked/ })).toBeVisible();

  await page.getByRole('button', { name: /^Scan 2 ticked/ }).click();
  expect((await started).postDataJSON().services).toEqual(['apis', 'webhook']);

  await openServices(page);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByText('Tick Services to Scan')).toBeVisible();
  await page.getByRole('button', { name: 'Tick all' }).click();
  await expect(page.locator('strong', { hasText: `${NAMES.length} ticked` })).toBeVisible();
});

test('the last Scan is one line with no Service list to open', async ({ page }) => {
  await routeMonitor(page);
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await expect(page.getByText(/^Last Scan \d+m ago$/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Services', description: 'What the last Scan read' })).toHaveCount(0);
});

test('logs list as a table titled by Route, Low ones wait behind a row, and a tier tab shows one tier', async ({
  page,
}) => {
  await routeMonitor(page);
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  const logs = page.getByRole('table', { name: 'Logs' });
  const routes = logs.getByRole('button', { name: /\/v1\// });
  // Needs attention is the default: High and Medium, with the Low one behind a row.
  await expect(page.getByRole('tab', { name: /^Needs attention/ })).toHaveAttribute('aria-selected', 'true');
  await expect(routes).toHaveCount(3);
  await expect(logs.getByRole('button', { name: /\/v1\/low/ })).toHaveCount(0);
  await expect(logs.getByRole('button', { name: /\/v1\/orders/ })).toBeVisible();
  // Open stays unlabelled; a verified Alert says so.
  await expect(logs.getByRole('button', { name: /\/v1\/events.*verified/ })).toBeVisible();

  await page.getByRole('tab', { name: /^All \d/ }).click();
  await expect(routes).toHaveCount(4);
  await page.getByRole('tab', { name: /^High/ }).click();
  await expect(routes).toHaveCount(2);

  await page.getByRole('tab', { name: /^Needs attention/ }).click();
  await logs.getByRole('button', { name: /^Show 1 Low alert/ }).click();
  await expect(routes).toHaveCount(1);
  await expect(logs.getByRole('button', { name: /\/v1\/low/ })).toBeVisible();
});

test('a pull request row says how long ago it opened, and a Session row how long since it was active', async ({
  page,
}) => {
  const repo = {
    id: 'r1',
    name: 'apis',
    path: '/work/apis',
    host: 'github',
    remote_slug: 'example/apis',
    origin_slug: null,
    default_branch: 'main',
    created_at: ago(500),
    branch: 'main',
    dirty: false,
    missing: false,
    session_count: 1,
  };
  const opened = '2026-02-05T14:14:00.000Z';
  const started = new Date(Date.now() - 3 * HOUR).toISOString();
  await page.route('**/api/repos', (route) => route.fulfill(list([repo])));
  await page.route('**/api/repos/*/branches', (route) =>
    route.fulfill({ json: { data: [{ name: 'main', current: true, has_open_pr: false }] } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill(
      list([
        {
          id: 'ss1',
          kind: 'repo',
          title: 'Fix empty cart',
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
          created_at: started,
          last_active_at: started,
          playbook: null,
          queued_message: null,
          spawned_by: null,
          spawned: [],
          subagents: [],
        },
      ]),
    ),
  );
  await page.route(/\/api\/sessions\?kind=anonymous/, (route) => route.fulfill(list([])));
  await page.route(/\/api\/pull-requests/, (route) =>
    route.fulfill({
      json: {
        data: [
          {
            repo_id: 'r1',
            host: 'github',
            slug: 'example/apis',
            number: 412,
            url: 'https://example.com/pull/412',
            title: 'Fix empty cart',
            author: 'ananth',
            branch: 'fix/cart',
            base_branch: 'main',
            head_sha: 'abc',
            state: 'open',
            review_state: 'none',
            approved_by: [],
            checks: 'passed',
            additions: 1,
            deletions: 1,
            body: '',
            opened_at: opened,
            merged_at: null,
            is_mine: true,
            by_agent: false,
            comment_count: 0,
            resolved_count: 0,
            agent_session_id: null,
            latest_agent_review: null,
          },
        ],
        meta: { synced_at: ago(0.1), stale: false, next_cursor: null },
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?tab=pulls#token=${daemon.token}`);
  // The full date is in the tooltip.
  await expect(page.getByTitle(/^Opened .*2026/)).toHaveText(/\dd ago$/);
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);
  await expect(page.getByTitle(/^Started .*, last active /)).toHaveText('3h');
});

test('a running Scan shows Scanning… with a Stop button that cancels it', async ({ page }) => {
  await routeMonitor(page);
  await page.route(/\/api\/scans(\?.*)?$/, (route) =>
    route.fulfill(
      list([
        {
          id: 's9',
          connector: 'datadog',
          triggered_by: 'operator',
          service_id: null,
          window_size: '1h',
          envs: ['prod'],
          services: NAMES,
          status_codes: [],
          status: 'running',
          error_code: null,
          error_message: null,
          notes: [],
          started_at: ago(0.1),
          finished_at: null,
        },
      ]),
    ),
  );
  const cancelled = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/scans/s9/cancel'),
  );
  await page.route('**/api/scans/s9/cancel', (route) => route.fulfill({ status: 204 }));
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);

  await expect(page.getByRole('button', { name: 'Scanning…' })).toBeDisabled();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await cancelled;
});

// Log sources: Datadog (service apis), OpenTelemetry logs (service api), CloudWatch logs (service shop-api), Loki logs (service cart) and New Relic logs (service basket).
const connectorOf = (id: string, name: string, status: string, detail: string | null = null) => ({
  id,
  name,
  via:
    {
      otel_logs: 'a local folder',
      cloudwatch_logs: 'aws CLI + CloudWatch MCP',
      loki_logs: 'Grafana Cloud MCP',
      new_relic_logs: 'New Relic MCP',
    }[id] ?? 'pup',
  status,
  status_detail: detail,
  account_label: null,
  login: null,
  config: {},
  last_checked_at: ago(1),
  sign_in: null,
  pick: null,
});

const OTEL_SERVICE = { id: 'sv2', name: 'api', env: 'prod', repo_id: null, repo_url: null };
const OTEL_FILTER = { service: 'api', env: 'prod', status: 500, method: 'POST', path: '/orders' };
const CLOUDWATCH_SERVICE = { id: 'sv3', name: 'shop-api', env: 'prod', repo_id: null, repo_url: null };
const LOKI_SERVICE = { id: 'sv4', name: 'cart', env: 'prod', repo_id: null, repo_url: null };
const NEW_RELIC_SERVICE = { id: 'sv5', name: 'basket', env: 'prod', repo_id: null, repo_url: null };
const DATADOG_ALERT = alertOf('a1', 'high', '/v1/orders');
const LOKI_ALERT = alertOf('l1', 'high', '/cart', {
  connector: 'loki_logs',
  service: LOKI_SERVICE,
  source_query: JSON.stringify({ service: 'cart', env: 'prod', status: 503, method: 'POST', path: '/cart' }),
});
const NEW_RELIC_ALERT = alertOf('n1', 'high', '/basket', {
  connector: 'new_relic_logs',
  service: NEW_RELIC_SERVICE,
  source_query: JSON.stringify({ service: 'basket', env: 'prod', status: 504, method: 'PUT', path: '/basket' }),
});
const CLOUDWATCH_ALERT = alertOf('c1', 'high', '/checkout', {
  connector: 'cloudwatch_logs',
  service: CLOUDWATCH_SERVICE,
  source_query: JSON.stringify({ log_group: '/ecs/shop-api', status: 502, method: 'POST', path: '/checkout' }),
});
const OTEL_ALERT = alertOf('o1', 'high', '/orders', {
  connector: 'otel_logs',
  service: OTEL_SERVICE,
  source_query: JSON.stringify(OTEL_FILTER),
});

const scanOf = (connector: string, notes: string[] = []) => ({
  id: `scan-${connector}`,
  connector,
  triggered_by: 'operator',
  service_id: null,
  window_size: '24h',
  envs: ['prod'],
  services: null,
  status_codes: [],
  status: 'ok',
  error_code: null,
  error_message: null,
  notes,
  started_at: ago(0.3),
  finished_at: ago(0.2),
});

type Sources = {
  datadog?: [string, string | null];
  otel?: [string, string | null];
  /** CloudWatch logs adds its Connector, its Alert and its Service only when given. */
  cloudwatch?: [string, string | null];
  /** Loki logs adds its Connector, its Alert and its Service only when given. */
  loki?: [string, string | null];
  /** New Relic logs adds its Connector, its Alert and its Service only when given. */
  newRelic?: [string, string | null];
  scans?: unknown[];
};

async function routeSources(
  page: Page,
  { datadog = ['ok', null], otel = ['ok', null], cloudwatch, loki, newRelic, scans = [] }: Sources = {},
) {
  const read = { datadog: 0 };
  const alerts = [
    DATADOG_ALERT,
    OTEL_ALERT,
    ...(cloudwatch ? [CLOUDWATCH_ALERT] : []),
    ...(loki ? [LOKI_ALERT] : []),
    ...(newRelic ? [NEW_RELIC_ALERT] : []),
  ];
  await page.route('**/api/connectors', (route) =>
    route.fulfill(
      list([
        connectorOf('datadog', 'Datadog', ...datadog),
        connectorOf('otel_logs', 'OpenTelemetry logs', ...otel),
        ...(cloudwatch ? [connectorOf('cloudwatch_logs', 'CloudWatch logs', ...cloudwatch)] : []),
        ...(loki ? [connectorOf('loki_logs', 'Loki logs', ...loki)] : []),
        ...(newRelic ? [connectorOf('new_relic_logs', 'New Relic logs', ...newRelic)] : []),
      ]),
    ),
  );
  await page.route('**/api/services', (route) => route.fulfill(list([])));
  await page.route(/\/api\/scans(\?.*)?$/, (route) => route.fulfill(list(scans)));
  await page.route(/\/api\/alerts(\?.*)?$/, (route) => route.fulfill(list(alerts)));
  for (const alert of alerts) {
    await page.route(`**/api/alerts/${alert.id}`, (route) =>
      route.fulfill({ json: { data: { ...alert, samples: [], latest_report: null, review: null, fix: null } } }),
    );
    await page.route(`**/api/alerts/${alert.id}/events`, (route) => route.fulfill(list([])));
    await page.route(`**/api/alerts/${alert.id}/reports`, (route) => route.fulfill(list([])));
  }
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/monitor\/log-services/, (route) => {
    const connector = new URL(route.request().url()).searchParams.get('connector');
    if (connector === 'datadog') read.datadog++;
    const name =
      { otel_logs: 'api', cloudwatch_logs: 'shop-api', loki_logs: 'cart', new_relic_logs: 'basket' }[connector ?? ''] ??
      'apis';
    return route.fulfill(list([{ name, envs: ['prod'], errors: 120 }]));
  });
  await page.route(/\/api\/monitor\/status-codes/, (route) => route.fulfill(list([{ code: 500, count: 20 }])));
  return read;
}

/** The one status line under the title, and its button when a source has detail to open. */
const statusLine = (page: Page) => page.getByRole('status').filter({ hasText: /Scan|down/ });
const scanDetails = (page: Page) => page.getByRole('region', { name: 'Scan details' });

test('each Alert and Service names its source, and the source filter keeps one source and survives a reload', async ({
  page,
}) => {
  await routeSources(page);
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  const logs = page.getByRole('table', { name: 'Logs' });
  const services = page.getByRole('list', { name: 'Services' });
  await expect(logs.getByRole('row').filter({ hasText: /\/v1\/orders/ })).toContainText('Datadog');
  await expect(logs.getByRole('row').filter({ hasText: /POST\/orders/ })).toContainText('OpenTelemetry');
  await openServices(page);
  await expect(services.getByRole('button', { name: 'Datadog, 1 Service' })).toBeVisible();
  await expect(services.getByRole('button', { name: 'OpenTelemetry, 1 Service' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'OpenTelemetry' }).click();
  await expect(logs.getByRole('button')).toHaveCount(1);
  await expect(logs.getByRole('button')).toContainText('/orders');
  await openServices(page);
  await expect(services.getByRole('listitem')).toHaveCount(1);
  await expect(services.getByRole('button', { name: 'OpenTelemetry, 1 Service' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(page.getByRole('tab', { name: 'OpenTelemetry' })).toHaveAttribute('aria-selected', 'true');
  await expect(logs.getByRole('button')).toHaveCount(1);
  await page.getByRole('tab', { name: 'All sources' }).click();
  await expect(logs.getByRole('button')).toHaveCount(2);
});

test('Services list under their source, and a source folds and opens from its arrow', async ({ page }) => {
  await routeSources(page);
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await openServices(page);
  const services = page.getByRole('list', { name: 'Services' });
  await expect(services.getByRole('listitem')).toHaveCount(2);
  const datadog = services.getByRole('button', { name: 'Datadog, 1 Service' });
  await expect(datadog).toHaveAttribute('aria-expanded', 'true');
  await datadog.click();
  await expect(datadog).toHaveAttribute('aria-expanded', 'false');
  await expect(services.getByRole('listitem')).toHaveCount(1);
  await datadog.click();
  await expect(services.getByRole('listitem')).toHaveCount(2);
});

test('the HTTP status codes group by class, and a class folds and opens from its arrow', async ({ page }) => {
  await routeMonitor(page);
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await page.getByRole('button', { name: 'Status', exact: true }).click();
  const codes = page.getByRole('group', { name: 'HTTP status codes to read' });
  await expect(codes.getByText('Bad Request')).toBeVisible();
  await codes.getByRole('button', { name: /^Hide 4xx/ }).click();
  await expect(codes.getByText('Bad Request')).toHaveCount(0);
  await expect(codes.getByText('Internal Server Error')).toBeVisible();
  await codes.getByRole('button', { name: /^Show 4xx/ }).click();
  await expect(codes.getByText('Bad Request')).toBeVisible();
});

test('a source that is down shows a notice naming it, and the other source keeps its Alerts', async ({ page }) => {
  await routeSources(page, { otel: ['fail', 'Folder not found'] });
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await expect(statusLine(page)).toContainText('OpenTelemetry is down');
  await statusLine(page).getByRole('button').click();
  await expect(scanDetails(page)).toContainText('OpenTelemetry is down: Folder not found');
  await expect(page.getByRole('table', { name: 'Logs' }).getByRole('button', { name: /\/v1\/orders/ })).toBeVisible();
});

test('no notice shows while both sources are connected', async ({ page }) => {
  await routeSources(page);
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await expect(page.getByRole('table', { name: 'Logs' }).getByRole('button')).toHaveCount(2);
  await expect(page.getByText('is down')).toHaveCount(0);
  await expect(statusLine(page).getByRole('button')).toHaveCount(0);
});

test('a Scan that skipped lines or hit the read cap lists its notes in the status line details', async ({ page }) => {
  await routeSources(page, {
    scans: [
      scanOf('otel_logs', ['Read the newest 100 MB only', '3 lines were not log records and were skipped']),
      scanOf('datadog'),
    ],
  });
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await expect(statusLine(page)).toContainText('OpenTelemetry left notes');
  await statusLine(page).getByRole('button').click();
  await expect(scanDetails(page).getByRole('list', { name: 'OpenTelemetry notes' }).getByRole('listitem')).toHaveText([
    'Read the newest 100 MB only',
    '3 lines were not log records and were skipped',
  ]);
  await expect(scanDetails(page)).not.toContainText('Datadog');
  await expect(page.getByRole('tab', { name: 'OpenTelemetry' })).toContainText('Last Scan');
});

const ALL_FIVE = { cloudwatch: ['ok', null], loki: ['ok', null], newRelic: ['ok', null] } satisfies Sources;

/** The header's box and the Alerts table's top, to see how much room the status takes. */
async function headerBoxes(page: Page) {
  const header = await page
    .locator('header', { has: page.getByRole('heading', { name: 'Monitor', level: 2 }) })
    .boundingBox();
  const table = await page.getByRole('table', { name: 'Logs' }).boundingBox();
  const status = await page.getByRole('status').filter({ hasText: /Scan/ }).boundingBox();
  const scan = await page.getByRole('button', { name: /^Scan \d+ Services/ }).boundingBox();
  const title = await page.getByRole('heading', { name: 'Monitor', level: 2 }).boundingBox();
  if (!header || !table || !status || !scan || !title) throw new Error('The Monitor header did not render');
  return { header, table, status, scan, title };
}

test('five sources that all scanned fine read as one short line on the title row', async ({ page }) => {
  await routeSources(page, {
    ...ALL_FIVE,
    scans: ['datadog', 'otel_logs', 'cloudwatch_logs', 'loki_logs', 'new_relic_logs'].map((id) => scanOf(id)),
  });
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  const line = statusLine(page);
  await expect(line).toHaveText(/^All 5 sources scanned · last Scan \d+m ago$/);
  // Nothing to open, and no line per source.
  await expect(line.getByRole('button')).toHaveCount(0);
  await expect(page.getByText(/^(Datadog|OpenTelemetry|CloudWatch|Loki|New Relic) · Last Scan/)).toHaveCount(0);
  const { header, table, status, scan, title } = await headerBoxes(page);
  expect(header.height).toBeLessThan(90);
  expect(status.height).toBeLessThan(24);
  // Title, status and Scan button share one row.
  expect(Math.abs(status.y - title.y)).toBeLessThan(30);
  expect(Math.abs(scan.y - title.y)).toBeLessThan(30);
  // Title row, source tabs and toolbar sit above the table.
  expect(table.y).toBeLessThan(330);
});

test('a source with notes keeps the status to one line and opens its notes with one click, without moving the table', async ({
  page,
}) => {
  await routeSources(page, {
    ...ALL_FIVE,
    scans: [
      scanOf('datadog'),
      scanOf('otel_logs'),
      scanOf('cloudwatch_logs'),
      scanOf('loki_logs', ['Loki logs: no Services found under the label service_name']),
      scanOf('new_relic_logs', ['New Relic logs: no Services found under the attribute service.name']),
    ],
  });
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  const line = statusLine(page);
  await expect(line).toContainText('All 5 sources scanned');
  await expect(line).toContainText('Loki and New Relic left notes');
  const before = await headerBoxes(page);
  expect(before.header.height).toBeLessThan(90);
  expect(before.status.height).toBeLessThan(24);
  expect(before.table.y).toBeLessThan(330);
  // The notes are not lines in the page; the Loki and New Relic cards carry a mark instead.
  await expect(page.getByText('no Services found under the label service_name')).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Loki' }).locator('[title*="no Services found"]')).toHaveCount(1);

  await line.getByRole('button').click();
  await expect(scanDetails(page).getByRole('list', { name: 'Loki notes' }).getByRole('listitem')).toHaveText([
    'Loki logs: no Services found under the label service_name',
  ]);
  await expect(scanDetails(page).getByRole('list', { name: 'New Relic notes' }).getByRole('listitem')).toHaveText([
    'New Relic logs: no Services found under the attribute service.name',
  ]);
  const open = await headerBoxes(page);
  expect(open.table.y).toBe(before.table.y);
  await page.keyboard.press('Escape');
  await expect(scanDetails(page)).toHaveCount(0);
});

test('a failed Scan stays in the status line in colour, with the reason one click away', async ({ page }) => {
  await routeSources(page, {
    scans: [
      { ...scanOf('datadog'), status: 'failed', error_code: 'upstream', error_message: 'No' },
      scanOf('otel_logs'),
    ],
  });
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  const line = statusLine(page);
  await expect(line).toContainText('1 of 2 sources scanned');
  const failed = line.getByText('Scan failed for Datadog');
  await expect(failed).toBeVisible();
  await expect(failed).toHaveCSS('font-weight', '600');
  await line.getByRole('button').click();
  await expect(scanDetails(page)).toContainText('The last Scan could not read Datadog. No good Scan yet.');
  await expect(page.getByRole('tab', { name: 'Datadog' })).toContainText('Last Scan failed');
});

test('Scan works with only OpenTelemetry connected and asks no Datadog read', async ({ page }) => {
  const read = await routeSources(page, { datadog: ['off', null] });
  const started = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/scans'));
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  const scan = page.getByRole('button', { name: /^Scan 1 Services/ });
  await expect(scan).toBeEnabled();
  await expect(scan).toHaveAttribute('title', /OpenTelemetry logs/);
  await scan.click();
  expect((await started).postDataJSON().connector).toBeUndefined();
  expect(read.datadog).toBe(0);
});

test('Scan reads every connected source, or only the one the source filter picks', async ({ page }) => {
  await routeSources(page);
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  const scan = page.getByRole('button', { name: /^Scan 2 Services/ });
  let started = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/scans'));
  await scan.click();
  expect((await started).postDataJSON().connector).toBeUndefined();

  await page.getByRole('tab', { name: 'OpenTelemetry' }).click();
  started = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/scans'));
  await page.getByRole('button', { name: /^Scan 1 Services/ }).click();
  expect((await started).postDataJSON().connector).toBe('otel_logs');
});

test('an OpenTelemetry Alert shows its filter as a line and never names Datadog; a Datadog Alert shows its query', async ({
  page,
}) => {
  await routeSources(page);
  await page.goto(`${daemon.url}/monitor?alert=o1#token=${daemon.token}`);
  const detail = page.locator('article');
  await page.getByRole('tab', { name: 'Query' }).click();
  await expect(detail).toContainText('OpenTelemetry');
  await expect(detail).toContainText('service api, env prod, 500 POST /orders');
  await expect(detail).not.toContainText('Datadog');
  await expect(detail.locator('[title*="Datadog"]')).toHaveCount(0);

  await page.goto(`${daemon.url}/monitor?alert=a1#token=${daemon.token}`);
  await page.getByRole('tab', { name: 'Query' }).click();
  await expect(detail).toContainText('service:apis');
  await expect(detail).toContainText('Datadog');
});

test('five sources share one list, and the source filter offers all five and keeps one', async ({ page }) => {
  await routeSources(page, { cloudwatch: ['ok', null], loki: ['ok', null], newRelic: ['ok', null] });
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  const logs = page.getByRole('table', { name: 'Logs' });
  const services = page.getByRole('list', { name: 'Services' });
  await expect(logs.getByRole('button')).toHaveCount(5);
  await expect(logs.getByRole('row').filter({ hasText: /POST\/checkout/ })).toContainText('CloudWatch');
  await expect(logs.getByRole('row').filter({ hasText: /POST\/cart/ })).toContainText('Loki');
  await expect(logs.getByRole('row').filter({ hasText: /POST\/basket/ })).toContainText('New Relic');
  await openServices(page);
  await expect(services.getByRole('button', { name: 'CloudWatch, 1 Service' })).toBeVisible();
  await expect(services.getByRole('button', { name: 'Loki, 1 Service' })).toBeVisible();
  await expect(services.getByRole('button', { name: 'New Relic, 1 Service' })).toBeVisible();
  await page.keyboard.press('Escape');
  const tabs = page.getByRole('tablist', { name: 'Source' }).getByRole('tab');
  await expect(tabs).toHaveCount(6);
  for (const name of ['All sources', 'Datadog', 'OpenTelemetry', 'CloudWatch', 'Loki', 'New Relic']) {
    await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
  }

  for (const [tab, path] of [
    ['CloudWatch', '/checkout'],
    ['Loki', '/cart'],
    ['New Relic', '/basket'],
  ] as const) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(logs.getByRole('button')).toHaveCount(1);
    await expect(logs.getByRole('button')).toContainText(path);
    await openServices(page);
    await expect(services.getByRole('listitem')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Scan 1 Services/ })).toHaveAttribute(
      'title',
      new RegExp(`${tab} logs`),
    );
  }
});

test('a down New Relic source shows a notice naming it, and the other sources keep their Alerts', async ({ page }) => {
  await routeSources(page, {
    newRelic: [
      'auth',
      'New Relic refused the key. Check the key, and that a key belongs to one region: choose the region of the account.',
    ],
  });
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await expect(statusLine(page)).toContainText('New Relic is down');
  await expect(statusLine(page)).not.toContainText('OpenTelemetry is down');
  await statusLine(page).getByRole('button').click();
  await expect(scanDetails(page)).toContainText('New Relic is down: New Relic refused the key.');
  await expect(scanDetails(page)).toContainText('Scans skip it');
  const logs = page.getByRole('table', { name: 'Logs' });
  await expect(logs.getByRole('button', { name: /\/v1\/orders/ })).toBeVisible();
  await expect(logs.getByRole('button', { name: /POST \/orders/ })).toBeVisible();
});

test('a New Relic Alert shows its filter as a line and never names Datadog', async ({ page }) => {
  await routeSources(page, { newRelic: ['ok', null] });
  await page.goto(`${daemon.url}/monitor?alert=n1#token=${daemon.token}`);
  const detail = page.locator('article');
  await page.getByRole('tab', { name: 'Query' }).click();
  await expect(detail).toContainText('New Relic');
  await expect(detail).toContainText('service basket, env prod, 504 PUT /basket');
  await expect(detail).not.toContainText('Datadog');
  await expect(detail.locator('[title*="Datadog"], [title*="Log folder"]')).toHaveCount(0);
});

test('a down Loki source shows a notice naming it, and the other sources keep their Alerts', async ({ page }) => {
  await routeSources(page, {
    loki: ['fail', 'Could not reach Grafana: connection refused'],
  });
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await expect(statusLine(page)).toContainText('Loki is down');
  await expect(statusLine(page)).not.toContainText('OpenTelemetry is down');
  await statusLine(page).getByRole('button').click();
  await expect(scanDetails(page)).toContainText('Loki is down: Could not reach Grafana: connection refused.');
  await expect(scanDetails(page)).toContainText('Scans skip it');
  const logs = page.getByRole('table', { name: 'Logs' });
  await expect(logs.getByRole('button', { name: /\/v1\/orders/ })).toBeVisible();
  await expect(logs.getByRole('button', { name: /POST \/orders/ })).toBeVisible();
});

test('a Loki Scan shows its notes, and a Loki Alert shows its filter as a line and never names Datadog', async ({
  page,
}) => {
  await routeSources(page, {
    loki: ['ok', null],
    scans: [
      scanOf('loki_logs', ['cart has more than 5,000 failing lines; its counts come from the newest 5,000']),
      scanOf('datadog'),
    ],
  });
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await statusLine(page).getByRole('button').click();
  await expect(scanDetails(page).getByRole('list', { name: 'Loki notes' }).getByRole('listitem')).toHaveText([
    'cart has more than 5,000 failing lines; its counts come from the newest 5,000',
  ]);
  await page.goto(`${daemon.url}/monitor?alert=l1#token=${daemon.token}`);
  const detail = page.locator('article');
  await page.getByRole('tab', { name: 'Query' }).click();
  await expect(detail).toContainText('Loki');
  await expect(detail).toContainText('service cart, env prod, 503 POST /cart');
  await expect(detail).not.toContainText('Datadog');
  await expect(detail.locator('[title*="Datadog"], [title*="Log folder"]')).toHaveCount(0);
});

test('a down CloudWatch source shows a notice naming it, and the other sources keep their Alerts', async ({ page }) => {
  await routeSources(page, {
    cloudwatch: ['auth', 'AWS profile shop-ro is signed out. Run `aws login --profile shop-ro`, then Connect again.'],
  });
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await expect(statusLine(page)).toContainText('CloudWatch is down');
  await expect(statusLine(page)).not.toContainText('OpenTelemetry is down');
  await statusLine(page).getByRole('button').click();
  await expect(scanDetails(page)).toContainText('CloudWatch is down: AWS profile shop-ro is signed out.');
  await expect(scanDetails(page)).toContainText('then Connect again. Scans skip it');
  const logs = page.getByRole('table', { name: 'Logs' });
  await expect(logs.getByRole('button', { name: /\/v1\/orders/ })).toBeVisible();
  await expect(logs.getByRole('button', { name: /POST \/orders/ })).toBeVisible();
});

test('a CloudWatch Scan lists the bytes it scanned and the groups it left unread', async ({ page }) => {
  await routeSources(page, {
    cloudwatch: ['ok', null],
    scans: [
      scanOf('cloudwatch_logs', [
        'Logs Insights scanned 1.2 GB',
        '/ecs/shop-api was not read: the query took over 5 minutes',
      ]),
      scanOf('datadog'),
    ],
  });
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await statusLine(page).getByRole('button').click();
  await expect(scanDetails(page).getByRole('list', { name: 'CloudWatch notes' }).getByRole('listitem')).toHaveText([
    'Logs Insights scanned 1.2 GB',
    '/ecs/shop-api was not read: the query took over 5 minutes',
  ]);
});

test('a CloudWatch Alert shows its filter as a line and never names Datadog or the Log folder', async ({ page }) => {
  await routeSources(page, { cloudwatch: ['ok', null] });
  await page.goto(`${daemon.url}/monitor?alert=c1#token=${daemon.token}`);
  const detail = page.locator('article');
  await page.getByRole('tab', { name: 'Query' }).click();
  await expect(detail).toContainText('CloudWatch');
  await expect(detail).toContainText('log group /ecs/shop-api, 502 POST /checkout');
  await expect(detail).not.toContainText('Datadog');
  await expect(detail.locator('[title*="Datadog"], [title*="Log folder"]')).toHaveCount(0);
});
