import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-08T09:00:00.000Z';
const auth = { Authorization: `Bearer ${daemon.token}` };
const api = (path: string) => `${daemon.url}/api${path}`;

/** Every test starts with no pack installed, no Skill and no Playbook of the operator's. */
async function reset(request: APIRequestContext) {
  const playbooks = await request.get(api('/playbooks'), { headers: auth });
  const held = (await playbooks.json()) as { data: { items: { id: string; builtin: boolean }[] } };
  for (const playbook of held.data.items.filter((item) => !item.builtin)) {
    await request.delete(api(`/playbooks/${playbook.id}`), { headers: auth });
  }
  await request.delete(api('/skill-packs/caveman/install'), { headers: auth });
  await request.delete(api('/skill-packs/ops-console/install'), { headers: auth });
  const skills = await request.get(api('/skills'), { headers: auth });
  const list = (await skills.json()) as { data: { items: { id: string }[] } };
  for (const skill of list.data.items) await request.delete(api(`/skills/${skill.id}`), { headers: auth });
}

test.beforeEach(async ({ request }) => {
  await reset(request);
});

const openSkills = (page: Page, query = '') => page.goto(`${daemon.url}/skills${query}#token=${daemon.token}`);

test('Discover lists packs; Install makes the skills available, read in the pack and never listed in Yours', async ({
  page,
}) => {
  // Discover is the first tab and the page opens on it; New Skill belongs to Yours.
  await openSkills(page);
  await expect(page.getByRole('tab', { name: 'Discover' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '+ New Skill' })).toHaveCount(0);
  await expect(page.getByRole('tab').first()).toHaveText('Discover');
  await page.getByRole('tab', { name: 'Yours' }).click();
  await expect(page.getByText('No Skills yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: '+ New Skill' })).toBeVisible();
  // The tabs stay with no Skills; there is no empty-state card.
  await expect(page.getByRole('button', { name: 'Browse Discover' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Discover' }).click();

  const packs = page.getByRole('complementary', { name: 'Skill packs' });
  await expect(packs.getByRole('button', { name: /Caveman/ })).toContainText('9 skills');
  await expect(packs.getByRole('button', { name: /Ops Console/ })).toContainText('9 skills');
  await packs.getByRole('button', { name: /Ops Console/ }).click();
  const opsSkills = page.getByRole('list', { name: 'Ops Console skills' });
  for (const name of [
    'code-review',
    'commit-message',
    'grilling',
    'humanizer',
    'pr',
    'refactor',
    'retro',
    'ship',
    'spec',
  ]) {
    await expect(opsSkills.getByRole('button', { name: new RegExp(`^${name} `) })).toBeVisible();
  }

  await packs.getByRole('button', { name: /Caveman/ }).click();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByText('Uninstall removes all 9.')).toBeVisible();

  // The pack's skills are read in the pack, one at a time, read-only.
  const skills = page.getByRole('list', { name: 'Caveman skills' });
  await expect(skills.getByRole('listitem')).toHaveCount(9);
  await skills.getByRole('button', { name: /caveman-commit/ }).click();
  await expect(skills.getByText('Read-only')).toBeVisible();
  await expect(skills.getByRole('textbox')).toHaveCount(0);

  // Yours keeps only what the operator wrote.
  await page.getByRole('tab', { name: 'Yours' }).click();
  await expect(page.getByText('No Skills yet.')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Skills', exact: true }).getByText('caveman')).toHaveCount(0);
});

test('a link to a pack skill opens it in its pack; Uninstall asks, names the Playbooks, and removes them all', async ({
  page,
  request,
}) => {
  await request.post(api('/skill-packs/caveman/install'), { headers: auth });
  await request.post(api('/playbooks'), {
    headers: auth,
    data: { name: 'Holder', skill_ids: ['builtin:caveman/caveman-commit'] },
  });
  await openSkills(page, '?skill=builtin%3Acaveman%2Fcaveman-commit');
  const skills = page.getByRole('list', { name: 'Caveman skills' });
  await expect(skills.getByRole('button', { name: /caveman-commit/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(skills).toContainText('Held by Holder');

  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Holder');
  await expect(dialog).toContainText('All 9 skills');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Uninstall' }).click();
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
  const playbooks = (await (await request.get(api('/playbooks'), { headers: auth })).json()) as {
    data: { items: { name: string; skills: unknown[] }[] };
  };
  expect(playbooks.data.items.find((item) => item.name === 'Holder')?.skills).toEqual([]);
});

test('a Playbook picker offers pack and Custom skills with their badges', async ({ page, request }) => {
  await request.post(api('/skill-packs/caveman/install'), { headers: auth });
  await request.post(api('/skills'), {
    headers: auth,
    data: { name: 'my-method', description: 'Mine.', instructions: 'Steps.' },
  });
  const made = await request.post(api('/playbooks'), { headers: auth, data: { name: 'Picks' } });
  const id = ((await made.json()) as { data: { id: string } }).data.id;
  await page.goto(`${daemon.url}/playbooks?playbook=${id}#token=${daemon.token}`);
  const editor = page.getByRole('region', { name: 'Playbook', exact: true });
  await editor.getByRole('button', { name: 'Skills', exact: true }).click();
  const skills = editor.getByRole('complementary', { name: 'Skills panel' });
  await skills.getByRole('button', { name: '+ Add a Skill' }).click();
  await expect(skills.getByRole('button', { name: /^caveman-commit/ })).toContainText('Caveman');
  await expect(skills.getByRole('button', { name: /^my-method/ })).toContainText('Custom');
  await skills.getByRole('button', { name: /^caveman-commit/ }).click();
  await skills.getByRole('button', { name: '+ Add a Skill' }).click();
  await skills.getByRole('button', { name: /^my-method/ }).click();
  await expect(skills.getByRole('listitem')).toHaveCount(2);
});

const REPO = {
  id: 'r1',
  name: 'checkout-api',
  path: '/work/checkout-api',
  host: 'github',
  remote_slug: 'example/checkout-api',
  origin_slug: null,
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
  title: 'Fix the tax rule',
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'auto',
  account_id: null,
  repo_id: 'r1',
  branch: 'main',
  pr_number: null,
  connection_ids: null,
  extra_repo_ids: [],
  pull_request: null,
  pull_requests: [],
  alert_id: null,
  state: 'idle',
  last_message_preview: null,
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
  spawned_by: null,
  spawned: [],
  subagents: [],
};

const MENU = [
  { kind: 'builtin', name: 'caveman-commit', description: 'Conventional Commits, intent only', pack: 'caveman' },
  { kind: 'builtin', name: 'ship', description: 'Spec to committed branch and PR body', pack: 'ops-console' },
  { kind: 'project', name: 'code-review', description: 'Review the changes since a fixed point', pack: null },
  { kind: 'custom', name: 'pr-body-style', description: 'Use when writing a pull request description', pack: null },
];

const FILES = [
  { path: 'src/orders/retry.ts', name: 'retry.ts', dir: 'src/orders', repo: null },
  { path: 'src/webhook.ts', name: 'webhook.ts', dir: 'src', repo: null },
];

async function mockSession(page: Page, sent: unknown[], userText = '/caveman-commit only the tax fix') {
  await page.route(/\/api\/file-menu\?.*/, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    return route.fulfill({ json: { data: { items: FILES.filter((item) => item.path.includes(q)) } } });
  });
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [REPO], meta: { next_cursor: null } } }));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => route.fulfill({ json: { data: [SESSION] } }));
  await page.route(/\/api\/skill-menu\?.*/, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    const items = MENU.filter((item) => item.name.includes(q) || item.description.toLowerCase().includes(q));
    return route.fulfill({ json: { data: { items } } });
  });
  await page.route(/\/api\/sessions\/s1\/messages$/, (route) => {
    if (route.request().method() === 'POST') {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { data: { message_id: 'm9' } } });
    }
    return route.fulfill({
      json: {
        data: [
          {
            id: 'm1',
            role: 'user',
            status: 'done',
            created_at: NOW,
            parts: [{ kind: 'text', text: userText }],
            skill: { kind: 'builtin', name: 'caveman-commit' },
          },
          {
            id: 'm2',
            role: 'agent',
            status: 'done',
            created_at: NOW,
            parts: [{ kind: 'text', text: 'fix(tax): guard null' }],
          },
        ],
      },
    });
  });
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);
}

test('typing $ opens the skill menu; picking keeps the note, and Send names the skill', async ({ page }) => {
  const sent: unknown[] = [];
  await mockSession(page, sent);
  const box = page.getByRole('textbox', { name: 'Message' });
  const menu = page.getByRole('listbox', { name: 'Skills' });

  await box.click();
  await page.keyboard.type('$');
  await expect(menu.getByRole('option')).toHaveCount(4);
  await expect(menu.getByRole('option').nth(0)).toContainText('$caveman-commit');
  await expect(menu.getByRole('option', { name: /code-review/ })).toContainText('Project');
  await expect(menu.getByRole('option', { name: /pr-body-style/ })).toContainText('Custom');
  await expect(menu.getByRole('option', { name: /caveman-commit/ })).toContainText('Caveman');
  // A pack's skill says which pack it is from.
  await expect(menu.getByRole('option', { name: /ship/ })).toContainText('Ops Console');

  await page.keyboard.type('code');
  await expect(menu.getByRole('option').first()).toContainText('$code-review');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(menu.getByRole('option')).toHaveCount(4);
  await menu.getByRole('option', { name: /code-review/ }).click();
  await expect(menu).toHaveCount(0);
  await page.keyboard.type('the auth changes only');
  // The pick shows as the skill's display name; what is sent stays `$code-review`.
  await expect(box.locator('[data-mention]')).toHaveText('Code Review');
  await expect(box).toHaveText('Code Review the auth changes only');

  await page.keyboard.press('Enter');
  await expect
    .poll(() => sent)
    .toEqual([{ text: '$code-review the auth changes only', skill: { kind: 'project', name: 'code-review' } }]);
});

test('a menu with no match says so, and a plain message sends with no skill', async ({ page }) => {
  const sent: unknown[] = [];
  await mockSession(page, sent);
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.click();
  await page.keyboard.type('$zzz');
  await expect(page.getByRole('listbox', { name: 'Skills' })).toContainText('No skills match');
  await page.keyboard.press('Escape');
  await box.evaluate((node) => {
    node.textContent = '';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.keyboard.type('just a plain message');
  await page.keyboard.press('Enter');
  await expect.poll(() => sent).toEqual([{ text: 'just a plain message' }]);
});

test('typing / lists the Session commands, and picking one runs it', async ({ page }) => {
  await mockSession(page, []);
  const box = page.getByRole('textbox', { name: 'Message' });
  const commands = page.getByRole('listbox', { name: 'Commands' });
  await box.click();
  await page.keyboard.type('/');
  await expect(commands.getByRole('option').first()).toContainText('/skills');
  await page.keyboard.type('zzz');
  await expect(commands).toContainText('No commands match');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  // The skills command hands over to the $ menu.
  await commands.getByRole('option', { name: /skills/ }).click();
  await expect(page.getByRole('listbox', { name: 'Skills' }).getByRole('option')).toHaveCount(4);
});

test('typing @ searches files; picking puts the path in the message', async ({ page }) => {
  const sent: unknown[] = [];
  await mockSession(page, sent);
  const box = page.getByRole('textbox', { name: 'Message' });
  const files = page.getByRole('listbox', { name: 'Files' });
  await box.click();
  await page.keyboard.type('look at @re');
  await expect(files.getByRole('option')).toHaveCount(1);
  await expect(files.getByRole('option').first()).toContainText('retry.ts');
  await expect(files.getByRole('option').first()).toContainText('src/orders');
  await page.keyboard.press('Enter');
  await expect(files).toHaveCount(0);
  // The message shows the file's name, with its path in the tip; the agent gets the path.
  const chip = box.locator('[data-mention]');
  await expect(chip).toHaveText('retry.ts');
  await expect(chip).toHaveAttribute('title', 'src/orders/retry.ts');
  await expect(box).toHaveText('look at retry.ts');
  await expect(box).toHaveAttribute('aria-placeholder', 'Ask anything. @ files, $ skills, / commands');
  await page.keyboard.press('Enter');
  await expect.poll(() => sent).toEqual([{ text: 'look at @src/orders/retry.ts' }]);
});

test('a $, @ or / token opens its menu wherever it starts, and a pick replaces only that token', async ({ page }) => {
  const sent: unknown[] = [];
  await mockSession(page, sent);
  const box = page.getByRole('textbox', { name: 'Message' });
  const skills = page.getByRole('listbox', { name: 'Skills' });
  const files = page.getByRole('listbox', { name: 'Files' });
  const chips = box.locator('[data-mention]');
  await box.click();

  // After other text on the line.
  await page.keyboard.type('explain this and $cod');
  await expect(skills.getByRole('option')).toHaveCount(1);
  const optionId = await skills.getByRole('option').first().getAttribute('id');
  expect(optionId).toBeTruthy();
  await expect(box).toHaveAttribute('aria-activedescendant', optionId ?? '');
  await page.keyboard.press('Tab');
  await expect(skills).toHaveCount(0);
  await expect(chips).toHaveText(['Code Review']);
  // The caret is after the pick: typing goes on there.
  await page.keyboard.type('now');
  await expect(box).toHaveText('explain this and Code Review now');

  // After a newline, with a file mention in the same prompt.
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('$shi');
  await skills.getByRole('option', { name: /ship/ }).click();
  await page.keyboard.type('@web');
  await expect(files.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await page.keyboard.type('done');
  await expect(chips).toHaveText(['Code Review', 'Ship', 'webhook.ts']);

  // In front of text already there, with the caret before it.
  await box.evaluate((node) => {
    const range = document.createRange();
    range.setStart(node, 0);
    range.collapse(true);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  });
  await page.keyboard.type('$pr-b');
  await skills.getByRole('option', { name: /pr-body-style/ }).click();
  await expect(chips).toHaveText(['Pr Body Style', 'Code Review', 'Ship', 'webhook.ts']);
  await expect(box).toHaveText('Pr Body Style explain this and Code Review now\nShip webhook.ts done');

  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => sent)
    .toEqual([
      {
        text: '$pr-body-style explain this and $code-review now\n$ship @src/webhook.ts done',
        skill: { kind: 'custom', name: 'pr-body-style' },
      },
    ]);
});

test('a / command in the middle of a prompt runs and leaves the rest of the prompt alone', async ({ page }) => {
  await mockSession(page, []);
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.click();
  await page.keyboard.type('keep this /sk');
  await page
    .getByRole('listbox', { name: 'Commands' })
    .getByRole('option', { name: /skills/ })
    .click();
  await expect(page.getByRole('listbox', { name: 'Skills' }).getByRole('option')).toHaveCount(4);
  await expect(box).toHaveText('keep this $');
});

test('a chip goes as one unit: Backspace removes it, arrows step over it, and a copy pastes back as chips', async ({
  page,
}) => {
  await mockSession(page, []);
  const box = page.getByRole('textbox', { name: 'Message' });
  const chips = box.locator('[data-mention]');
  await box.click();
  await page.keyboard.type('$cod');
  await expect(page.getByRole('listbox', { name: 'Skills' }).getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(chips).toHaveCount(1);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('Z');
  await expect(box).toHaveText('ZCode Review');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Backspace');
  await expect(chips).toHaveCount(0);
  await expect(box).toHaveText('Z');

  // Copy writes the prompt as plain text and as the composer's own form; the own form comes back as chips.
  await box.evaluate((node) => {
    node.focus();
    document.execCommand('insertText', false, 'see ');
  });
  const copied = await box.evaluate((node) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'see $ship and @src/webhook.ts');
    data.setData('application/x-ops-console-composer', 'see $ship and @src/webhook.ts');
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return node.textContent;
  });
  expect(copied).toBe('Zsee see Ship and webhook.ts ');
  await expect(chips).toHaveText(['Ship', 'webhook.ts']);
  const written = await box.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    const data = new DataTransfer();
    node.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return [data.getData('text/plain'), data.getData('application/x-ops-console-composer')];
  });
  expect(written).toEqual(['Zsee see $ship and @src/webhook.ts ', 'Zsee see $ship and @src/webhook.ts ']);

  // Text from anywhere else stays text.
  await box.evaluate((node) => {
    node.replaceChildren();
    node.dispatchEvent(new Event('input', { bubbles: true }));
    const data = new DataTransfer();
    data.setData('text/plain', 'costs $ship money');
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(chips).toHaveCount(0);
  await expect(box).toHaveText('costs $ship money');
});

test('a sent message shows its $skill and @file as chips, with the path in the tip', async ({ page }) => {
  await mockSession(page, [], 'use $code-review on @/work/checkout-api/src/tax.ts please');
  const message = page.getByRole('listitem', { name: 'Your message' });
  await expect(message.locator('[data-mention]')).toHaveText(['Code Review', 'tax.ts']);
  await expect(message.locator('[data-mention]').nth(1)).toHaveAttribute('title', '/work/checkout-api/src/tax.ts');
  await expect(message).toContainText('use');
  await expect(message).toContainText('please');
  await expect(message).not.toContainText('/work/checkout-api');
});

test('a skill message shows its skill chip and that the Playbook was not used, after a reload', async ({ page }) => {
  await mockSession(page, []);
  const message = page.getByRole('listitem', { name: 'Your message' });
  await expect(message).toContainText('/caveman-commit');
  await expect(message).toContainText('Caveman');
  await expect(message).toContainText('Playbook not used for this message');
  await page.reload();
  await expect(page.getByRole('listitem', { name: 'Your message' })).toContainText(
    'Playbook not used for this message',
  );
});

test('undo and redo step over a picked chip', async ({ page }) => {
  await mockSession(page, []);
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.click();
  await page.keyboard.type('a $cod');
  await expect(page.getByRole('listbox', { name: 'Skills' }).getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(box.locator('[data-mention]')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(box.locator('[data-mention]')).toHaveCount(0);
  await expect(box).toHaveText('a $cod');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(box.locator('[data-mention]')).toHaveCount(1);
});
