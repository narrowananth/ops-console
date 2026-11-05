import { readFileSync } from 'node:fs';
import type { JobPlaybook, PlaybookStepStatus } from '@ops-console/shared';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-01T09:00:00.000Z';
const LATER = '2026-11-01T10:00:00.000Z';
const BUSY = 'The agent is working on this PR';
const PUSHED = '33f8c2b2a1d04e5f60718293a4b5c6d7e8f90a1b';

// The Git host and the agent are fakes in the daemon, so the pull request and its jobs answer with fixtures.

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

type Step = [title: string, status: `${PlaybookStepStatus}`, summary: string | null, writes?: boolean];

const playbook = (name: string, steps: Step[]): JobPlaybook => ({
  id: null,
  name,
  skills: [],
  steps: steps.map(([title, status, summary, writes = false]) => ({
    title,
    status: status as JobPlaybook['steps'][number]['status'],
    summary,
    writes,
    // A step that ran started at LATER; one that ended, ended then too.
    started_at: status === 'pending' || status === 'skipped' ? null : LATER,
    finished_at: status === 'pending' || status === 'running' ? null : LATER,
  })),
});

const replyCheck = (commentId: string, status: string, steps: Step[], extra: Record<string, unknown> = {}) => ({
  id: `rc-${commentId}`,
  repo_id: 'r1',
  pr_number: 7,
  comment_id: commentId,
  head_sha: '9c1e4b7d00000000000000000000000000000000',
  status,
  verdict: null,
  reply: null,
  resolved: false,
  error: null,
  can_retry: false,
  created_at: LATER,
  started_at: LATER,
  finished_at: status === 'running' ? null : LATER,
  playbook: playbook('Check reply (built-in)', steps),
  ...extra,
});

const passThread = (commentId: string, file: string, line: number, outcome: string, reply: string | null) => ({
  comment_id: commentId,
  file_path: file,
  line,
  author: 'reviewer',
  excerpt: 'Guard the empty cart.',
  outcome,
  reply,
  posted: outcome !== 'pending',
  resolved: outcome === 'done',
});

const commentPass = (id: string, status: string, steps: Step[], extra: Record<string, unknown> = {}) => ({
  id,
  repo_id: 'r1',
  pr_number: 7,
  kind: 'address',
  head_sha: '9c1e4b7d00000000000000000000000000000000',
  status,
  commit_sha: null,
  threads: [passThread('c1', 'src/cart.ts', 12, 'pending', null)],
  error: null,
  can_retry: false,
  stale: false,
  created_at: LATER,
  started_at: LATER,
  finished_at: status === 'running' ? null : LATER,
  playbook: playbook('Address comments (built-in)', steps),
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
  reply_checks: [] as unknown[],
  comment_passes: [] as unknown[],
  ...extra,
});

type Posted = { path: string; body: unknown };

/**
 * Answers the pull request with `detail`, read on every request so a test can change it, and each job start or
 * retry with `answer`, recording what was sent.
 */
async function routePullRequest(
  page: Page,
  detail: { current: ReturnType<typeof pullRequest> },
  answer: (path: string) => { status: number; json: unknown } = () => ({ status: 202, json: { data: {} } }),
) {
  const posted: Posted[] = [];
  // No Playbook of the operator's on any Trigger, so every button names the built-in.
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route('**/api/repos/r1/pull-requests/7', (route) => route.fulfill({ json: { data: detail.current } }));
  await page.route(
    /\/api\/(repos\/r1\/pull-requests\/7\/(reply-checks|comment-passes|reply-check-passes)|(reply-checks|comment-passes)\/[\w-]+\/retry)$/,
    (route) => {
      const path = new URL(route.request().url()).pathname;
      posted.push({ path, body: route.request().postDataJSON() });
      return route.fulfill(answer(path));
    },
  );
  return posted;
}

const openPullRequest = (page: Page) => page.goto(`${daemon.url}/workspace?tab=pulls&pr=r1/7#token=${daemon.token}`);

const thread = (page: Page, text: string) =>
  page.getByRole('region', { name: 'Comments' }).getByRole('listitem').filter({ hasText: text });

test('Check replies sits at the top, checks every replied thread in one run, and shows each verdict', async ({
  page,
}) => {
  const detail = { current: pullRequest() };
  const pass = (status: string, threads: unknown[]) =>
    commentPass('cr1', status, [['Read the thread', status === 'running' ? 'running' : 'done', null]], {
      kind: 'check',
      threads,
      playbook: playbook('Check reply (built-in)', [
        ['Read the thread', status === 'running' ? 'running' : 'done', null],
      ]),
    });
  const posted = await routePullRequest(page, detail, () => {
    detail.current = {
      ...detail.current,
      comment_passes: [
        pass('running', [
          passThread('c1', 'src/cart.ts', 12, 'pending', null),
          passThread('c5', 'src/rates.ts', 3, 'pending', null),
        ]),
      ],
    };
    return { status: 202, json: { data: detail.current.comment_passes[0] } };
  });
  await openPullRequest(page);

  // No thread has its own button: one button at the top checks them all.
  await expect(page.getByRole('button', { name: 'Check reply', exact: true })).toHaveCount(0);
  const button = page.getByRole('button', { name: /^Check(ing)? replies/ });
  await expect(button).toHaveText('Check replies · 2');
  await expect(button).toHaveAttribute('title', /checks every open thread that has a reply, in one run/);

  await button.click();
  await expect.poll(() => posted).toEqual([{ path: '/api/repos/r1/pull-requests/7/reply-check-passes', body: null }]);
  await expect(button).toBeDisabled();
  await expect(button).toContainText('Checking replies…');
  const card = page.getByRole('region', { name: 'Comment pass' });
  await expect(card).toContainText('Check replies');
  await expect(card).toContainText('Give each thread its verdict');

  detail.current = {
    ...detail.current,
    comment_passes: [
      pass('ready', [
        { ...passThread('c1', 'src/cart.ts', 12, 'fixed', 'The empty cart returns early now.'), resolved: true },
        passThread('c5', 'src/rates.ts', 3, 'not_fixed', 'The lookup is not cached yet.'),
      ]),
    ],
  };
  await page.reload();
  const rows = card.getByRole('list', { name: 'Threads' }).getByRole('listitem');
  await expect(rows.nth(0)).toContainText('fixed');
  await expect(rows.nth(0)).toContainText('The empty cart returns early now.');
  await expect(rows.nth(1)).toContainText('not fixed');
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

test('a failed Reply check shows why and retries from the failed step, or only what was left after the steps', async ({
  page,
}) => {
  const detail = {
    current: pullRequest({
      reply_checks: [
        replyCheck(
          'c1',
          'failed',
          [
            ['Read the thread', 'done', 'The thread asks for a guard on an empty cart.'],
            ['Read the code now', 'failed', 'The head commit has no src/cart.ts.'],
          ],
          { error: 'Step 2 · Read the code now failed: The head commit has no src/cart.ts.', can_retry: true },
        ),
        replyCheck(
          'c5',
          'failed',
          [
            ['Read the thread', 'done', null],
            ['Read the code now', 'done', null],
          ],
          { error: 'Could not resolve the thread: the host refused.', can_retry: true },
        ),
      ],
    }),
  };
  const posted = await routePullRequest(page, detail);
  await openPullRequest(page);

  const strip = thread(page, 'Guard the empty cart.').getByRole('region', { name: 'Reply check' });
  await expect(strip).toContainText('Reply check failed');
  await expect(strip.getByRole('alert')).toHaveText(
    'Step 2 · Read the code now failed: The head commit has no src/cart.ts.',
  );
  await strip.getByRole('button', { name: 'Retry from step 2' }).click();
  await expect.poll(() => posted.map((post) => post.path)).toEqual(['/api/reply-checks/rc-c1/retry']);

  const resolveFailed = thread(page, 'Cache the rate lookup.').getByRole('region', { name: 'Reply check' });
  await expect(resolveFailed).toContainText('Could not resolve the thread: the host refused.');
  await resolveFailed.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect
    .poll(() => posted.map((post) => post.path))
    .toEqual(['/api/reply-checks/rc-c1/retry', '/api/reply-checks/rc-c5/retry']);
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
    // Agent Review shows on an open pull request only, so on a closed one wait on the files instead.
    const closed = 'state' in extra && extra.state === 'closed';
    await expect(page.getByRole('button', { name: 'Agent Review' })).toHaveCount(closed ? 0 : 1);
    await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Address comments' })).toHaveCount(shown ? 1 : 0);
    await page.unrouteAll();
    // The next goto differs only after the #, which would keep this page and its cached pull request.
    await page.goto('about:blank');
  }
});

test('Address comments lists every unresolved thread, general comments too, all ticked; Start sends the ticked ones, Cancel nothing', async ({
  page,
}) => {
  const detail = { current: pullRequest() };
  const posted = await routePullRequest(page, detail, () => {
    detail.current = {
      ...detail.current,
      comment_passes: [commentPass('cp1', 'running', [['Read the threads', 'running', null]])],
    };
    return { status: 202, json: { data: detail.current.comment_passes[0] } };
  });
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
    .toEqual([{ path: '/api/repos/r1/pull-requests/7/comment-passes', body: { comment_ids: ['c1', 'c4'] } }]);
  await expect(page.getByRole('region', { name: 'Comment pass' })).toContainText('Read the threads');
  await expect(page.getByRole('button', { name: 'Address comments' })).toBeDisabled();
});

test('the Comment pass card shows its Playbook, steps, commit and each thread, folds older passes and retries', async ({
  page,
}) => {
  const done: Step[] = [
    ['Read the threads', 'done', 'Two threads; one asks for a rename the code already has.'],
    ['Make the changes', 'done', 'Guarded the empty cart in src/cart.ts.', true],
    ['Run the tests', 'done', '42 tests pass.', true],
  ];
  const detail = {
    current: pullRequest({
      comment_passes: [
        commentPass('cp2', 'ready', done, {
          commit_sha: PUSHED,
          stale: true,
          threads: [
            passThread('c1', 'src/cart.ts', 12, 'done', 'Guarded the empty cart in 33f8c2b.'),
            passThread('c3', 'src/tax.ts', 9, 'declined', 'The rate is already named TAX_RATE.'),
          ],
        }),
        commentPass(
          'cp1',
          'failed',
          [
            ['Read the threads', 'done', null],
            ['Make the changes', 'failed', 'src/cart.ts is not in this commit.', true],
            ['Run the tests', 'pending', null, true],
          ],
          { error: 'Step 2 · Make the changes failed: src/cart.ts is not in this commit.', can_retry: true },
        ),
      ],
    }),
  };
  const posted = await routePullRequest(page, detail);
  await openPullRequest(page);

  const card = page.getByRole('region', { name: 'Comment pass' });
  await expect(card).toContainText('Address comments (built-in)');
  await expect(card.getByRole('link', { name: '33f8c2b', exact: true })).toHaveAttribute(
    'href',
    `https://github.com/example/checkout-api/commit/${PUSHED}`,
  );
  await expect(card).toContainText('older commit');
  const steps = card.getByRole('list', { name: 'Playbook steps' }).first().getByRole('listitem');
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(1)).toContainText('Guarded the empty cart in src/cart.ts.');
  await expect(steps.nth(3)).toContainText('done or declined');
  const threads = card.getByRole('list', { name: 'Threads' }).first();
  await expect(threads.getByRole('listitem', { name: 'src/cart.ts:12' })).toContainText(
    /reviewer\s*done.*Guarded the empty cart in 33f8c2b\./,
  );
  await expect(threads.getByRole('listitem', { name: 'src/tax.ts:9' })).toContainText(
    /reviewer\s*declined.*The rate is already named TAX_RATE\./,
  );

  const older = card.getByRole('article');
  await expect(older).toBeHidden();
  await card.getByText('Older Comment passes · 1').click();
  await expect(older).toContainText('Step 2 · Make the changes failed: src/cart.ts is not in this commit.');
  await older.getByRole('button', { name: 'Retry from step 2' }).click();
  await expect.poll(() => posted.map((post) => post.path)).toEqual(['/api/comment-passes/cp1/retry']);
});

test('a Comment pass that failed after its steps retries what is left; one the branch moved under offers no Retry', async ({
  page,
}) => {
  const steps: Step[] = [['Read the threads', 'done', null]];
  const detail = {
    current: pullRequest({
      comment_passes: [
        commentPass('cp3', 'failed', steps, {
          commit_sha: PUSHED,
          error: 'Could not post a reply in src/cart.ts:12: the host refused.',
          can_retry: true,
          threads: [{ ...passThread('c1', 'src/cart.ts', 12, 'done', 'Guarded it.'), posted: false, resolved: false }],
        }),
      ],
    }),
  };
  const posted = await routePullRequest(page, detail);
  await openPullRequest(page);

  const card = page.getByRole('region', { name: 'Comment pass' });
  await expect(card.getByRole('listitem', { name: 'src/cart.ts:12' })).toContainText('reply not posted');
  // Every thread has its answer, so the failure is the console's push or post, not the agent's closing turn.
  const path = card.getByRole('list', { name: 'Playbook steps' }).getByRole('listitem');
  await expect(path.last()).toContainText('Report each thread done or declined');
  await expect(path.last()).not.toHaveAttribute('aria-current', 'step');
  await expect(card.getByRole('button', { name: /Skip step/ })).toHaveCount(0);
  await card.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => posted.map((post) => post.path)).toEqual(['/api/comment-passes/cp3/retry']);

  detail.current = pullRequest({
    comment_passes: [
      commentPass('cp4', 'failed', steps, { error: 'The branch moved; run Address comments again.', can_retry: false }),
    ],
  });
  await page.reload();
  await expect(card).toContainText('The branch moved; run Address comments again.');
  await expect(card.getByRole('button', { name: /Retry/ })).toHaveCount(0);
});

test('while a job runs, Review with agent, Check replies and Address comments wait, and a refused start says why', async ({
  page,
}) => {
  const detail = {
    current: pullRequest({
      comment_passes: [commentPass('cp1', 'running', [['Read the threads', 'running', null]])],
    }),
  };
  await routePullRequest(page, detail, (path) =>
    path.endsWith('/reply-check-passes')
      ? { status: 409, json: { error: { code: 'session_busy', message: BUSY } } }
      : { status: 502, json: { error: { code: 'upstream_failed', message: 'GitHub did not answer.' } } },
  );
  await openPullRequest(page);

  const buttons = [
    page.getByRole('button', { name: 'Agent Review' }),
    page.getByRole('button', { name: 'Address comments' }),
    page.getByRole('button', { name: /^Check replies/ }),
  ];
  for (const button of buttons) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', BUSY);
  }

  // The job finished here, but another tab started one the page has not heard of yet.
  detail.current = pullRequest();
  await page.reload();
  for (const button of buttons) await expect(button).toBeEnabled();
  await page.getByRole('button', { name: /^Check replies/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: BUSY })).toBeVisible();

  await page.getByRole('button', { name: 'Address comments' }).click();
  await page.getByRole('alertdialog', { name: 'Address comments' }).getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'GitHub did not answer.' })).toBeVisible();
});

test('a reload mid-run brings back the Reply check strip and the Comment pass card with each step', async ({
  page,
}) => {
  const detail = {
    current: pullRequest({
      reply_checks: [replyCheck('c5', 'running', [['Read the thread', 'done', 'It asks for a cache.']])],
      comment_passes: [
        commentPass('cp1', 'running', [
          ['Read the threads', 'done', 'One thread.'],
          ['Make the changes', 'running', null, true],
        ]),
      ],
    }),
  };
  await routePullRequest(page, detail);
  await openPullRequest(page);
  for (const pass of [1, 2]) {
    const strip = thread(page, 'Cache the rate lookup.').getByRole('region', { name: 'Reply check' });
    await expect(strip.getByRole('listitem').first(), `pass ${pass}`).toContainText('It asks for a cache.');
    await expect(strip.getByRole('listitem').nth(1)).toHaveAttribute('aria-current', 'step');
    const card = page.getByRole('region', { name: 'Comment pass' });
    await expect(card.getByRole('listitem').nth(1)).toHaveAttribute('aria-current', 'step');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    await page.reload();
  }
});

test('a running Reply check and Comment pass each stop the pull request’s Session run; a failed one shows no Stop', async ({
  page,
}) => {
  const detail = {
    current: pullRequest({
      agent_session_id: 'sp7',
      reply_checks: [replyCheck('c5', 'running', [['Read the thread', 'running', null]])],
      comment_passes: [commentPass('cp1', 'running', [['Read the threads', 'running', null]])],
    }),
  };
  await routePullRequest(page, detail);
  const stopped: string[] = [];
  await page.route('**/api/sessions/*/stop', (route) => {
    stopped.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 204 });
  });
  await openPullRequest(page);

  const strip = thread(page, 'Cache the rate lookup.').getByRole('region', { name: 'Reply check' });
  await strip.getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => stopped).toEqual(['/api/sessions/sp7/stop']);
  const card = page.getByRole('region', { name: 'Comment pass' });
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => stopped).toEqual(['/api/sessions/sp7/stop', '/api/sessions/sp7/stop']);

  detail.current = pullRequest({
    agent_session_id: 'sp7',
    reply_checks: [replyCheck('c5', 'failed', [['Read the thread', 'failed', 'stopped by the operator']])],
    comment_passes: [commentPass('cp1', 'failed', [['Read the threads', 'failed', 'stopped by the operator']])],
  });
  await page.reload();
  await expect(card).toContainText('failed');
  await expect(card.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(strip.getByRole('button', { name: 'Stop' })).toHaveCount(0);
});

test('Skip step on a failed Comment pass and a failed Agent Review sends the retry with skip; the review says why it failed', async ({
  page,
}) => {
  const detail = {
    current: pullRequest({
      latest_agent_review: {
        id: 'ar1',
        repo_id: 'r1',
        pr_number: 7,
        head_sha: '9c1e4b7d00000000000000000000000000000000',
        status: 'failed',
        decision: null,
        verdict: null,
        base_branch: null,
        base_sha: null,
        report: null,
        error: 'Step 1 · Read the change failed: the diff would not load',
        findings: [],
        checklist: [],
        tools: [],
        created_at: LATER,
        started_at: LATER,
        finished_at: LATER,
        stale: false,
        playbook: playbook('Review PR (built-in)', [['Read the change', 'failed', 'the diff would not load']]),
        note: null,
      },
      comment_passes: [
        commentPass(
          'cp5',
          'failed',
          [
            ['Read the threads', 'done', 'One thread.'],
            ['Make the changes', 'done', 'Guarded it.', true],
            ['Run the tests', 'failed', 'no test runner', true],
          ],
          { error: 'Step 3 · Run the tests failed: no test runner', can_retry: true },
        ),
      ],
    }),
  };
  const posted = await routePullRequest(page, detail);
  const reviews: unknown[] = [];
  await page.route('**/api/agent-reviews/ar1/retry', (route) => {
    reviews.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { data: detail.current.latest_agent_review } });
  });
  await openPullRequest(page);

  const card = page.getByRole('region', { name: 'Comment pass' });
  await card.getByRole('button', { name: 'Skip step 3' }).click();
  await expect.poll(() => posted).toEqual([{ path: '/api/comment-passes/cp5/retry', body: { skip: true } }]);
  await card.getByRole('button', { name: 'Retry from step 3' }).click();
  await expect.poll(() => posted.at(-1)).toEqual({ path: '/api/comment-passes/cp5/retry', body: { skip: false } });

  const review = page.getByRole('region', { name: 'Agent Review' });
  await expect(review).toContainText(
    'The review did not finish: Step 1 · Read the change failed: the diff would not load.',
  );
  await review.getByRole('button', { name: 'Skip step 1' }).click();
  await expect.poll(() => reviews).toEqual([{ skip: true }]);
});

test('a running job counts up the time it has taken, each second; one that ended says how long it took', async ({
  page,
}) => {
  const started = new Date(Date.now() - 65_000).toISOString();
  const detail = {
    current: pullRequest({
      agent_session_id: 'sp7',
      comment_passes: [commentPass('cp1', 'running', [['Read the threads', 'running', null]], { started_at: started })],
    }),
  };
  await routePullRequest(page, detail);
  await openPullRequest(page);

  const card = page.getByRole('region', { name: 'Comment pass' });
  const timer = card.locator('header time').first();
  await expect(timer).toHaveText(/^1m 0[5-9]s$/);
  const first = await timer.textContent();
  await expect.poll(() => timer.textContent(), { timeout: 3_000 }).not.toBe(first);

  const ended = new Date(Date.parse(started) + 4 * 60_000 + 3_000).toISOString();
  detail.current = pullRequest({
    agent_session_id: 'sp7',
    comment_passes: [
      commentPass('cp1', 'ready', [['Read the threads', 'done', 'read']], { started_at: started, finished_at: ended }),
    ],
  });
  await page.reload();
  await expect(card.locator('time').first()).toHaveText('took 4m 03s');
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

  const files = page.getByRole('region', { name: 'Files' });
  await expect(files.getByText('export const srcats = 1;')).toBeVisible();
  await files.getByRole('button', { name: 'Collapse all' }).click();
  for (const name of ['srcats', 'srcbts', 'srccts'])
    await expect(files.getByText(`export const ${name} = 1;`)).toBeHidden();

  // A fold kept in the browser holds through a reload, and Expand all opens every file again.
  await page.reload();
  await expect(files.getByText('export const srcbts = 1;')).toBeHidden();
  await files.getByRole('button', { name: 'Expand all' }).click();
  for (const name of ['srcats', 'srcbts', 'srccts'])
    await expect(files.getByText(`export const ${name} = 1;`)).toBeVisible();
});

test('Agent Review opens a note dialog; Start sends the note, and an empty note sends none', async ({ page }) => {
  const detail = { current: pullRequest() };
  await routePullRequest(page, detail);
  const sent: unknown[] = [];
  await page.route('**/api/repos/r1/pull-requests/7/agent-reviews', (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { data: {} } });
  });
  await openPullRequest(page);

  await page.getByRole('button', { name: 'Agent Review' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Agent Review' });
  const field = dialog.getByRole('textbox', { name: 'Note for the agent' });
  await expect(field).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent).toEqual([]);

  await page.getByRole('button', { name: 'Agent Review' }).click();
  await field.fill('Continues #12; check the retry path');
  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect.poll(() => sent).toEqual([{ note: 'Continues #12; check the retry path' }]);

  await page.getByRole('button', { name: 'Agent Review' }).click();
  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toBeNull();
});
