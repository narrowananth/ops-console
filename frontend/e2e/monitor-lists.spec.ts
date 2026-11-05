import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const list = (data: unknown[]) => ({ json: { data, meta: { next_cursor: null } } });

const NAMES = ['api-analytics', 'api-nxt', 'apis', 'cron-nxt', 'forwarder', 'js-sdk', 'push-nxt', 'webhook', 'zeta'];

const alertOf = (id: string, severity: string, path: string, extra: Record<string, unknown> = {}) => ({
  id,
  route: { id: `r-${id}`, method: 'POST', path },
  service: { id: 'sv1', name: 'apis', env: 'prod', repo_id: null, repo_url: null },
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
  datadog_query: 'service:apis',
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
  };
  await page.route('**/api/connectors', (route) => route.fulfill(list([datadog])));
  await page.route('**/api/services', (route) => route.fulfill(list([])));
  await page.route(/\/api\/scans(\?.*)?$/, (route) =>
    route.fulfill(
      list([
        {
          id: 's1',
          triggered_by: 'operator',
          service_id: null,
          window_size: '1h',
          envs: ['prod'],
          services: NAMES,
          status_codes: [],
          status: 'ok',
          error_code: null,
          error_message: null,
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
  await page.route(/\/api\/monitor\/datadog-services/, (route) =>
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
  const services = page.getByRole('list', { name: 'Services' });
  await expect(services.getByRole('listitem')).toHaveCount(NAMES.length);
  await expect(page.getByText('Tick Services to Scan')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Scan 9 Services · 1h|^Scan 9 Services · 24h/ })).toBeVisible();

  // Hidden until hover, and no "Untick" line under the button.
  const box = page.getByRole('checkbox', { name: 'Scan apis' });
  await expect(box).toHaveCSS('opacity', '0');
  await services.getByRole('listitem').filter({ hasText: /^apis/ }).hover();
  await expect(box).toHaveCSS('opacity', '1');

  await box.check();
  await page.getByRole('checkbox', { name: 'Scan webhook' }).check();
  await expect(page.locator('strong', { hasText: '2 ticked' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Scan 2 ticked/ })).toBeVisible();
  await expect(page.getByText(/Untick/)).toHaveCount(0);

  await page.getByRole('button', { name: /^Scan 2 ticked/ }).click();
  expect((await started).postDataJSON().services).toEqual(['apis', 'webhook']);

  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByText('Tick Services to Scan')).toBeVisible();
  await page.getByRole('button', { name: 'Tick all' }).click();
  await expect(page.locator('strong', { hasText: `${NAMES.length} ticked` })).toBeVisible();
});

test('the last Scan is one line, and its Services show only when opened', async ({ page }) => {
  await routeMonitor(page);
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  await expect(page.getByText(/^Last Scan \d+m ago$/)).toBeVisible();
  // The names are not printed until the line is opened.
  await expect(page.getByRole('listitem').filter({ hasText: /^forwarder$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Services', description: 'What the last Scan read' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: /^forwarder$/ })).toBeVisible();
  await expect(page.getByText('HTTP 400+').first()).toBeVisible();
});

test('logs group under High, Medium and Low on All, titled by Route, and a tier tab drops the groups', async ({
  page,
}) => {
  await routeMonitor(page);
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);
  const logs = page.getByRole('list', { name: 'Logs' });
  const heads = logs.getByRole('listitem').filter({ hasNot: page.getByRole('button') });
  await expect(heads).toHaveText(['High2', 'Medium1', 'Low1']);
  await expect(logs.getByRole('button', { name: /\/v1\/orders/ })).toBeVisible();
  // Open stays unlabelled; a verified Alert says so.
  await expect(logs.getByRole('button', { name: /\/v1\/events.*verified/ })).toBeVisible();

  await page.getByRole('tab', { name: /^High/ }).click();
  await expect(logs.getByRole('button')).toHaveCount(2);
  await expect(heads).toHaveCount(0);
});

test('a pull request row shows when it was opened, and a Session row when it started', async ({ page }) => {
  const repo = {
    id: 'r1',
    name: 'apis',
    path: '/work/apis',
    host: 'github',
    remote_slug: 'example/apis',
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
          connection_ids: null,
          alert_id: null,
          state: 'idle',
          last_message_preview: null,
          last_error: null,
          created_at: started,
          last_active_at: started,
          playbook: null,
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
  await expect(page.getByText(/Opened Feb 5 · /)).toBeVisible();
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);
  await expect(page.getByText(/^Started .* · active 3h ago$/)).toBeVisible();
});

test('a running Scan shows Scanning… with a Stop button that cancels it', async ({ page }) => {
  await routeMonitor(page);
  await page.route(/\/api\/scans(\?.*)?$/, (route) =>
    route.fulfill(
      list([
        {
          id: 's9',
          triggered_by: 'operator',
          service_id: null,
          window_size: '1h',
          envs: ['prod'],
          services: NAMES,
          status_codes: [],
          status: 'running',
          error_code: null,
          error_message: null,
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
