import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-03T09:00:00.000Z';

const REPO = {
  id: 'r1',
  name: 'checkout-api',
  path: '/work/checkout-api',
  host: 'github',
  remote_slug: 'example/checkout-api',
  default_branch: 'main',
  created_at: NOW,
  branch: 'main',
  dirty: false,
  missing: false,
  session_count: 1,
};

const SESSION = {
  id: 's1',
  kind: 'repo',
  title: 'Fix the review account',
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'auto',
  account_id: null,
  repo_id: 'r1',
  branch: 'main',
  pr_number: null,
  connection_ids: null,
  extra_repo_ids: [],
  alert_id: null,
  state: 'waiting_input',
  last_message_preview: null,
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
};

const QUESTIONS = [
  {
    kind: 'question',
    text: 'How should I fix the missing data?',
    header: 'Fix approach',
    multi_select: false,
    options: [
      { label: 'SQL script', description: 'Idempotent, you run it' },
      { label: 'Auto-provision', description: 'The code creates it' },
    ],
  },
  {
    kind: 'question',
    text: 'Which stores?',
    header: 'Stores',
    multi_select: true,
    options: [
      { label: 'store-a', description: '' },
      { label: 'store-b', description: '' },
    ],
  },
];

test('the agent’s questions show one at a time with their options, and one message answers them all', async ({
  page,
}) => {
  const sent: unknown[] = [];
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [REPO], meta: { next_cursor: null } } }));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => route.fulfill({ json: { data: [SESSION] } }));
  await page.route(/\/api\/sessions\/s1\/messages$/, (route) => {
    if (route.request().method() === 'POST') {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { data: { id: 'm3' } } });
    }
    return route.fulfill({
      json: {
        data: [
          { id: 'm1', role: 'user', status: 'done', created_at: NOW, parts: [{ kind: 'text', text: 'Fix it' }] },
          { id: 'm2', role: 'agent', status: 'done', created_at: NOW, parts: QUESTIONS },
        ],
      },
    });
  });
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const panel = page.getByRole('region', { name: 'The agent asks' });
  await expect(panel.getByText('Fix approach')).toBeVisible();
  await expect(panel.getByText('Idempotent, you run it')).toBeVisible();
  await expect(panel.getByText('1 / 2')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Next' })).toBeDisabled();

  await panel.getByRole('radio', { name: /SQL script/ }).check();
  await expect(panel.getByText('2 / 2')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Send answers' })).toBeDisabled();

  await panel.getByRole('checkbox', { name: 'store-a' }).check();
  await panel.getByRole('checkbox', { name: 'store-b' }).check();
  await panel.getByRole('button', { name: 'Send answers' }).click();
  await expect
    .poll(() => sent)
    .toEqual([{ text: 'How should I fix the missing data?\n→ SQL script\n\nWhich stores?\n→ store-a, store-b' }]);
});
