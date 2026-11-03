import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-01T09:00:00.000Z';
const auth = { Authorization: `Bearer ${daemon.token}` };

type Step = { block: string; title: string; instructions: string; writes: boolean };

const MOCK_DATA: Step = {
  block: 'make_mock_data',
  title: 'Make mock data',
  instructions: 'Make up rows shaped like the real data.',
  writes: true,
};
const FIND_USERS: Step = {
  block: 'find_users',
  title: 'Find who else uses it',
  instructions: 'List the callers of the code you would change.',
  writes: false,
};

/** Every test starts with no Playbook of the operator's, so each Trigger holds its built-in. */
async function reset(request: APIRequestContext) {
  const list = await request.get(`${daemon.url}/api/playbooks`, { headers: auth });
  const { data } = (await list.json()) as { data: { items: { id: string; builtin: boolean }[] } };
  for (const playbook of data.items.filter((item) => !item.builtin)) {
    await request.delete(`${daemon.url}/api/playbooks/${playbook.id}`, { headers: auth });
  }
}

async function make(request: APIRequestContext, name: string, steps: Step[] = [], rules = ''): Promise<string> {
  const made = await request.post(`${daemon.url}/api/playbooks`, { headers: auth, data: { name, rules, steps } });
  return ((await made.json()) as { data: { id: string } }).data.id;
}

async function saved(request: APIRequestContext, id: string) {
  const list = await request.get(`${daemon.url}/api/playbooks`, { headers: auth });
  const { data } = (await list.json()) as {
    data: {
      items: { id: string; name: string; rules: string; branches: string; jira_ticket: boolean; steps: Step[] }[];
    };
  };
  return data.items.find((item) => item.id === id);
}

const open = (page: Page, id: string) => page.goto(`${daemon.url}/playbooks?playbook=${id}#token=${daemon.token}`);

const regions = (page: Page) => ({
  triggers: page.getByRole('region', { name: 'Triggers', exact: true }),
  playbooks: page.getByRole('region', { name: 'Playbooks', exact: true }),
  editor: page.getByRole('region', { name: 'Playbook', exact: true }),
  steps: page.getByRole('list', { name: 'Steps', exact: true }),
  blocks: page.getByRole('complementary', { name: 'Step blocks' }),
});

async function expectTitles(page: Page, titles: string[]) {
  const fields = regions(page).steps.getByRole('textbox', { name: 'Step title' });
  await expect(fields).toHaveCount(titles.length);
  for (const [index, title] of titles.entries()) await expect(fields.nth(index)).toHaveValue(title);
}

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test('Playbooks lists the seven Triggers under their tabs, the built-ins and the ten Step blocks', async ({ page }) => {
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Playbooks' }).click();
  const { triggers, playbooks, blocks, editor } = regions(page);

  await expect(triggers).toContainText(
    /Monitor\s*Verify.*Fix.*Workspace\s*Review PR.*Check reply.*Address comments.*Reply in thread.*Session message/,
  );
  for (const trigger of [
    'Verify',
    'Fix',
    'Review PR',
    'Check reply',
    'Address comments',
    'Reply in thread',
    'Session message',
  ]) {
    await expect(triggers.getByRole('listitem', { name: trigger, exact: true })).toContainText('Built-in');
  }
  await expect(playbooks).toContainText('No Playbooks yet. Duplicate a built-in or start a new one.');
  await expect(playbooks.getByRole('button', { name: /^Verify \(built-in\)/ })).toContainText('built-in · 8 steps');
  await expect(playbooks.getByRole('button', { name: /^Session message \(built-in\)/ })).toContainText(
    'built-in · rules only',
  );

  const titles = [
    'Trace the log through the code',
    'Find the Repo that owns it',
    'Find who else uses it',
    'Read real data from Connections',
    'Replay the request locally',
    'Make mock data',
    'Run the tests',
    'Test a lasting fix',
    'Check PROD readiness',
    'Custom step',
  ];
  const items = blocks.getByRole('listitem');
  await expect(items).toHaveCount(10);
  for (const [index, title] of titles.entries()) {
    await expect(items.nth(index)).toHaveAttribute('aria-label', title);
  }
  await expect(blocks.getByRole('listitem', { name: 'Make mock data' })).toContainText('scratch copy');
  await expect(blocks.getByRole('listitem', { name: 'Find who else uses it' })).not.toContainText('scratch copy');
  const instructions = blocks.getByText('Make mock data shaped like the real data you found');
  await expect(instructions).toBeHidden();
  await blocks.getByRole('listitem', { name: 'Make mock data' }).hover();
  await expect(instructions).toBeVisible();

  for (const [name, count, closing] of [
    ['Check reply', 4, 'Check reply: give the verdict and the reply.'],
    ['Address comments', 6, 'Address comments: report each thread done or declined.'],
  ] as const) {
    const builtin = playbooks.getByRole('button', { name: new RegExp(`^${name} \\(built-in\\)`) });
    await expect(builtin).toContainText(`built-in · ${count} steps`);
    await builtin.click();
    await expect(editor).toContainText(closing);
  }
});

test('a block dragged or added into Steps is a copy to edit; steps reorder and leave by drag or button; Save writes them', async ({
  page,
  request,
}) => {
  const id = await make(request, 'Checkout deep check');
  await open(page, id);
  const { steps, blocks, playbooks, editor } = regions(page);
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('Checkout deep check');
  await expect(editor).toContainText('On no Trigger');

  await blocks.getByRole('button', { name: 'Add Find the Repo that owns it to steps' }).click();
  await blocks.getByRole('button', { name: 'Add Make mock data to steps' }).click();
  await expectTitles(page, ['Find the Repo that owns it', 'Make mock data']);
  await expect(steps.getByRole('listitem', { name: 'Step 2' })).toContainText('scratch copy');

  // Dropped on the top half of step 1, the copy lands before it.
  await blocks
    .getByRole('listitem', { name: 'Trace the log through the code' })
    .dragTo(steps.getByRole('listitem', { name: 'Step 1' }), { targetPosition: { x: 40, y: 4 } });
  await expectTitles(page, ['Trace the log through the code', 'Find the Repo that owns it', 'Make mock data']);
  await expect(editor).toContainText('3 / 12');

  await steps.getByRole('listitem', { name: 'Step 1' }).getByRole('button', { name: 'Move down' }).click();
  await expectTitles(page, ['Find the Repo that owns it', 'Trace the log through the code', 'Make mock data']);
  await steps.getByRole('listitem', { name: 'Step 3' }).getByRole('button', { name: 'Move up' }).click();
  await expectTitles(page, ['Find the Repo that owns it', 'Make mock data', 'Trace the log through the code']);

  await steps
    .getByRole('listitem', { name: 'Step 3' })
    .getByTitle('Drag to reorder')
    .dragTo(steps.getByRole('listitem', { name: 'Step 1' }), { targetPosition: { x: 40, y: 4 } });
  await expectTitles(page, ['Trace the log through the code', 'Find the Repo that owns it', 'Make mock data']);

  // Let go outside Steps, a step is removed.
  await steps.getByRole('listitem', { name: 'Step 3' }).getByTitle('Drag to reorder').dragTo(blocks);
  await expectTitles(page, ['Trace the log through the code', 'Find the Repo that owns it']);

  await steps
    .getByRole('listitem', { name: 'Step 2' })
    .getByRole('textbox', { name: 'Step title' })
    .fill('Find the real owner');

  await blocks.getByRole('button', { name: 'Add Custom step to steps' }).click();
  const custom = steps.getByRole('listitem', { name: 'Step 3' });
  const tag = custom.getByRole('checkbox', { name: 'scratch copy' });
  await expect(tag).not.toBeChecked();
  await tag.check();
  await custom.getByRole('textbox', { name: 'Step title' }).fill('Seed carts');
  await custom.getByRole('textbox', { name: 'Step instructions' }).fill('Seed three made-up guest carts.');
  await expect(tag).toBeChecked();

  await steps.getByRole('listitem', { name: 'Step 1' }).getByRole('button', { name: 'Remove' }).click();
  await expectTitles(page, ['Find the real owner', 'Seed carts']);

  const row = playbooks.getByRole('button', { name: /^Checkout deep check/ });
  await expect(row.getByRole('img', { name: 'Unsaved edits' })).toBeVisible();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(row.getByRole('img', { name: 'Unsaved edits' })).toHaveCount(0);
  expect((await saved(request, id))?.steps).toMatchObject([
    { block: 'find_owner', title: 'Find the real owner', writes: false },
    { block: 'custom', title: 'Seed carts', instructions: 'Seed three made-up guest carts.', writes: true },
  ]);
});

test('unsaved edits stay through a page switch, a reload and a new tab until Save or Discard', async ({
  page,
  request,
}) => {
  const id = await make(request, 'Safe DB fix', [], 'Read only.');
  await open(page, id);
  const { playbooks, editor } = regions(page);
  const rules = editor.getByRole('textbox', { name: 'Rules' });
  const dot = playbooks.getByRole('button', { name: /^Safe DB fix/ }).getByRole('img', { name: 'Unsaved edits' });
  await expect(rules).toHaveValue('Read only.');
  await expect(dot).toHaveCount(0);

  await rules.fill('Never write to PROD.');
  await expect(editor).toContainText('20 / 8000');
  await expect(dot).toBeVisible();

  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Monitor' }).click();
  await nav.getByRole('link', { name: 'Playbooks' }).click();
  await expect(rules).toHaveValue('Never write to PROD.');
  await page.reload();
  await expect(rules).toHaveValue('Never write to PROD.');
  await expect(dot).toBeVisible();

  const again = await page.context().newPage();
  await page.close();
  await open(again, id);
  const reopened = regions(again);
  await expect(reopened.editor.getByRole('textbox', { name: 'Rules' })).toHaveValue('Never write to PROD.');
  await reopened.editor.getByRole('button', { name: 'Discard' }).click();
  await expect(reopened.editor.getByRole('textbox', { name: 'Rules' })).toHaveValue('Read only.');
  await expect(reopened.playbooks.getByRole('img', { name: 'Unsaved edits' })).toHaveCount(0);
  await again.reload();
  await expect(reopened.editor.getByRole('textbox', { name: 'Rules' })).toHaveValue('Read only.');
  expect((await saved(request, id))?.rules).toBe('Read only.');
});

test('Branch and the Jira ticket switch save what Verify and Fix read; a name git would take as an option is refused', async ({
  page,
  request,
}) => {
  const id = await make(request, 'Prod first');
  await open(page, id);
  const { editor } = regions(page);
  const branch = editor.getByRole('textbox', { name: 'Branch' });
  const ticket = editor.getByRole('switch', { name: 'Jira ticket' });
  await expect(branch).toHaveValue('');
  await expect(branch).toHaveAttribute('placeholder', /blank: the Repo's default branch/);
  await expect(ticket).toHaveAttribute('aria-checked', 'false');

  await branch.fill('production, master, main');
  await ticket.click();
  await expect(ticket).toHaveAttribute('aria-checked', 'true');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('button', { name: 'Save' })).toHaveCount(0);
  expect(await saved(request, id)).toMatchObject({ branches: 'production, master, main', jira_ticket: true });
  await page.reload();
  await expect(ticket).toHaveAttribute('aria-checked', 'true');

  await branch.fill('--upload-pack=x');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('alert')).toBeVisible();
  expect((await saved(request, id))?.branches).toBe('production, master, main');
});

test('every Playbook shows the console pull request description rule under its Rules', async ({ page, request }) => {
  const id = await make(request, 'PR depth');
  await open(page, id);
  const { editor } = regions(page);
  const rules = editor.getByRole('region', { name: 'Rules' });
  await rules.getByText("Every run also gets the console's pull request description rule").click();
  await expect(rules).toContainText('Testing: the commands you ran and their results');
  await expect(rules).toContainText('Never a one-line description.');
});

test('a failed Save shows why under Save and keeps the edits', async ({ page, request }) => {
  await make(request, 'Alpha checks');
  const id = await make(request, 'Beta checks');
  await open(page, id);
  const { editor, playbooks } = regions(page);

  await editor.getByRole('textbox', { name: 'Name' }).fill('alpha checks');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('alert')).toContainText('Another Playbook is named alpha checks');
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('alpha checks');
  await expect(
    playbooks.getByRole('button', { name: /^Beta checks/ }).getByRole('img', { name: 'Unsaved edits' }),
  ).toBeVisible();
  expect((await saved(request, id))?.name).toBe('Beta checks');
});

test('a built-in reads only and Duplicate makes an editable copy; New Playbook starts an empty one', async ({
  page,
  request,
}) => {
  await page.goto(`${daemon.url}/playbooks#token=${daemon.token}`);
  const { playbooks, editor, blocks } = regions(page);
  await playbooks.getByRole('button', { name: /^Verify \(built-in\)/ }).click();
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveAttribute('readonly', '');
  await expect(editor.getByRole('textbox', { name: 'Rules' })).toHaveAttribute('readonly', '');
  await expect(editor).toContainText('On: Monitor · Verify');
  await expect(editor.getByRole('button')).toHaveText(['Duplicate']);
  await expect(blocks.getByRole('button', { name: 'Add Make mock data to steps' })).toBeDisabled();

  await editor.getByRole('button', { name: 'Duplicate' }).click();
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('Copy of Verify (built-in)');
  await expect(editor.getByRole('textbox', { name: 'Name' })).not.toHaveAttribute('readonly', '');
  await expect(editor.getByRole('textbox', { name: 'Step title' })).toHaveCount(8);
  await expect(editor.getByRole('button', { name: 'Delete' })).toBeVisible();
  expect(page.url()).toMatch(/playbook=[0-9a-f-]{36}/);

  await page.getByRole('button', { name: 'New Playbook' }).click();
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('New Playbook');
  await expect(editor).toContainText('0 / 12');
  await expect(playbooks.getByRole('button')).toContainText(['Copy of Verify (built-in)', 'New Playbook']);
  const names = await request.get(`${daemon.url}/api/playbooks`, { headers: auth }).then((r) => r.json());
  expect(names.data.items.filter((item: { builtin: boolean }) => !item.builtin)).toHaveLength(2);
});

test('a Playbook goes on a Trigger by drag, dropdown or Attach to and comes off by drag, dropdown or Detach; Review PR takes writes', async ({
  page,
  request,
}) => {
  await make(request, 'Checkout deep check', [MOCK_DATA]);
  const safe = await make(request, 'Safe DB fix', [FIND_USERS]);
  await open(page, safe);
  const { triggers, playbooks, editor, blocks } = regions(page);
  const slot = (name: string) => triggers.getByRole('listitem', { name, exact: true });
  const row = (name: string) => playbooks.getByRole('button', { name: new RegExp(`^${name}`) });
  const attach = async (trigger: string) => {
    await editor.getByRole('button', { name: 'Attach to' }).click();
    await editor.getByRole('group', { name: 'Attach to' }).getByRole('button', { name: trigger }).click();
  };
  const pick = async (trigger: string, playbook: string) => {
    await slot(trigger)
      .getByRole('button', { name: `${trigger} runs` })
      .click();
    await page
      .getByRole('listbox', { name: `${trigger} runs` })
      .getByRole('option', { name: new RegExp(`^${playbook}`) })
      .click();
  };
  const confirm = page.getByRole('alertdialog');

  await row('Checkout deep check').dragTo(slot('Verify'));
  await expect(slot('Verify')).toContainText('Checkout deep check');
  await expect(row('Checkout deep check')).toContainText('Verify');

  // A step tagged scratch copy runs in Review PR's scratch copy, so Review PR takes the Playbook.
  await row('Checkout deep check').dragTo(slot('Review PR'));
  await expect(slot('Review PR')).toContainText('Checkout deep check');
  await expect(triggers.getByRole('alert')).toHaveCount(0);
  await pick('Review PR', 'Built-in');
  await expect(slot('Review PR')).toContainText('Built-in');

  await attach('Workspace · Session message');
  await expect(editor).toContainText('On: Workspace · Session message');
  await expect(editor).toContainText("Steps don't run on chat Triggers.");
  await expect(editor).not.toContainText("Then the console's own turn:");

  await row('Safe DB fix').dragTo(slot('Verify'));
  await expect(confirm).toContainText('Verify runs Checkout deep check. Replace it with Safe DB fix?');
  await confirm.getByRole('button', { name: 'Replace' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(slot('Verify')).toContainText('Safe DB fix');
  await expect(editor).not.toContainText("Steps don't run on chat Triggers.");

  await pick('Fix', 'Safe DB fix');
  await expect(editor).toContainText('On: Monitor · Verify, Monitor · Fix, Workspace · Session message');
  await expect(editor).toContainText("Then the console's own turn:");
  await expect(editor).toContainText('Verify: write the Report.');
  await expect(editor).toContainText('Fix: commit, push and open the PR.');

  await attach('Workspace · Review PR');
  await expect(slot('Review PR')).toContainText('Safe DB fix');
  await editor.getByRole('button', { name: 'Detach' }).click();
  await editor.getByRole('group', { name: 'Detach' }).getByRole('button', { name: 'Workspace · Review PR' }).click();
  await expect(slot('Review PR')).toContainText('Built-in');
  await pick('Review PR', 'Safe DB fix');
  await expect(slot('Review PR')).toContainText('Safe DB fix');
  await pick('Review PR', 'Built-in');
  await expect(slot('Review PR')).toContainText('Built-in');

  // A Trigger dragged off puts the built-in back.
  await slot('Verify').dragTo(blocks, { sourcePosition: { x: 12, y: 12 } });
  await expect(slot('Verify')).toContainText('Built-in');
  await expect(editor).toContainText('On: Monitor · Fix, Workspace · Session message');

  await editor.getByRole('button', { name: 'Delete' }).click();
  await expect(confirm).toContainText('Delete Safe DB fix?');
  await expect(confirm).toContainText("Fix and Session message go back to built-in. This can't be undone.");
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(row('Safe DB fix')).toBeVisible();
  await editor.getByRole('button', { name: 'Delete' }).click();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(row('Safe DB fix')).toHaveCount(0);
  await expect(slot('Fix')).toContainText('Built-in');
  await expect(slot('Session message')).toContainText('Built-in');
  await expect(row('Checkout deep check')).toBeVisible();
});

test('the page says while it reads Playbooks, and why it could not', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/playbooks', async (route) => {
    await held;
    await route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'the store is locked' } } });
  });
  await page.goto(`${daemon.url}/playbooks#token=${daemon.token}`);
  await expect(page.getByText('Reading Playbooks…')).toBeVisible();
  release();
  // The query tries three more times before it gives up.
  await expect(page.getByText('Could not read Playbooks: the store is locked')).toBeVisible({ timeout: 15_000 });
});

// Monitor and Workspace jobs come from the Datadog and Git host fakes, so these answer with fixtures.

const jobPlaybook = (id: string | null, name: string, steps: [string, string, string | null, boolean?][]) => ({
  id,
  name,
  steps: steps.map(([title, status, summary, writes = false]) => ({ title, status, summary, writes })),
});

const builtinsList = (held: { id: string; name: string; triggers: string[] }[]) => ({
  data: {
    items: held.map((playbook) => ({
      ...playbook,
      builtin: false,
      rules: '',
      branches: '',
      jira_ticket: false,
      steps: [],
      updated_at: NOW,
    })),
    blocks: [],
  },
});

const report = (alertId: string, status: string, playbook: unknown, extra: Record<string, unknown> = {}) => ({
  id: `rep-${alertId}`,
  alert_id: alertId,
  version: 1,
  status,
  kind: status === 'ready' ? 'bug' : null,
  slug: null,
  steps: [{ kind: 'step', text: 'Read src/orders/checkout.ts' }],
  replay: null,
  root_cause: status === 'ready' ? 'mergeCarts returns a cart with no shipping line.' : null,
  proposed_fix: status === 'ready' ? 'Skip the shipping tax line when there is none.' : null,
  diff: null,
  markdown: null,
  markdown_path: null,
  error_message: null,
  created_at: NOW,
  finished_at: null,
  playbook,
  ...extra,
});

const alert = (id: string, status: string, latestReport: ReturnType<typeof report>, fix: unknown = null) => ({
  id,
  route: { id: 'rt1', method: 'POST', path: '/v1/orders' },
  service: { id: 'sv1', name: 'checkout-api', env: 'prod', repo_id: 'r1', repo_url: null },
  fingerprint: id,
  http_status: 500,
  source: 'scan',
  severity: 'high',
  status,
  title: `Orders fail (${id})`,
  log_line: "TypeError: Cannot read properties of null (reading 'amount')",
  event_count: 12,
  first_seen_at: NOW,
  last_seen_at: NOW,
  resolved_at: null,
  regression_count: 0,
  waiting_since: null,
  datadog_query: 'service:checkout-api env:prod',
  session_id: null as string | null,
  samples: [],
  review: null,
  latest_report: latestReport,
  fix,
});

const ALERTS = {
  failed: alert(
    'a1',
    'open',
    report(
      'a1',
      'failed',
      jobPlaybook('pb-deep', 'Checkout deep check', [
        ['Find the Repo that owns it', 'done', 'checkout-api owns it: src/orders/checkout.ts:142.'],
        ['Find who else uses it', 'skipped', 'orders-db-dev was not reachable.'],
        ['Make mock data', 'failed', 'No fixture folder in this Repo.', true],
        ['Test a lasting fix', 'pending', null, true],
      ]),
      { error_message: 'Step 3 · Make mock data failed: No fixture folder in this Repo.' },
    ),
  ),
  writing: alert(
    'a2',
    'verifying',
    report(
      'a2',
      'running',
      jobPlaybook('pb-deep', 'Checkout deep check', [
        ['Find the Repo that owns it', 'done', 'checkout-api owns it.'],
        ['Find who else uses it', 'skipped', 'orders-db-dev was not reachable.'],
      ]),
    ),
  ),
  verified: alert('a3', 'verified', report('a3', 'ready', null)),
  fixing: alert('a4', 'fixing', report('a4', 'ready', null), {
    id: 'fix1',
    review_id: 'rv1',
    session_id: null,
    stage: 'steps',
    status: 'failed',
    jira_key: null,
    jira_url: null,
    ticket_skipped: null,
    branch: 'fix/orders-empty-cart',
    pr_number: null,
    pr_url: null,
    error_message: 'Step 2 · Tests failed: 2 tests fail on the empty cart.',
    started_at: NOW,
    finished_at: NOW,
    playbook: jobPlaybook(null, 'Fix (built-in)', [
      ['Code', 'done', 'Guarded the shipping line.', true],
      ['Tests', 'failed', '2 tests fail on the empty cart.', true],
    ]),
  }),
};

/** Answers Monitor's reads with one Service, checkout-api, and these Alerts. */
async function routeAlerts(page: Page, all: ReturnType<typeof alert>[]) {
  await page.route('**/api/services', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'sv1',
            name: 'checkout-api',
            env: 'prod',
            repo_id: 'r1',
            repo_url: null,
            check_interval: null,
            created_at: NOW,
            routes: [],
            open_alert_count: all.length,
            last_scan_at: null,
          },
        ],
      },
    }),
  );
  await page.route('**/api/alerts', (route) =>
    route.fulfill({ json: { data: all.map(({ samples, latest_report, review, fix, ...row }) => row) } }),
  );
  await page.route(/\/api\/alerts\/\w+(\/\w+)?$/, (route) => {
    const [, id, tail] = /\/alerts\/(\w+)(?:\/(\w+))?$/.exec(new URL(route.request().url()).pathname) ?? [];
    const found = all.find((row) => row.id === id);
    if (tail === 'events') return route.fulfill({ json: { data: [] } });
    if (tail === 'reports') return route.fulfill({ json: { data: [found?.latest_report] } });
    return route.fulfill({ json: { data: found } });
  });
}

test('Monitor names the Playbook on Verify and Fix, shows its steps on the Report and retries from the failed one', async ({
  page,
}) => {
  const retried: string[] = [];
  const all = Object.values(ALERTS);
  await routeAlerts(page, all);
  await page.route('**/api/playbooks', (route) =>
    route.fulfill({
      json: builtinsList([
        { id: 'pb-deep', name: 'Checkout deep check', triggers: ['verify'] },
        { id: 'pb-safe', name: 'Safe DB fix', triggers: ['fix'] },
      ]),
    }),
  );
  await page.route('**/api/reports/*/retry', (route) => {
    retried.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 202, json: { data: { ...ALERTS.failed.latest_report, status: 'running' } } });
  });
  const show = (id: string) =>
    page.goto(`${daemon.url}/monitor?service=checkout-api&alert=${id}#token=${daemon.token}`);
  const reportPanel = page.getByRole('region', { name: 'Report', exact: true });

  await show('a1');
  await expect(page.getByRole('button', { name: 'Verify with agent · Checkout deep check' })).toBeVisible();
  await expect(reportPanel.getByRole('link', { name: 'Checkout deep check' })).toHaveAttribute(
    'href',
    '/playbooks?playbook=pb-deep',
  );
  const steps = reportPanel.getByRole('list', { name: 'Playbook steps' }).getByRole('listitem');
  // The Playbook's four steps, then the console's own closing turn.
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(4)).toContainText('Write the Report');
  await expect(steps.nth(0)).toContainText('checkout-api owns it: src/orders/checkout.ts:142.');
  await expect(steps.nth(1)).toContainText('Skipped');
  await expect(steps.nth(2)).toContainText('Make mock data');
  await expect(steps.nth(2)).toContainText('scratch copy');
  await expect(steps.nth(2)).toContainText('No fixture folder in this Repo.');
  await expect(reportPanel).toContainText('Read src/orders/checkout.ts');
  await page.getByRole('button', { name: 'Retry from step 3' }).click();
  await expect.poll(() => retried).toEqual(['/api/reports/rep-a1/retry']);

  await show('a2');
  await expect(reportPanel.getByRole('list', { name: 'Playbook steps' })).toContainText('Writing the Report');

  await show('a3');
  await expect(page.getByRole('button', { name: 'Verify again · Checkout deep check' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fix with agent · Safe DB fix' })).toBeVisible();
  await expect(reportPanel).toContainText('mergeCarts returns a cart with no shipping line.');
  await expect(reportPanel).not.toContainText('Playbook');
  await expect(page.getByRole('button', { name: /Retry from/ })).toHaveCount(0);

  await show('a4');
  const fix = page.getByRole('region', { name: 'Fix', exact: true });
  const stages = fix.getByRole('list', { name: 'Fix progress' }).getByRole('listitem');
  await expect(stages).toHaveText([
    /Ticket.*Skipped.*No Jira connected\./,
    /Branch.*done.*fix\/orders-empty-cart/,
    /Code.*done.*Guarded the shipping line\./,
    /Tests.*Failed.*2 tests fail on the empty cart\./,
    /Pull request.*to do/,
  ]);
  await expect(fix.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
  await expect(stages.nth(3)).toContainText('Retry from step 2');
  await expect(fix).toContainText('Playbook: Fix (built-in)');
  await expect(fix.getByRole('button', { name: 'Retry from step 2' })).toBeVisible();
});

test('Cancel Fix asks first, then sends the cancel; Keep it sends nothing', async ({ page }) => {
  const cancelled: string[] = [];
  await routeAlerts(page, Object.values(ALERTS));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: builtinsList([]) }));
  await page.route('**/api/fixes/*/cancel', (route) => {
    cancelled.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { data: { ...(ALERTS.fixing.fix as object), status: 'abandoned' } } });
  });
  await page.goto(`${daemon.url}/monitor?service=checkout-api&alert=a4#token=${daemon.token}`);
  const fix = page.getByRole('region', { name: 'Fix', exact: true });

  await fix.getByRole('button', { name: 'Cancel Fix' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Cancel this Fix?' });
  await expect(dialog).toContainText('branch fix/orders-empty-cart is deleted');
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toHaveCount(0);
  expect(cancelled).toEqual([]);

  await fix.getByRole('button', { name: 'Cancel Fix' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel the Fix' }).click();
  await expect.poll(() => cancelled).toEqual(['/api/fixes/fix1/cancel']);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

const pullRequest = (review: unknown) => ({
  repo_id: 'r1',
  host: 'github',
  slug: 'example/checkout-api',
  number: 7,
  url: 'https://github.com/example/checkout-api/pull/7',
  title: 'Guard empty carts',
  author: 'someone',
  branch: 'fix/empty-cart',
  base_branch: 'main',
  head_sha: '9c1e4b7d00000000000000000000000000000000',
  state: 'open',
  review_state: 'none',
  approved_by: [],
  checks: 'passed',
  additions: 3,
  deletions: 1,
  body: '',
  opened_at: NOW,
  merged_at: null,
  is_mine: true,
  by_agent: false,
  comment_count: 0,
  resolved_count: 0,
  agent_session_id: null,
  latest_agent_review: review,
  files: [],
  comments: [],
  reply_checks: [],
  comment_passes: [],
});

const agentReview = (extra: Record<string, unknown>) => ({
  id: 'ar1',
  repo_id: 'r1',
  pr_number: 7,
  head_sha: '9c1e4b7d00000000000000000000000000000000',
  status: 'ready',
  decision: null,
  verdict: null,
  base_branch: null,
  base_sha: null,
  report: null,
  error: null,
  findings: [],
  checklist: [],
  tools: [],
  created_at: NOW,
  stale: false,
  playbook: null,
  ...extra,
});

const finding = (severity: string, file: string | null, line: number | null, text: string) => ({
  severity,
  file,
  line,
  text,
  comment_id: null,
  post_error: null,
});

test('Review with agent names the Review PR Playbook, and the Agent Review shows its name, steps, verdict, findings worst first and full report', async ({
  page,
}) => {
  await page.route('**/api/playbooks', (route) =>
    route.fulfill({ json: builtinsList([{ id: 'pb-prod', name: 'PROD readiness', triggers: ['review_pr'] }]) }),
  );
  await page.route('**/api/repos/r1/pull-requests/7', (route) =>
    route.fulfill({
      json: {
        data: pullRequest(
          agentReview({
            decision: 'request_changes',
            verdict: 'Ready once the cache has a TTL.',
            base_branch: 'production',
            base_sha: '4a7f2c9e00000000000000000000000000000000',
            report: '## Tax cache\n\nThe rate cache never expires.',
            findings: [
              finding('low', 'src/tax.ts', 9, 'Name this rate.'),
              finding('critical', 'src/cart.ts', 12, 'An empty cart throws on checkout.'),
              finding('medium', null, null, 'No test covers the empty cart.'),
            ],
            stale: true,
            playbook: jobPlaybook('pb-prod', 'PROD readiness', [
              ['Find who else uses it', 'done', 'Only checkout-api reads tax rates.'],
              ['Check PROD readiness', 'done', 'No migration; the cache needs a TTL.'],
            ]),
          }),
        ),
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?tab=pulls&pr=r1/7#token=${daemon.token}`);

  await expect(page.getByRole('button', { name: 'Agent Review · PROD readiness' })).toBeVisible();
  const card = page.getByRole('region', { name: 'Agent Review' });
  await expect(card.getByRole('link', { name: 'PROD readiness' })).toHaveAttribute(
    'href',
    '/playbooks?playbook=pb-prod',
  );
  const steps = card.getByRole('list', { name: 'Playbook steps' }).getByRole('listitem');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(2)).toContainText('findings, checklist and verdict');
  await expect(steps.nth(1)).toContainText('Check PROD readiness');
  await expect(steps.nth(1)).toContainText('No migration; the cache needs a TTL.');

  await expect(card.getByText('REQUEST CHANGES', { exact: true })).toBeVisible();
  await expect(card).toContainText('Reviewed 9c1e4b7 against production at 4a7f2c9');
  const reviewedAt = await page.evaluate((at) => new Date(at).toLocaleString(), NOW);
  await expect(card).toContainText(reviewedAt);
  await expect(card.getByRole('group', { name: 'Findings by severity' })).toHaveText(
    /^1 Critical\s*0 High\s*1 Medium\s*1 Low\s*0 Info$/,
  );
  await expect(card).toContainText(
    /Critical src\/cart\.ts:12\s*An empty cart throws on checkout\.\s*Medium\s*No test covers the empty cart\.\s*Low src\/tax\.ts:9\s*Name this rate\./,
  );

  const report = card.getByRole('heading', { name: 'Tax cache' });
  await expect(report).toBeHidden();
  await card.getByText('Full report', { exact: true }).click();
  await expect(report).toBeVisible();
  await expect(card.getByText('The rate cache never expires.')).toBeVisible();
});

test("a running Report, Fix and Agent Review each stop their Session's run", async ({ page }) => {
  const stopped: string[] = [];
  const steps = jobPlaybook(null, 'Fix (built-in)', [['Code', 'running', null, true]]);
  const verifying = {
    ...alert('a5', 'verifying', report('a5', 'running', jobPlaybook(null, 'Verify (built-in)', []))),
    session_id: 'sv5',
  };
  const fixing = alert('a6', 'fixing', report('a6', 'ready', null), {
    id: 'fix6',
    review_id: 'rv6',
    session_id: 'sf6',
    stage: 'steps',
    status: 'running',
    jira_key: null,
    jira_url: null,
    ticket_skipped: null,
    branch: 'fix/orders-empty-cart',
    pr_number: null,
    pr_url: null,
    error_message: null,
    started_at: NOW,
    finished_at: null,
    playbook: steps,
  });
  await routeAlerts(page, [verifying, fixing]);
  await page.route('**/api/sessions/*/stop', (route) => {
    stopped.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/repos/r1/pull-requests/7', (route) =>
    route.fulfill({
      json: {
        data: {
          ...pullRequest(agentReview({ status: 'running' })),
          agent_session_id: 'sr7',
        },
      },
    }),
  );

  await page.goto(`${daemon.url}/monitor?service=checkout-api&alert=a5#token=${daemon.token}`);
  await page.getByRole('region', { name: 'Report', exact: true }).getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => stopped).toEqual(['/api/sessions/sv5/stop']);

  await page.goto(`${daemon.url}/monitor?service=checkout-api&alert=a6#token=${daemon.token}`);
  await page.getByRole('region', { name: 'Fix', exact: true }).getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => stopped).toEqual(['/api/sessions/sv5/stop', '/api/sessions/sf6/stop']);

  await page.goto(`${daemon.url}/workspace?tab=pulls&pr=r1/7#token=${daemon.token}`);
  await page.getByRole('region', { name: 'Agent Review' }).getByRole('button', { name: 'Stop' }).click();
  await expect
    .poll(() => stopped)
    .toEqual(['/api/sessions/sv5/stop', '/api/sessions/sf6/stop', '/api/sessions/sr7/stop']);
});

const session = (id: string, kind: string, playbook: { id: string; name: string } | null) => ({
  id,
  kind,
  title: `Session ${id}`,
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'auto',
  account_id: null,
  repo_id: null,
  branch: null,
  pr_number: null,
  connection_ids: null,
  alert_id: null,
  state: 'idle',
  last_message_preview: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook,
});

test('a Session names the Playbook its rules come from and links to it', async ({ page, request }) => {
  const id = await make(request, 'Safe DB fix', [], 'Never write to PROD.');
  const playbook = { id, name: 'Safe DB fix' };
  await page.route(/\/api\/sessions\?kind=anonymous/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'anonymous', playbook), session('s2', 'anonymous', null)] } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) => route.fulfill({ json: { data: [] } }));
  await page.route(/\/api\/sessions\/s\d\/messages/, (route) => route.fulfill({ json: { data: [] } }));

  await page.goto(`${daemon.url}/workspace?session=s2#token=${daemon.token}`);
  await expect(page.getByRole('heading', { name: 'Session s2' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Playbook:/ })).toHaveCount(0);

  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);
  await page.getByRole('link', { name: 'Playbook: Safe DB fix' }).click();
  await expect(regions(page).editor.getByRole('textbox', { name: 'Rules' })).toHaveValue('Never write to PROD.');
  expect(page.url()).toContain(`/playbooks?playbook=${id}`);
});

test('the Agent Review folds to its header from the chevron, and stays folded after a reload', async ({ page }) => {
  await page.route('**/api/repos/r1/pull-requests/7', (route) =>
    route.fulfill({
      json: {
        data: pullRequest(agentReview({ verdict: 'Ready once the cache has a TTL.' })),
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?tab=pulls&pr=r1/7#token=${daemon.token}`);

  const card = page.getByRole('region', { name: 'Agent Review' });
  const fold = card.getByRole('button', { name: 'Fold Agent Review' });
  await expect(card.getByText('Ready once the cache has a TTL.')).toBeVisible();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');

  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(card.getByText('Ready once the cache has a TTL.')).toBeHidden();
  await expect(card.getByText('ready', { exact: true })).toBeVisible();

  await page.reload();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await fold.click();
  await expect(card.getByText('Ready once the cache has a TTL.')).toBeVisible();
});

test('the Monitor search keeps the logs whose words match, and the Services panel folds to a rail', async ({
  page,
}) => {
  const a1 = alert('a1', 'open', report('a1', 'ready', null));
  const a2 = {
    ...alert('a2', 'open', report('a2', 'ready', null)),
    route: { id: 'rt2', method: 'GET', path: '/v1/carts' },
    http_status: 404,
    log_line: 'Cart not found',
  };
  await routeAlerts(page, [a1, a2]);
  await page.goto(`${daemon.url}/monitor#token=${daemon.token}`);

  const logs = page.getByRole('list', { name: 'Logs' }).getByRole('listitem');
  await expect(logs).toHaveCount(2);
  const search = page.getByRole('searchbox', { name: 'Search logs' });
  await search.fill('carts 404');
  await expect(logs).toHaveCount(1);
  await expect(logs.first()).toContainText('Cart not found');
  await search.fill('nothing like this');
  await expect(page.getByText('No logs match “nothing like this”.')).toBeVisible();
  await search.fill('');

  await page.getByRole('button', { name: 'Collapse the Services panel' }).click();
  await expect(page.getByRole('list', { name: 'Services' })).toHaveCount(0);
  await page.reload();
  const rail = page.getByRole('navigation', { name: 'Services panel' });
  await rail.getByRole('button', { name: 'Open the Services panel' }).click();
  await expect(page.getByRole('list', { name: 'Services' })).toBeVisible();
});
