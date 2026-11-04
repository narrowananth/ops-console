import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

const SERVICE = {
  id: 'sv1',
  name: 'orders-api',
  env: 'prod',
  repo_id: null,
  repo_url: 'github.com/example/orders-api',
  check_interval: null,
  created_at: ago(100),
  routes: [],
  open_alert_count: 1,
  last_scan_at: null,
};

const alertOf = (extra: Record<string, unknown> = {}) => ({
  id: 'a1',
  route: { id: 'r1', method: 'POST', path: '/orders' },
  service: { id: 'sv1', name: 'orders-api', env: 'prod', repo_id: null, repo_url: 'github.com/example/orders-api' },
  fingerprint: 'fp1',
  http_status: 500,
  source: 'scan',
  severity: 'high',
  status: 'open',
  title: 'NullPointerException in OrderService',
  log_line: 'NullPointerException in OrderService',
  event_count: 12,
  first_seen_at: ago(30),
  last_seen_at: ago(9),
  resolved_at: null,
  regression_count: 0,
  waiting_since: null,
  datadog_query: 'env:prod service:orders-api',
  session_id: null,
  last_scanned_at: ago(9),
  scan_overdue: false,
  awaiting_prod_check: false,
  ...extra,
});

const REPORT = {
  id: 'rp1',
  alert_id: 'a1',
  version: 1,
  status: 'ready',
  kind: 'bug',
  slug: 'null-total',
  steps: [
    { kind: 'result', text: 'Datadog recheck, last hour: still failing' },
    { kind: 'step', text: 'Code: main at 3f9a2c1, fetched from origin' },
    {
      kind: 'warning',
      text: 'prod ran `v2.1.4`; verified at `3f9a2c1` of `main`; the console cannot confirm they match',
    },
  ],
  replay: null,
  root_cause: 'OrderService reads a missing total',
  proposed_fix: 'Default the total to zero',
  diff: null,
  markdown:
    '## Root cause\n\nOrderService reads a missing total.\n\n## Prod parity\n\n- Code version: main tip, prod unknown.',
  markdown_path: null,
  error_message: null,
  created_at: ago(2),
  started_at: ago(2),
  finished_at: ago(1),
  playbook: null,
};

async function routeMonitor(page: Page, alert: ReturnType<typeof alertOf>, report: unknown = null) {
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
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [datadog], meta: { next_cursor: null } } }),
  );
  await page.route('**/api/services', (route) =>
    route.fulfill({ json: { data: [SERVICE], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/scans(\?.*)?$/, (route) =>
    route.fulfill({ json: { data: [], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/alerts(\?.*)?$/, (route) =>
    route.fulfill({ json: { data: [alert], meta: { next_cursor: null } } }),
  );
  await page.route('**/api/alerts/a1', (route) =>
    route.fulfill({ json: { data: { ...alert, samples: [], latest_report: report, review: null, fix: null } } }),
  );
  await page.route('**/api/alerts/a1/events', (route) =>
    route.fulfill({ json: { data: [], meta: { next_cursor: null } } }),
  );
  await page.route('**/api/alerts/a1/reports', (route) =>
    route.fulfill({ json: { data: report ? [report] : [], meta: { next_cursor: null } } }),
  );
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/monitor\//, (route) => route.fulfill({ json: { data: [], meta: { next_cursor: null } } }));
}

test('an Alert row and its header say when a Scan last read the Service', async ({ page }) => {
  await routeMonitor(page, alertOf());
  await page.goto(`${daemon.url}/monitor?alert=a1#token=${daemon.token}`);
  await expect(page.getByRole('heading', { name: 'NullPointerException in OrderService' })).toBeVisible();
  await expect(page.getByText('last scanned 9h ago')).toHaveCount(2);
  await expect(page.getByText('a Scan was missed')).toHaveCount(0);
});

test('past two Check intervals the text is a warning, and an Alert no Scan covered reads never scanned', async ({
  page,
}) => {
  await routeMonitor(page, alertOf({ last_scanned_at: ago(60), scan_overdue: true }));
  await page.goto(`${daemon.url}/monitor?alert=a1#token=${daemon.token}`);
  await expect(page.getByText('last scanned 3d ago · a Scan was missed')).toHaveCount(2);
  await expect(page.getByText('last scanned 3d ago · a Scan was missed').first()).toHaveAttribute(
    'title',
    'No Scan has read this Service for 2 Check intervals. The failure may be gone.',
  );
});

test('a never-scanned Alert shows the warning', async ({ page }) => {
  await routeMonitor(page, alertOf({ last_scanned_at: null, scan_overdue: true }));
  await page.goto(`${daemon.url}/monitor?alert=a1#token=${daemon.token}`);
  await expect(page.getByText('never scanned')).toHaveCount(2);
});

test('a resolved Alert awaits a healthy Scan, and the line goes once one saw it', async ({ page }) => {
  // The list hides resolved Alerts by default, so the header carries the line.
  await routeMonitor(page, alertOf({ status: 'resolved', resolved_at: ago(1), awaiting_prod_check: true }));
  await page.goto(`${daemon.url}/monitor?alert=a1#token=${daemon.token}`);
  await expect(page.getByText('Merged, not yet seen healthy in prod')).toHaveCount(1);
  await page.unroute('**/api/alerts/a1');
  await page.route('**/api/alerts/a1', (route) =>
    route.fulfill({
      json: {
        data: {
          ...alertOf({ status: 'resolved', resolved_at: ago(1), awaiting_prod_check: false }),
          samples: [],
          latest_report: null,
          review: null,
          fix: null,
        },
      },
    }),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'NullPointerException in OrderService' })).toBeVisible();
  await expect(page.getByText('Merged, not yet seen healthy in prod')).toHaveCount(0);
});

test('a ready Report shows the Recheck, the version warning and the Prod parity section', async ({ page }) => {
  await routeMonitor(page, alertOf({ status: 'verified', waiting_since: ago(1) }), REPORT);
  await page.goto(`${daemon.url}/monitor?alert=a1#token=${daemon.token}`);
  const notes = page.getByRole('list').filter({ hasText: 'Datadog recheck, last hour: still failing' });
  await expect(notes.getByRole('listitem')).toHaveText([
    'Datadog recheck, last hour: still failing',
    'prod ran `v2.1.4`; verified at `3f9a2c1` of `main`; the console cannot confirm they match',
  ]);
  await expect(page.getByRole('heading', { name: 'Prod parity' })).toBeVisible();
});
