import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-01T09:00:00.000Z';
const LATER = '2026-11-01T10:00:00.000Z';
const BUSY = 'A Session is already working on this';
const PUSHED = '33f8c2b2a1d04e5f60718293a4b5c6d7e8f90a1b';

// The Git host and the agent are fakes in the daemon, so the pull request and its Sessions answer with fixtures.

const comment = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  parent_id: null as string | null,
  author: 'reviewer',
  by_agent: false,
  is_mine: false,
  body: 'A comment',
  file_path: 'src/cart.ts' as string | null,
  line: 12 as number | null,
  resolved: false,
  outdated: null as boolean | null,
  hunk: null as string | null,
  created_at: NOW,
  reply_count: 0,
  ...extra,
});

/** Five threads: one a reply answered, one resolved, one the agent answered last, one on no line, one the agent started. */
const COMMENTS = [
  comment('c1', { body: 'Guard the empty cart.\nIt throws on checkout.' }),
  comment('c1r', { parent_id: 'c1', author: 'me', is_mine: true, body: 'Fixed in 33f8c2b2', created_at: LATER }),
  comment('c2', { file_path: 'src/tax.ts', line: 4, body: 'Round the tax.', resolved: true }),
  comment('c3', { file_path: 'src/tax.ts', line: 9, body: 'Name this rate.' }),
  comment('c3r', { parent_id: 'c3', author: 'me', by_agent: true, is_mine: true, body: 'Fixed.', created_at: LATER }),
  comment('c4', { file_path: null, line: null, body: 'Nice work overall.' }),
  comment('c5', { author: 'me', by_agent: true, is_mine: true, line: 30, body: 'Cache the rate lookup.' }),
  comment('c5r', { parent_id: 'c5', author: 'reviewer', body: 'Done, cached for an hour.', created_at: LATER }),
];

/** The Session a button opens. */
const session = (id: string, title: string, prAction: string) => ({
  id,
  kind: 'repo',
  title,
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'auto',
  account_id: null,
  repo_id: 'r1',
  branch: null,
  pr_number: 7,
  pr_action: prAction,
  connection_ids: null,
  extra_repo_ids: [],
  pull_request: null,
  pull_requests: [],
  alert_id: null,
  state: 'working',
  last_message_preview: null,
  last_error: null,
  created_at: LATER,
  last_active_at: LATER,
  playbook: null,
  queued_message: null,
  spawned_by: null,
  spawned: [],
  subagents: [],
});

/** An entry of `action_sessions`: one PR action Session as the pull request lists it. */
const actionSession = (id: string, action: string, state: string, extra: Record<string, unknown> = {}) => ({
  session_id: id,
  action,
  state,
  commit_sha: null as string | null,
  stale: false,
  created_at: LATER,
  ...extra,
});

const pullRequest = (extra: Record<string, unknown> = {}) => ({
  repo_id: 'r1',
  host: 'github',
  slug: 'example/checkout-api',
  number: 7,
  url: 'https://github.com/example/checkout-api/pull/7',
  title: 'Guard empty carts',
  author: 'me',
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
  comment_count: 5,
  resolved_count: 1,
  agent_session_id: null,
  latest_agent_review: null,
  files: [],
  comments: COMMENTS,
  action_sessions: [] as unknown[],
  commits: [] as unknown[],
  conflicts: { state: 'clean', files: [] as string[], checked_at: null as string | null },
  ...extra,
});

type Posted = { path: string; body: unknown };

/**
 * Answers the pull request with `detail`, read on every request so a test can change it, and each action start with
 * `answer`, recording what was sent.
 */
async function routePullRequest(
  page: Page,
  detail: { current: ReturnType<typeof pullRequest> },
  answer: (body: { action: string }) => { status: number; json: unknown } = ({ action }) => ({
    status: 201,
    json: { data: session(`s-${action}`, 'Action', action) },
  }),
) {
  const posted: Posted[] = [];
  // The Sessions the buttons opened: the Sessions page shows a Session only while the list holds it.
  const opened: unknown[] = [];
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => route.fulfill({ json: { data: opened } }));
  await page.route('**/api/sessions/*/messages', (route) => route.fulfill({ json: { data: [] } }));
  // No Playbook of the operator's on any Trigger, so every button names the built-in.
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route('**/api/repos/r1/pull-requests/7', (route) => route.fulfill({ json: { data: detail.current } }));
  await page.route('**/api/repos/r1/pull-requests/7/action-sessions', (route) => {
    const body = route.request().postDataJSON();
    posted.push({ path: new URL(route.request().url()).pathname, body });
    const answered = answer(body);
    if (answered.status === 201) opened.push((answered.json as { data: unknown }).data);
    return route.fulfill(answered);
  });
  return posted;
}

const openPullRequest = (page: Page) => page.goto(`${daemon.url}/workspace?tab=pulls&pr=r1/7#token=${daemon.token}`);

const thread = (page: Page, text: string) =>
  page.getByRole('region', { name: 'Activity' }).getByRole('listitem').filter({ hasText: text });

const ACTIONS = '/api/repos/r1/pull-requests/7/action-sessions';

test('Check replies sits at the top and opens a Session over every replied thread', async ({ page }) => {
  const detail = { current: pullRequest() };
  const posted = await routePullRequest(page, detail);
  await openPullRequest(page);

  // No thread has its own button: one button at the top covers them all.
  await expect(page.getByRole('button', { name: 'Check reply', exact: true })).toHaveCount(0);
  const button = page.getByRole('button', { name: /^Check replies/ });
  await expect(button).toHaveText('Check replies · 2');
  await expect(button).toHaveAttribute('title', /Opens a Session where the agent checks every open thread/);

  await button.click();
  await expect.poll(() => posted).toEqual([{ path: ACTIONS, body: { action: 'check_replies' } }]);
  // Starting opens the new Session.
  await expect(page).toHaveURL(/session=s-check_replies/);
});

test('Check replies hides on a merged or closed pull request', async ({ page }) => {
  for (const state of ['closed', 'merged']) {
    await routePullRequest(page, { current: pullRequest({ state }) });
    await openPullRequest(page);
    await expect(thread(page, 'Guard the empty cart.')).toContainText('Fixed in 33f8c2b2');
    await expect(page.getByRole('button', { name: /^Check replies/ })).toHaveCount(0);
    await page.unrouteAll();
    // The next goto differs only after the #, which would keep this page and its cached pull request.
    await page.goto('about:blank');
  }
});

test('Address comments shows on any open pull request, the operator’s or someone else’s, with an unresolved thread', async ({
  page,
}) => {
  const general = COMMENTS.filter((item) => item.id === 'c4');
  const allResolved = COMMENTS.map((item) => ({ ...item, resolved: true }));
  for (const [extra, shown] of [
    [{}, true],
    [{ is_mine: false, author: 'someone' }, true],
    [{ comments: general }, true],
    [{ state: 'closed' }, false],
    [{ comments: allResolved }, false],
  ] as const) {
    await routePullRequest(page, { current: pullRequest(extra) });
    await openPullRequest(page);
    // Agent Review shows on an open pull request only, so on a closed one wait on the tabs instead.
    const closed = 'state' in extra && extra.state === 'closed';
    await expect(page.getByRole('button', { name: 'Agent Review' })).toHaveCount(closed ? 0 : 1);
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Address comments' })).toHaveCount(shown ? 1 : 0);
    await page.unrouteAll();
    // The next goto differs only after the #, which would keep this page and its cached pull request.
    await page.goto('about:blank');
  }
});

test('Address comments lists every unresolved thread, general comments too, all ticked; Start opens a Session on the ticked ones, Cancel nothing', async ({
  page,
}) => {
  const detail = { current: pullRequest() };
  const posted = await routePullRequest(page, detail);
  await openPullRequest(page);

  await page.getByRole('button', { name: 'Address comments' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Address comments' });
  const boxes = dialog.getByRole('checkbox');
  await expect(boxes).toHaveCount(4);
  await expect(dialog.getByRole('listitem')).toHaveText([
    /src\/cart\.ts:12\s*reviewer\s*Guard the empty cart\.$/,
    /src\/tax\.ts:9\s*reviewer\s*Name this rate\.$/,
    /General comment\s*reviewer\s*Nice work overall\.$/,
    /src\/cart\.ts:30\s*me\s*Cache the rate lookup\.$/,
  ]);
  for (const box of await boxes.all()) await expect(box).toBeChecked();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(posted).toEqual([]);

  await page.getByRole('button', { name: 'Address comments' }).click();
  for (const box of await boxes.all()) await box.uncheck();
  await expect(dialog.getByRole('button', { name: 'Start' })).toBeDisabled();
  await boxes.nth(0).check();
  await boxes.nth(2).check();
  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => posted)
    .toEqual([{ path: ACTIONS, body: { action: 'address_comments', comment_ids: ['c1', 'c4'] } }]);
  await expect(page).toHaveURL(/session=s-address_comments/);
});

test('the Sessions rail lists each PR action Session by action and state, with its commit and "older commit"', async ({
  page,
}) => {
  const detail = {
    current: pullRequest({
      action_sessions: [
        actionSession('sa1', 'address_comments', 'submitted', { commit_sha: PUSHED, stale: true }),
        actionSession('sr1', 'review', 'working'),
        actionSession('sc1', 'check_replies', 'not_submitted'),
      ],
    }),
  };
  await routePullRequest(page, detail);
  await openPullRequest(page);

  const address = page.getByRole('link', { name: 'Address comments · submitted' });
  await expect(address).toHaveAttribute('href', /session=sa1/);
  const row = address.locator('..');
  await expect(row.getByRole('link', { name: PUSHED.slice(0, 7) })).toHaveAttribute(
    'href',
    `https://github.com/example/checkout-api/pull/7`.replace('/pull/7', `/commit/${PUSHED}`),
  );
  await expect(row).toContainText('older commit');
  await expect(page.getByRole('link', { name: 'Agent Review · working' })).toHaveAttribute('href', /session=sr1/);
  await expect(page.getByRole('link', { name: 'Check replies · not submitted' })).toHaveAttribute(
    'href',
    /session=sc1/,
  );
  // The Session the pull request has no commit for shows no sha and no marker.
  await expect(page.getByRole('link', { name: 'Check replies · not submitted' }).locator('..')).not.toContainText(
    'older commit',
  );
});

test('while a Session of one action is not submitted that button waits and the others stay; a submitted one frees it; a refused start says why', async ({
  page,
}) => {
  const detail = {
    current: pullRequest({ action_sessions: [actionSession('sa1', 'address_comments', 'working')] }),
  };
  await routePullRequest(page, detail, ({ action }) =>
    action === 'check_replies'
      ? { status: 409, json: { error: { code: 'session_busy', message: BUSY } } }
      : { status: 502, json: { error: { code: 'upstream_failed', message: 'GitHub did not answer.' } } },
  );
  await openPullRequest(page);

  const address = page.getByRole('button', { name: 'Address comments' });
  await expect(address).toBeDisabled();
  await expect(address).toHaveAttribute('title', BUSY);
  await expect(page.getByRole('button', { name: 'Agent Review' })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^Check replies/ })).toBeEnabled();

  // A Review running reads as such, and only that button waits.
  detail.current = pullRequest({ action_sessions: [actionSession('sr1', 'review', 'working')] });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Agent reviewing…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Agent reviewing…' })).toHaveAttribute('title', BUSY);
  await expect(page.getByText('Agent reviewing', { exact: true })).toBeVisible();
  await expect(address).toBeEnabled();

  // Submitted, it frees the button.
  detail.current = pullRequest({ action_sessions: [actionSession('sa1', 'address_comments', 'submitted')] });
  await page.reload();
  await expect(address).toBeEnabled();

  // Another tab started a Check replies the page has not heard of yet: the API says so.
  await page.getByRole('button', { name: /^Check replies/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: BUSY })).toBeVisible();

  await address.click();
  await page.getByRole('alertdialog', { name: 'Address comments' }).getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'GitHub did not answer.' })).toBeVisible();
});

test('Agent Review opens a note dialog; Cancel starts nothing and Start opens the Session with the note', async ({
  page,
}) => {
  const detail = { current: pullRequest() };
  const posted = await routePullRequest(page, detail);
  await openPullRequest(page);

  await page.getByRole('button', { name: 'Agent Review' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Agent Review' });
  const field = dialog.getByRole('textbox', { name: 'Note for the agent' });
  await expect(field).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(posted).toEqual([]);

  await page.getByRole('button', { name: 'Agent Review' }).click();
  await field.fill('Continues #12; check the retry path');
  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect
    .poll(() => posted)
    .toEqual([{ path: ACTIONS, body: { action: 'review', note: 'Continues #12; check the retry path' } }]);
  await expect(page).toHaveURL(/session=s-review/);
});

test('Agent Review with an empty note sends none', async ({ page }) => {
  const detail = { current: pullRequest() };
  const posted = await routePullRequest(page, detail);
  await openPullRequest(page);

  await page.getByRole('button', { name: 'Agent Review' }).click();
  await page.getByRole('alertdialog', { name: 'Agent Review' }).getByRole('button', { name: 'Start' }).click();
  await expect.poll(() => posted).toEqual([{ path: ACTIONS, body: { action: 'review' } }]);
});

test('Collapse all folds every file to its name and Expand all opens them again', async ({ page }) => {
  const file = (name: string) => ({
    name,
    additions: 1,
    deletions: 0,
    lines: [
      { sign: ' ', text: '@@ -1 +1,2 @@' },
      { sign: '+', text: `export const ${name.replace(/\W/g, '')} = 1;` },
    ],
  });
  const detail = { current: pullRequest({ files: [file('src/a.ts'), file('src/b.ts'), file('src/c.ts')] }) };
  await routePullRequest(page, detail);
  await openPullRequest(page);
  await page.getByRole('tab', { name: /^Files changed/ }).click();

  const files = page.getByRole('region', { name: 'Files' });
  await expect(files.getByText('export const srcats = 1;')).toBeVisible();
  await page.getByRole('button', { name: 'Collapse all' }).click();
  for (const name of ['srcats', 'srcbts', 'srccts'])
    await expect(files.getByText(`export const ${name} = 1;`)).toBeHidden();

  // A fold kept in the browser holds through a reload, as does the tab, and Expand all opens every file again.
  await page.reload();
  await expect(files.getByText('export const srcbts = 1;')).toBeHidden();
  await page.getByRole('button', { name: 'Expand all' }).click();
  for (const name of ['srcats', 'srcbts', 'srccts'])
    await expect(files.getByText(`export const ${name} = 1;`)).toBeVisible();
});

test('Request changes sits under More actions; Merge waits for an approval and asks before it merges', async ({
  page,
}) => {
  const detail = { current: pullRequest({ is_mine: false, author: 'someone' }) };
  await routePullRequest(page, detail);
  const sent: { path: string; body: unknown }[] = [];
  await page.route(/\/api\/repos\/r1\/pull-requests\/7\/(reviews|merge)$/, (route) => {
    sent.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ json: { data: {} } });
  });
  await openPullRequest(page);

  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name: 'Request changes' }).click();
  await page.getByRole('textbox', { name: 'What needs to change' }).fill('Guard the null cart too');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect
    .poll(() => sent)
    .toEqual([
      {
        path: '/api/repos/r1/pull-requests/7/reviews',
        body: { event: 'request_changes', body: 'Guard the null cart too' },
      },
    ]);

  detail.current = pullRequest({ is_mine: false, author: 'someone', review_state: 'approved', approved_by: ['lead'] });
  await page.reload();
  await expect(page.getByRole('region', { name: 'People' })).toContainText('lead');
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(page.getByText('Merge #7 on the host?')).toBeVisible();
  await page.getByRole('button', { name: 'Keep open' }).click();
  await expect(page.getByText('Merge #7 on the host?')).toHaveCount(0);
  expect(sent).toHaveLength(1);
});

test('Commits lists the branch’s commits newest first; conflicts show which files and hold Merge back', async ({
  page,
}) => {
  const detail = {
    current: pullRequest({
      is_mine: false,
      author: 'someone',
      review_state: 'approved',
      approved_by: ['lead'],
      commits: [
        {
          sha: 'aaaaaaa1111',
          message: 'Guard empty carts',
          author: 'someone',
          created_at: '2026-11-01T00:00:00Z',
          url: null,
        },
        {
          sha: 'bbbbbbb2222',
          message: 'Cover the null cart',
          author: 'someone',
          created_at: '2026-11-02T00:00:00Z',
          url: 'https://github.com/example/checkout-api/commit/bbbbbbb2222',
        },
      ],
      conflicts: { state: 'conflict', files: ['src/cart.ts'], checked_at: '2026-11-03T00:00:00Z' },
    }),
  };
  await routePullRequest(page, detail);
  await openPullRequest(page);

  const banner = page.getByRole('region', { name: 'Merge conflicts' });
  await expect(banner).toContainText('This pull request has conflicts');
  await expect(banner).toContainText('src/cart.ts');
  await expect(page.getByRole('region', { name: 'Merge readiness' })).toContainText('1 file conflicts');
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();

  await page.getByRole('tab', { name: /^Commits/ }).click();
  await expect(page.getByRole('region', { name: 'Commits' }).getByRole('listitem')).toHaveText([
    /Cover the null cart.*bbbbbbb/,
    /Guard empty carts.*aaaaaaa/,
  ]);
  await expect(page.getByRole('link', { name: 'bbbbbbb' })).toHaveAttribute(
    'href',
    'https://github.com/example/checkout-api/commit/bbbbbbb2222',
  );

  detail.current = { ...detail.current, conflicts: { state: 'clean', files: [], checked_at: '2026-11-03T00:00:00Z' } };
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Commits/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByRole('region', { name: 'Merge conflicts' })).toHaveCount(0);
});

const patch = (...rows: [string, string][]) => rows.map(([sign, text]) => ({ sign: sign as '+' | '-' | ' ', text }));

const CART = {
  name: 'src/cart.ts',
  additions: 1,
  deletions: 0,
  lines: patch(
    ['', ''],
    [' ', '@@ -10,2 +10,3 @@ export function checkout()'],
    [' ', 'const a = 1;'],
    [' ', 'const b = 2;'],
    ['+', 'if (!cart) return;'],
  ).slice(1),
};
const TAX = {
  name: 'src/tax.ts',
  additions: 2,
  deletions: 0,
  lines: [
    { sign: ' ' as const, text: '@@ -1,8 +1,10 @@' },
    ...Array.from({ length: 8 }, (_, at) => ({ sign: ' ' as const, text: `const t${at + 1} = ${at + 1};` })),
    { sign: '+' as const, text: 'const t9 = 9;' },
    { sign: '+' as const, text: 'const t10 = 10;' },
  ],
};

/** The hunk a Git host sends for a comment on `cart.ts` line 12. */
const CART_HUNK = '@@ -10,2 +10,3 @@ export function checkout()\n const a = 1;\n const b = 2;\n+if (!cart) return;';

test('Activity shows a thread as one card: state, place, the code, the comments, the actions; a resolved thread folds', async ({
  page,
}) => {
  const comments = COMMENTS.map((item) =>
    item.id === 'c1' ? { ...item, hunk: CART_HUNK } : item.id === 'c3' ? { ...item, outdated: true } : item,
  );
  await routePullRequest(page, { current: pullRequest({ files: [CART, TAX], comments }) });
  await openPullRequest(page);

  const card = thread(page, 'Guard the empty cart.');
  await expect(card).toContainText('open');
  await expect(card).toContainText('src/cart.ts · line 12');
  // The code the comment is on, its line marked, ahead of the comments.
  const code = card.getByRole('img', { name: 'The code this comment is on' });
  await expect(code).toContainText('@@ -10,2 +10,3 @@ export function checkout()');
  await expect(code).toContainText('12');
  await expect(code).toContainText('if (!cart) return;');
  await expect(card).not.toContainText('Outdated');
  await expect(card.getByText('Fixed in 33f8c2b2')).toBeVisible();

  // The host's own flag says the line is outdated; a host that gave no hunk shows no code.
  const flagged = thread(page, 'Name this rate.');
  await expect(flagged).toContainText('Outdated');
  await expect(flagged.getByRole('img', { name: 'The code this comment is on' })).toHaveCount(0);
  // Without the host's flag, a line the newest diff does not hold is outdated too.
  await expect(thread(page, 'Cache the rate lookup.')).toContainText('Outdated');
  // A general comment has no file and no code.
  await expect(thread(page, 'Nice work overall.')).toContainText('General comment');

  // A resolved thread starts folded to its header; a click opens it, and the choice stays through a reload.
  const resolved = thread(page, 'src/tax.ts · line 4');
  await expect(resolved).toContainText('resolved');
  await expect(resolved.getByText('Round the tax.')).toBeHidden();
  await resolved.getByRole('button', { name: /resolved/ }).click();
  await expect(resolved.getByText('Round the tax.')).toBeVisible();
  await page.reload();
  await expect(thread(page, 'src/tax.ts · line 4').getByText('Round the tax.')).toBeVisible();
});

test('the Activity filter narrows to open threads, resolved threads or the agent’s, and says when none match', async ({
  page,
}) => {
  await routePullRequest(page, { current: pullRequest({ files: [CART, TAX] }) });
  await openPullRequest(page);
  const list = page.getByRole('region', { name: 'Activity' }).getByRole('listitem');
  const filter = page.getByRole('combobox', { name: 'Filter the activity' });

  await expect(list).toHaveCount(5);
  await filter.selectOption({ label: 'Open threads' });
  await expect(list).toHaveCount(4);
  await filter.selectOption({ label: 'Resolved threads' });
  await expect(list).toHaveCount(1);
  await expect(list).toContainText('src/tax.ts · line 4');
  // The agent answered c3 and started c5.
  await filter.selectOption({ label: 'Agent only' });
  await expect(list).toHaveCount(2);
  await expect(list.first()).toContainText('Name this rate.');
  await expect(list.last()).toContainText('Cache the rate lookup.');

  await routePullRequest(page, { current: pullRequest({ comments: [] }) });
  await page.goto('about:blank');
  await openPullRequest(page);
  await expect(page.getByText('No comments yet. Open Files changed')).toBeVisible();
  await expect(page.getByText('No thread in this view.')).toHaveCount(0);
});

test('a thread’s Check reply and Address comment start a Round for that thread alone', async ({ page }) => {
  const detail = { current: pullRequest() };
  const posted = await routePullRequest(page, detail);
  await openPullRequest(page);

  // c1 has a reply that is not the agent's; c3's last comment is the agent's; c4 has no reply; the resolved c2 offers neither.
  await expect(thread(page, 'Guard the empty cart.').getByRole('button', { name: /Check reply/ })).toBeVisible();
  await expect(thread(page, 'Name this rate.').getByRole('button', { name: /Check reply/ })).toHaveCount(0);
  await expect(thread(page, 'Nice work overall.').getByRole('button', { name: /Check reply/ })).toHaveCount(0);
  await expect(thread(page, 'Name this rate.').getByRole('button', { name: /Address comment/ })).toBeVisible();
  await thread(page, 'src/tax.ts · line 4')
    .getByRole('button', { name: /resolved/ })
    .click();
  await expect(thread(page, 'src/tax.ts · line 4').getByRole('button', { name: 'Unresolve' })).toBeVisible();
  await expect(
    thread(page, 'src/tax.ts · line 4').getByRole('button', { name: /Address comment|Check reply/ }),
  ).toHaveCount(0);

  await thread(page, 'Guard the empty cart.')
    .getByRole('button', { name: /Check reply/ })
    .click();
  await expect.poll(() => posted).toEqual([{ path: ACTIONS, body: { action: 'check_replies', comment_ids: ['c1'] } }]);
  await expect(page).toHaveURL(/session=s-check_replies/);
});

test('Address comment on a thread sends that thread’s id', async ({ page }) => {
  const posted = await routePullRequest(page, { current: pullRequest() });
  await openPullRequest(page);
  await thread(page, 'Name this rate.')
    .getByRole('button', { name: /Address comment/ })
    .click();
  await expect
    .poll(() => posted)
    .toEqual([{ path: ACTIONS, body: { action: 'address_comments', comment_ids: ['c3'] } }]);
});

test('while the PR Session works, the thread buttons wait and say why; the rail’s buttons stay', async ({ page }) => {
  const detail = {
    current: pullRequest({ action_sessions: [actionSession('sa1', 'address_comments', 'working')] }),
  };
  await routePullRequest(page, detail);
  await openPullRequest(page);
  const card = thread(page, 'Guard the empty cart.');
  for (const name of [/Check reply/, /Address comment/]) {
    await expect(card.getByRole('button', { name })).toBeDisabled();
    await expect(card.getByRole('button', { name })).toHaveAttribute(
      'title',
      'The Session is working on this pull request',
    );
  }
  await expect(page.getByRole('button', { name: /^Check replies/ })).toBeEnabled();
});

test('Files changed has no rail; Overview and Commits bring it back', async ({ page }) => {
  await routePullRequest(page, { current: pullRequest({ files: [CART, TAX] }) });
  await openPullRequest(page);
  const rail = page.getByRole('complementary', { name: 'Decision' });
  await expect(rail).toBeVisible();
  await page.getByRole('tab', { name: /^Files changed/ }).click();
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
  await expect(rail).toHaveCount(0);
  await page.getByRole('tab', { name: /^Commits/ }).click();
  await expect(rail).toBeVisible();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(rail).toBeVisible();
});

test('the Comments menu counts unresolved threads, lists them and the resolved ones, and a row jumps to its thread', async ({
  page,
}) => {
  const comments = COMMENTS.map((item) => (item.id === 'c1' ? { ...item, hunk: CART_HUNK } : item));
  await routePullRequest(page, { current: pullRequest({ files: [CART, TAX], comments }) });
  await openPullRequest(page);
  await page.getByRole('tab', { name: /^Files changed/ }).click();
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await page.getByRole('button', { name: 'Expand all' }).click();

  await page.getByRole('button', { name: 'Comments (3 unresolved)' }).click();
  const unresolved = page.getByRole('region', { name: 'Unresolved Comments', exact: true });
  await expect(unresolved).toContainText('3');
  await expect(unresolved.getByRole('menuitem')).toHaveCount(3);
  await expect(unresolved.getByRole('menuitem').first()).toContainText('reviewer');
  await expect(unresolved.getByRole('menuitem').first()).toContainText('on cart.ts');
  await expect(unresolved.getByRole('menuitem').first()).toContainText('Guard the empty cart.');
  // The line the newest diff does not hold reads Outdated.
  await expect(unresolved.getByRole('menuitem').filter({ hasText: 'Cache the rate lookup.' })).toContainText(
    'Outdated',
  );
  // Resolved ones sit under their own fold.
  const resolved = page.getByRole('region', { name: 'Resolved Comments', exact: true });
  await expect(resolved).toContainText('1');
  await resolved.getByRole('button', { name: /Resolved Comments/ }).click();
  await expect(resolved.getByRole('menuitem')).toContainText('Round the tax.');

  // A row closes the menu and scrolls to that thread in the diff, which shows the comments and the actions.
  await unresolved.getByRole('menuitem').filter({ hasText: 'Name this rate.' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  const inDiff = page.locator('[data-thread="c3"]');
  await expect(inDiff).toBeInViewport();
  await expect(inDiff.getByRole('button', { name: /Address comment/ })).toBeVisible();
  // Under its line, a thread shows no code of its own.
  await expect(inDiff.getByRole('img', { name: 'The code this comment is on' })).toHaveCount(0);
});

test('Sort lists the files as a tree or by their newest comment, and the choice stays', async ({ page }) => {
  const other = { ...CART, name: 'a/b.ts' };
  const readme = { ...CART, name: 'README.md' };
  const comments = COMMENTS.map((item) =>
    item.id === 'c3r' ? { ...item, created_at: '2026-11-01T11:00:00.000Z' } : item,
  );
  await routePullRequest(page, { current: pullRequest({ files: [readme, CART, TAX, other], comments }) });
  await openPullRequest(page);
  await page.getByRole('tab', { name: /^Files changed/ }).click();
  const names = () =>
    page
      .getByRole('region', { name: 'Files' })
      .locator(':scope > section')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));

  // Folders first, then files, each A to Z.
  await expect.poll(names).toEqual(['a/b.ts', 'src/cart.ts', 'src/tax.ts', 'README.md']);
  await page.getByRole('button', { name: 'Sort by File tree' }).click();
  await page.getByRole('menuitemradio', { name: 'Recent comments' }).click();
  // tax.ts has the newest comment, cart.ts the next; files with none follow in tree order.
  await expect.poll(names).toEqual(['src/tax.ts', 'src/cart.ts', 'a/b.ts', 'README.md']);
  await page.reload();
  await page.getByRole('tab', { name: /^Files changed/ }).click();
  await expect(page.getByRole('button', { name: 'Sort by Recent comments' })).toBeVisible();
  await expect.poll(names).toEqual(['src/tax.ts', 'src/cart.ts', 'a/b.ts', 'README.md']);
});

test('the file tree shows each file’s +/− and unresolved threads, jumps to a file, and folds to a strip', async ({
  page,
}) => {
  const deep = { ...CART, name: 'lib/a/b/util.ts' };
  await routePullRequest(page, { current: pullRequest({ files: [CART, TAX, deep] }) });
  await openPullRequest(page);
  await page.getByRole('tab', { name: /^Files changed/ }).click();
  const tree = page.getByRole('navigation', { name: 'Files in this pull request' });
  // cart.ts has c1 and c5 open; tax.ts has c3 open and the resolved c2.
  await expect(tree.getByRole('button', { name: /^cart\.ts/ })).toContainText('2');
  await expect(tree.getByRole('button', { name: /^cart\.ts/ })).toContainText('+1');
  await expect(tree.getByRole('button', { name: /^tax\.ts/ })).toContainText('1');

  // A folder that holds only one folder reads as one row.
  await expect(tree.getByText('▾ lib/a/b')).toBeVisible();
  await tree.getByRole('button', { name: /^tax\.ts/ }).click();
  await expect(tree.getByRole('button', { name: /^tax\.ts/ })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('region', { name: 'src/tax.ts' })).toBeInViewport();

  await tree.getByRole('button', { name: 'Fold the file tree' }).click();
  await expect(tree).toHaveCount(0);
  await page.getByRole('button', { name: 'Open the file tree' }).click();
  await expect(tree).toBeVisible();
});

test('a thread in the diff has the same actions as in Activity', async ({ page }) => {
  const posted = await routePullRequest(page, { current: pullRequest({ files: [CART, TAX] }) });
  await openPullRequest(page);
  await page.getByRole('tab', { name: /^Files changed/ }).click();
  const inDiff = page.locator('[data-thread="c1"]');
  await expect(inDiff.getByRole('button', { name: 'Resolve' })).toBeVisible();
  await expect(inDiff.getByRole('button', { name: 'Reply', exact: true })).toBeVisible();
  await inDiff.getByRole('button', { name: /Check reply/ }).click();
  await expect.poll(() => posted).toEqual([{ path: ACTIONS, body: { action: 'check_replies', comment_ids: ['c1'] } }]);
});
