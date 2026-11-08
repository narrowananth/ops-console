import { readFileSync } from 'node:fs';
import type { JobPlaybook, PlaybookStepStatus } from '@ops-console/shared';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
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
const FIND_OWNER: Step = {
  block: 'find_owner',
  title: 'Find the Repo that owns it',
  instructions: 'Name the Repo that holds the failing code.',
  writes: false,
};
const TRACE_LOG: Step = {
  block: 'trace_log',
  title: 'Trace the log through the code',
  instructions: 'Follow the log line back to the code that wrote it.',
  writes: false,
};

/** Every test starts with no Playbook of the operator's (the first install): each Trigger holds its built-in. */
async function reset(request: APIRequestContext) {
  const list = await request.get(`${daemon.url}/api/playbooks`, { headers: auth });
  const { data } = (await list.json()) as { data: { items: { id: string; builtin: boolean }[] } };
  for (const playbook of data.items.filter((item) => !item.builtin)) {
    await request.delete(`${daemon.url}/api/playbooks/${playbook.id}`, { headers: auth });
  }
}

async function make(
  request: APIRequestContext,
  name: string,
  steps: Step[] = [],
  rules = '',
  extra: Record<string, unknown> = {},
): Promise<string> {
  const made = await request.post(`${daemon.url}/api/playbooks`, {
    headers: auth,
    data: { name, rules, steps, ...extra },
  });
  return ((await made.json()) as { data: { id: string } }).data.id;
}

async function attach(request: APIRequestContext, trigger: string, id: string | null) {
  await request.put(`${daemon.url}/api/playbook-triggers/${trigger}`, { headers: auth, data: { playbook_id: id } });
}

async function makeSkill(request: APIRequestContext, name: string, description: string) {
  await request.post(`${daemon.url}/api/skills`, {
    headers: auth,
    data: { name, description, instructions: `Steps for ${name}.` },
  });
}

type Saved = {
  id: string;
  name: string;
  rules: string;
  branches: string;
  jira_ticket: boolean;
  steps: Step[];
  triggers: string[];
};

async function savedList(request: APIRequestContext): Promise<Saved[]> {
  const list = await request.get(`${daemon.url}/api/playbooks`, { headers: auth });
  return ((await list.json()) as { data: { items: Saved[] } }).data.items;
}

const saved = async (request: APIRequestContext, id: string) =>
  (await savedList(request)).find((item) => item.id === id);

const overview = (page: Page, query = '') => page.goto(`${daemon.url}/playbooks${query}#token=${daemon.token}`);
const open = (page: Page, id: string) => overview(page, `?playbook=${id}`);

const view = (page: Page) => {
  const editor = page.getByRole('region', { name: 'Playbook', exact: true });
  const canvas = editor.getByRole('region', { name: 'Flow', exact: true });
  return {
    triggers: page.getByRole('complementary', { name: 'Triggers', exact: true }),
    yours: page.getByRole('region', { name: 'Your Playbooks', exact: true }),
    editor,
    canvas,
    palette: page.getByRole('complementary', { name: 'Step blocks' }),
    menu: page.getByRole('menu', { name: 'Step blocks' }),
    steps: canvas.getByRole('button', { name: /^Step \d+$/ }),
    slots: canvas.getByRole('button', { name: 'Add a step here' }),
    addFirst: canvas.getByRole('button', { name: /Add the first step/ }),
    node: (name: string) => canvas.getByRole('button', { name, exact: true }),
    panel: (name: string) => editor.getByRole('complementary', { name: `${name} panel` }),
    confirm: page.getByRole('alertdialog'),
  };
};

/** The Trigger row on the overview, by its name. */
const row = (page: Page, trigger: string) =>
  view(page).triggers.getByRole('button', { name: new RegExp(`^${trigger} `) });

/** The Dropdown on a Trigger's run card picks `option`, given as the start of its name. */
async function pick(page: Page, trigger: string, option: string) {
  await page.getByRole('button', { name: `Playbook for ${trigger}` }).click();
  await page
    .getByRole('listbox', { name: `Playbook for ${trigger}` })
    .getByRole('option', { name: new RegExp(`^${option}`) })
    .click();
}

/** The flow shows these step titles in this order. */
async function expectTitles(page: Page, titles: string[]) {
  const { steps } = view(page);
  await expect(steps).toHaveCount(titles.length);
  for (const [index, title] of titles.entries()) {
    await expect(steps.nth(index).getByText(title, { exact: true })).toBeVisible();
  }
}

const sizeOf = async (node: Locator) => {
  const box = await node.boundingBox();
  return { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) };
};

test.beforeEach(async ({ request }) => {
  await reset(request);
});

// Overview

test('first install: the overview lists the seven Triggers under Monitor and Workspace, each on its built-in, with no Your Playbooks', async ({
  page,
}) => {
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Playbooks' }).click();
  const { triggers, yours } = view(page);

  await expect(triggers).toContainText(
    /Monitor.*Verify.*Fix.*Workspace.*Review PR.*Check reply.*Address comments.*Reply in thread.*Session message/,
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
    await expect(row(page, trigger)).toContainText('Built-in');
  }
  await expect(triggers.getByRole('region', { name: 'Monitor' }).getByRole('button')).toHaveCount(2);
  await expect(triggers.getByRole('region', { name: 'Workspace' }).getByRole('button')).toHaveCount(5);
  await expect(yours).toHaveCount(0);
  // Nothing to set up: the page opens on Verify's built-in, and the header holds New Playbook.
  await expect(row(page, 'Verify')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('region', { name: 'Verify', exact: true })).toContainText('Built-in · read only');
  await expect(page.getByRole('button', { name: '+ New Playbook' })).toBeEnabled();

  await row(page, 'Review PR').click();
  await expect(row(page, 'Review PR')).toHaveAttribute('aria-current', 'true');
  await expect(row(page, 'Verify')).not.toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('region', { name: 'Review PR', exact: true })).toBeVisible();
});

test('the address ?trigger= selects that Trigger on the overview', async ({ page }) => {
  await overview(page, '?trigger=check_reply');
  await expect(row(page, 'Check reply')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('region', { name: 'Check reply', exact: true })).toContainText('Check reply runs');
});

test("the preview shows the Trigger's blurb, JOB or CHAT, run card, flow and facts; a built-in adds its read only note", async ({
  page,
}) => {
  await overview(page);
  const verify = page.getByRole('region', { name: 'Verify', exact: true });
  await expect(verify.getByRole('heading', { name: 'Verify' })).toBeVisible();
  await expect(verify).toContainText('The agent follows the failure through the code');
  await expect(verify.getByText('JOB', { exact: true })).toBeVisible();
  await expect(verify).toContainText('Verify runs');
  await expect(verify).toContainText('Built-in · read only');
  await expect(verify).toContainText('8 steps');
  const flow = verify.getByRole('list', { name: 'Flow' });
  await expect(flow.getByRole('listitem').first()).toContainText('Verify');
  await expect(flow).toContainText('Investigate the Datadog logs');
  await expect(flow).toContainText('+3 more');
  await expect(flow).toContainText("Console's own turn: write the Report");
  for (const fact of ['Rules', 'Skills', 'Branch · Jira']) {
    await expect(verify.getByText(fact, { exact: true })).toBeVisible();
  }
  await expect(verify).toContainText('Jira ticket');
  await expect(verify).toContainText('The built-in is read only');
  await expect(verify).toContainText('+ New Playbook');

  await row(page, 'Session message').click();
  const chat = page.getByRole('region', { name: 'Session message', exact: true });
  await expect(chat.getByText('CHAT', { exact: true })).toBeVisible();
  await expect(chat).toContainText('rules only');
  await expect(chat).toContainText('Steps never run on a chat');
  await expect(chat.getByRole('list', { name: 'Flow' })).not.toContainText("Console's own turn");
});

test("a Trigger row names its Playbook as the operator's own, and the run card says Yours with Edit", async ({
  page,
  request,
}) => {
  const id = await make(request, 'Safe DB fix', [FIND_USERS, MOCK_DATA], 'Never write to PROD.', {
    branches: 'production',
    jira_ticket: true,
  });
  await attach(request, 'fix', id);
  await overview(page, '?trigger=fix');
  await expect(row(page, 'Fix')).toContainText('Safe DB fix');
  await expect(row(page, 'Verify')).toContainText('Built-in');
  const fix = page.getByRole('region', { name: 'Fix', exact: true });
  await expect(fix).toContainText('Safe DB fix');
  await expect(fix).toContainText('Yours');
  await expect(fix).toContainText('2 steps');
  await expect(fix.getByRole('list', { name: 'Flow' })).toContainText('Find who else uses it');
  await expect(fix).toContainText('Never write to PROD.');
  await expect(fix).toContainText('production · Jira ticket on');
  await expect(fix).not.toContainText('The built-in is read only');
  await fix.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(view(page).editor.getByRole('textbox', { name: 'Name' })).toHaveValue('Safe DB fix');
});

test('the dropdown attaches a Playbook to a Trigger on its built-in at once, a scratch copy step included', async ({
  page,
  request,
}) => {
  await make(request, 'Checkout deep check', [MOCK_DATA]);
  await overview(page);
  const { confirm, yours } = view(page);

  await pick(page, 'Verify', 'Checkout deep check');
  await expect(confirm).toHaveCount(0);
  await expect(row(page, 'Verify')).toContainText('Checkout deep check');
  await expect(yours.getByRole('button', { name: /^Checkout deep check/ })).toContainText('Verify');
  await expect
    .poll(async () => (await savedList(request)).find((p) => p.name === 'Checkout deep check')?.triggers)
    .toEqual(['verify']);
});

test('choosing a Playbook on a Trigger that holds another asks Replace? with Cancel focused', async ({
  page,
  request,
}) => {
  const held = await make(request, 'Checkout deep check');
  await make(request, 'Safe DB fix');
  await attach(request, 'verify', held);
  await overview(page);
  const { confirm, yours } = view(page);

  await pick(page, 'Verify', 'Safe DB fix');
  await expect(confirm).toContainText('Verify runs Checkout deep check. Replace it with Safe DB fix?');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(row(page, 'Verify')).toContainText('Checkout deep check');

  await pick(page, 'Verify', 'Safe DB fix');
  await confirm.getByRole('button', { name: 'Replace' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(row(page, 'Verify')).toContainText('Safe DB fix');
  await expect(yours.getByRole('button', { name: /^Checkout deep check/ })).toContainText('on no Trigger');
});

test('Built-in in the dropdown detaches the Playbook at once and the built-in returns', async ({ page, request }) => {
  const held = await make(request, 'Safe DB fix');
  await attach(request, 'verify', held);
  await overview(page);

  await pick(page, 'Verify', 'Built-in');
  await expect(view(page).confirm).toHaveCount(0);
  await expect(row(page, 'Verify')).toContainText('Built-in');
  await expect(page.getByRole('region', { name: 'Verify', exact: true })).toContainText('Built-in · read only');
  await expect(view(page).yours.getByRole('button', { name: /^Safe DB fix/ })).toContainText('on no Trigger');
  await expect.poll(async () => (await saved(request, held))?.triggers).toEqual([]);
});

test('choosing Built-in on a Trigger already on its built-in sends no request', async ({ page, request }) => {
  await make(request, 'Safe DB fix');
  const puts: string[] = [];
  await page.route('**/api/playbook-triggers/*', (route) => {
    if (route.request().method() === 'PUT') puts.push(new URL(route.request().url()).pathname);
    return route.continue();
  });
  await overview(page);

  await pick(page, 'Verify', 'Built-in');
  // A later attach on Fix proves the route counts requests: Verify sent none.
  await row(page, 'Fix').click();
  await pick(page, 'Fix', 'Safe DB fix');
  await expect(row(page, 'Fix')).toContainText('Safe DB fix');
  expect(puts).toEqual(['/api/playbook-triggers/fix']);
});

test('the dropdown lists Built-in first, then the Playbooks A to Z; Escape closes it', async ({ page, request }) => {
  await make(request, 'Safe DB fix');
  await make(request, 'Checkout deep check');
  await overview(page);
  await page.getByRole('button', { name: 'Playbook for Verify' }).click();
  const list = page.getByRole('listbox', { name: 'Playbook for Verify' });
  await expect(list.getByRole('option')).toHaveText([/^Built-in/, /^Checkout deep check/, /^Safe DB fix/]);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
});

test('a Playbook cannot be dragged onto a Trigger', async ({ page, request }) => {
  await make(request, 'Safe DB fix', [FIND_USERS]);
  await overview(page);
  const { yours } = view(page);
  await yours.getByRole('button', { name: /^Safe DB fix/ }).dragTo(row(page, 'Fix'));
  await expect(row(page, 'Fix')).toContainText('Built-in');
  await expect(yours.getByRole('button', { name: /^Safe DB fix/ })).toContainText('on no Trigger');
  expect((await savedList(request)).find((item) => item.name === 'Safe DB fix')?.triggers).toEqual([]);
});

test('Your Playbooks lists A to Z with the Triggers each runs or "on no Trigger"; a click opens the flow', async ({
  page,
  request,
}) => {
  const gamma = await make(request, 'Gamma checks');
  await make(request, 'beta checks');
  await make(request, 'Alpha checks');
  await attach(request, 'verify', gamma);
  await attach(request, 'fix', gamma);
  await overview(page);
  const { yours, editor } = view(page);

  await expect(yours.getByRole('button')).toHaveText([
    /^Alpha checks.*on no Trigger/,
    /^beta checks.*on no Trigger/,
    /^Gamma checks.*Verify.*Fix/,
  ]);
  await expect(yours.getByText('unsaved')).toHaveCount(0);
  await yours.getByRole('button', { name: /^beta checks/ }).click();
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('beta checks');
  expect(page.url()).toMatch(/playbook=[0-9a-f-]{36}/);
});

test('a Playbook with unsaved edits shows an unsaved pill in Your Playbooks and the dot on the Trigger that runs it', async ({
  page,
  request,
}) => {
  const id = await make(request, 'Safe DB fix', [], 'Read only.');
  await attach(request, 'fix', id);
  await open(page, id);
  const { editor, yours, node, panel } = view(page);
  await node('Rules').click();
  await panel('Rules').getByRole('textbox', { name: 'Rules' }).fill('Never write to PROD.');
  await expect(editor.getByText('Unsaved edits')).toBeVisible();

  await editor.getByRole('button', { name: '← All Playbooks' }).click();
  await expect(page).not.toHaveURL(/playbook=/);
  await expect(yours.getByRole('button', { name: /^Safe DB fix/ })).toContainText('unsaved');
  await expect(row(page, 'Fix').getByRole('img', { name: 'Unsaved edits' })).toBeVisible();
  await expect(row(page, 'Verify').getByRole('img', { name: 'Unsaved edits' })).toHaveCount(0);
});

test("an own Playbook's header has Delete but no Duplicate or Customize", async ({ page, request }) => {
  await open(page, await make(request, 'Safe DB fix', [FIND_USERS]));
  await expect(view(page).editor.getByRole('button', { name: 'Delete' })).toBeVisible();
  for (const absent of ['Duplicate', 'Customize']) {
    await expect(page.getByRole('button', { name: absent })).toHaveCount(0);
  }
});

test('Delete asks first and names the Triggers that go back to built-in; Cancel keeps the Playbook', async ({
  page,
  request,
}) => {
  const id = await make(request, 'Safe DB fix', [FIND_USERS]);
  await attach(request, 'fix', id);
  await attach(request, 'session_message', id);
  await open(page, id);
  const { editor, confirm } = view(page);

  await editor.getByRole('button', { name: 'Delete' }).click();
  await expect(confirm).toContainText('Delete Safe DB fix?');
  await expect(confirm).toContainText("Fix and Session message go back to built-in. This can't be undone.");
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(await saved(request, id)).toBeDefined();
});

test('confirming Delete removes the Playbook and its Triggers run their built-ins again', async ({ page, request }) => {
  const id = await make(request, 'Safe DB fix', [FIND_USERS]);
  await make(request, 'Checkout deep check');
  await attach(request, 'fix', id);
  await attach(request, 'session_message', id);
  await open(page, id);
  const { editor, confirm, yours } = view(page);

  await editor.getByRole('button', { name: 'Delete' }).click();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(yours.getByRole('button', { name: /^Safe DB fix/ })).toHaveCount(0);
  await expect(yours.getByRole('button', { name: /^Checkout deep check/ })).toBeVisible();
  await expect(row(page, 'Fix')).toContainText('Built-in');
  await expect(row(page, 'Session message')).toContainText('Built-in');
  expect(await saved(request, id)).toBeUndefined();
});

test('the page says while it reads Playbooks, and why it could not; Retry reads them again', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/playbooks', async (route) => {
    await held;
    await route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'the store is locked' } } });
  });
  await overview(page);
  await expect(page.getByText('Reading Playbooks…')).toBeVisible();
  release();
  // The query tries three more times before it gives up.
  await expect(page.getByText('Could not read Playbooks: the store is locked')).toBeVisible({ timeout: 15_000 });

  await page.unroute('**/api/playbooks');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(row(page, 'Verify')).toBeVisible();
  await expect(page.getByText('Could not read Playbooks')).toHaveCount(0);
});

// New Playbook

test('the New Playbook name stops at 60 characters and is unique whatever its case', async ({ page, request }) => {
  await make(request, 'Alpha checks');
  await overview(page);
  await page.getByRole('button', { name: '+ New Playbook' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'New Playbook' });
  const name = dialog.getByRole('textbox', { name: 'Name' });

  await name.fill('');
  await name.pressSequentially('n'.repeat(70));
  expect((await name.inputValue()).length).toBe(60);
  await name.fill('alpha CHECKS');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Another Playbook is named alpha CHECKS');
  expect((await savedList(request)).filter((item) => !item.id.startsWith('builtin:'))).toHaveLength(1);
});

test('a Blank New Playbook runs on no Trigger and opens on the Trigger panel', async ({ page }) => {
  await overview(page);
  const { editor, panel, yours, node, steps, addFirst } = view(page);
  await page.getByRole('button', { name: '+ New Playbook' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'New Playbook' });
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('New Playbook');
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await expect(dialog.getByRole('radio', { name: /^Blank/ })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: /^Copy of a built-in/ })).not.toBeChecked();
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Beta checks');
  await dialog.getByRole('button', { name: 'Create' }).click();

  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('Beta checks');
  await expect(panel('Trigger')).toContainText('Pick the Triggers that start this Playbook');
  await expect(node('Trigger')).toContainText('Runs on no Trigger yet');
  await expect(steps).toHaveCount(0);
  await expect(addFirst).toBeVisible();

  await editor.getByRole('button', { name: '← All Playbooks' }).click();
  await expect(yours.getByRole('button', { name: /^Beta checks/ })).toContainText('on no Trigger');
  for (const trigger of ['Verify', 'Fix', 'Session message']) {
    await expect(row(page, trigger)).toContainText('Built-in');
  }
});

test("Copy of a built-in starts with that built-in's rules and steps, holds no Skills and runs on no Trigger", async ({
  page,
  request,
}) => {
  await overview(page);
  const { editor, steps, panel, node } = view(page);
  await page.getByRole('button', { name: '+ New Playbook' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'New Playbook' });
  await dialog.getByRole('radio', { name: /^Copy of a built-in/ }).check();
  await dialog.getByRole('button', { name: 'Built-in to copy' }).click();
  await expect(dialog.getByRole('listbox', { name: 'Built-in to copy' }).getByRole('option')).toHaveText([
    /^Verify \(built-in\)/,
    /^Fix \(built-in\)/,
    /^Review PR \(built-in\)/,
    /^Check reply \(built-in\)/,
    /^Address comments \(built-in\)/,
    /^Reply in thread \(built-in\)/,
    /^Session message \(built-in\)/,
  ]);
  await dialog.getByRole('option', { name: /^Address comments \(built-in\)/ }).click();
  await dialog.getByRole('textbox', { name: 'Name' }).fill('My address pass');
  await dialog.getByRole('button', { name: 'Create' }).click();

  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('My address pass');
  const all = await savedList(request);
  const builtin = all.find((item) => item.id === 'builtin:address_comments');
  const copy = all.find((item) => item.name === 'My address pass');
  expect(copy).toMatchObject({ rules: builtin?.rules, steps: builtin?.steps, triggers: [] });
  expect(copy?.steps).toHaveLength(6);
  await expect(steps).toHaveCount(6);
  await expect(node('Trigger')).toContainText('Runs on no Trigger yet');
  await node('Skills').click();
  await expect(panel('Skills')).toContainText('None held.');
  await expect(row(page, 'Address comments')).toHaveCount(0);
});

// The flow

test('a built-in opens from View full flow with a banner, no palette and no action button', async ({ page }) => {
  await overview(page);
  await page.getByRole('button', { name: /^View full flow/ }).click();
  await expect(page).toHaveURL(/trigger=verify/);
  await expect(page).toHaveURL(/view=flow/);
  const { editor, palette, steps, node } = view(page);

  await expect(editor).toContainText('Built-in, read only.');
  await expect(palette).toHaveCount(0);
  await expect(editor.getByRole('button', { name: /^(Save|Discard|Delete|Duplicate|Customize|Copy)/ })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Add a step here' })).toHaveCount(0);
  await expect(node('Skills')).toContainText('A built-in holds none.');
  await expect(steps).toHaveCount(8);

  await editor.getByRole('button', { name: '← All Playbooks' }).click();
  await expect(page).not.toHaveURL(/view=flow/);
  await expect(row(page, 'Verify')).toHaveAttribute('aria-current', 'true');
});

test('every field of a built-in is read only, and Alt+arrow and Delete change nothing', async ({ page }) => {
  await overview(page, '?trigger=verify&view=flow');
  const { editor, steps, panel, node } = view(page);
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveAttribute('readonly', '');

  await steps.first().click();
  await expect(panel('Step').getByRole('textbox', { name: 'Step title' })).toHaveAttribute('readonly', '');
  await expect(panel('Step').getByRole('textbox', { name: 'Step instructions' })).toHaveAttribute('readonly', '');
  await expect(panel('Step').getByRole('button', { name: 'Remove' })).toHaveCount(0);
  const first = await steps.first().textContent();
  await steps.first().press('Alt+ArrowRight');
  await steps.first().press('Delete');
  await expect(steps).toHaveCount(8);
  expect(await steps.first().textContent()).toBe(first);

  await node('Settings').click();
  await expect(panel('Settings')).toContainText('Jira ticket');
  await expect(panel('Settings').getByRole('switch')).toHaveCount(0);
  await expect(page.locator('#playbook-branch')).toHaveCount(0);
});

test('?playbook=builtin:<trigger> and ?trigger=<id>&view=flow open the same built-in flow; its Trigger node names the Trigger', async ({
  page,
}) => {
  const { editor, node } = view(page);
  await overview(page, '?playbook=builtin:fix');
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue(/Fix/);
  await expect(editor).toContainText('Built-in, read only.');
  await expect(node('Trigger')).toContainText('Fix');

  await overview(page, '?trigger=review_pr&view=flow');
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue(/Review PR/);
  await expect(node('Trigger')).toContainText('Review PR');
});

test('a built-in names the Playbook that replaced it on its Trigger', async ({ page, request }) => {
  const id = await make(request, 'Safe DB fix');
  await attach(request, 'verify', id);
  await overview(page, '?trigger=verify&view=flow');
  await expect(view(page).editor).toContainText('Replaced on Verify by Safe DB fix.');
});

test("a Playbook opens as a flow: Trigger node, steps in order, the console's own turn last, and Rules, Skills and Settings above", async ({
  page,
  request,
}) => {
  const id = await make(request, 'Checkout deep check', [FIND_OWNER, MOCK_DATA], 'Read only.');
  await attach(request, 'verify', id);
  await open(page, id);
  const { canvas, steps, node, slots } = view(page);

  await expect(node('Trigger')).toContainText('Verify');
  await expectTitles(page, ['Find the Repo that owns it', 'Make mock data']);
  await expect(steps.nth(1)).toContainText('scratch copy');
  await expect(steps.first()).not.toContainText('scratch copy');
  await expect(canvas).toContainText("Console's own turn");
  await expect(canvas).toContainText('Verify: write the Report');
  await expect(canvas).toContainText('applies to every turn');
  await expect(node('Rules')).toContainText('Read only.');
  await expect(node('Rules')).toContainText('10 / 8000');
  await expect(node('Skills')).toContainText('0 / 8');
  await expect(node('Settings')).toContainText('Jira ticket off');
  await expect(slots).toHaveCount(3);

  // The context cards sit above the line of nodes.
  const rules = await node('Rules').boundingBox();
  const trigger = await node('Trigger').boundingBox();
  expect(rules && trigger && rules.y + rules.height < trigger.y).toBe(true);
});

test("each job Trigger's built-in flow closes with the console's own turn", async ({ page }) => {
  const { canvas } = view(page);
  for (const [trigger, line] of [
    ['verify', 'Verify: write the Report'],
    ['fix', 'Fix: commit, push and open the PR'],
    ['review_pr', 'Review PR: write findings, checklist and verdict'],
    ['check_reply', 'Check reply: give the verdict and the reply'],
    ['address_comments', 'Address comments: report each thread done or declined'],
  ] as const) {
    await overview(page, `?trigger=${trigger}&view=flow`);
    await expect(canvas).toContainText("Console's own turn");
    await expect(canvas).toContainText(line);
  }
});

test('a chat Trigger shows no closing turn, and says steps do not run there', async ({ page }) => {
  await overview(page, '?trigger=session_message&view=flow');
  await expect(view(page).canvas).not.toContainText("Console's own turn");
  await expect(view(page).canvas).toContainText("Steps don't run on chat Triggers");
});

test('a Playbook on chat Triggers only greys each step and keeps the rest of the flow at full strength', async ({
  page,
  request,
}) => {
  const id = await make(request, 'Chat only', [FIND_USERS, MOCK_DATA]);
  await attach(request, 'session_message', id);
  await open(page, id);
  const { canvas, steps, node } = view(page);

  await expect(canvas).toContainText("Steps don't run on chat Triggers");
  await expect(canvas).not.toContainText("Console's own turn");
  await expect(steps).toHaveCount(2);
  for (const index of [0, 1]) await expect(steps.nth(index)).toHaveCSS('opacity', '0.6');
  await expect(node('Trigger')).toHaveCSS('opacity', '1');
  await expect(node('Rules')).toHaveCSS('opacity', '1');
});

test("a job Trigger added to a chat-only Playbook un-greys its steps and adds that Trigger's closing turn", async ({
  page,
  request,
}) => {
  const id = await make(request, 'Chat only', [FIND_USERS]);
  await attach(request, 'session_message', id);
  await attach(request, 'verify', id);
  await open(page, id);
  const { canvas, steps, editor } = view(page);

  await expect(steps.first()).toHaveCSS('opacity', '1');
  await expect(canvas).toContainText('Verify: write the Report');
  await expect(editor).not.toContainText("Steps don't run on chat Triggers");
});

test('the line of nodes wraps to a new row at the canvas width', async ({ page, request }) => {
  await open(
    page,
    await make(
      request,
      'Twelve',
      Array.from({ length: 12 }, () => FIND_USERS),
    ),
  );
  const { steps } = view(page);
  await expect(steps).toHaveCount(12);
  const first = await steps.first().boundingBox();
  const last = await steps.last().boundingBox();
  expect(first && last && last.y > first.y).toBe(true);
});

test('a Playbook holds 12 steps, no more', async ({ page, request }) => {
  await open(
    page,
    await make(
      request,
      'Twelve',
      Array.from({ length: 12 }, () => FIND_USERS),
    ),
  );
  const { steps, palette, slots } = view(page);
  await expect(slots).toHaveCount(0);
  await expect(palette.getByRole('button', { name: 'Add Run the tests to steps' })).toBeDisabled();

  // One step fewer and the + slots and the palette take a step again.
  await steps.last().press('Delete');
  await expect(steps).toHaveCount(11);
  await expect(slots).toHaveCount(12);
  await expect(palette.getByRole('button', { name: 'Add Run the tests to steps' })).toBeEnabled();
});

test('a node opens its panel; the close button closes it', async ({ page, request }) => {
  const id = await make(request, 'Checkout deep check', [FIND_OWNER], 'Read only.');
  await open(page, id);
  const { panel, node } = view(page);

  for (const [name, kind, shows] of [
    ['Trigger', 'Trigger', 'Pick the Triggers that start this Playbook'],
    ['Step 1', 'Step', 'Runs as its own agent turn'],
    ['Rules', 'Rules', 'What the agent must always or never do'],
    ['Skills', 'Skills', 'What is a Skill?'],
    ['Settings', 'Settings', 'Where Verify and Fix read the code'],
  ] as const) {
    await node(name).click();
    await expect(panel(kind)).toContainText(shows);
    await panel(kind).getByRole('button', { name: 'Close' }).click();
    await expect(panel(kind)).toHaveCount(0);
  }
});

test('picking another node swaps the panel, and Escape on the node closes it', async ({ page, request }) => {
  await open(page, await make(request, 'Checkout deep check', [FIND_OWNER], 'Read only.'));
  const { panel, node } = view(page);
  await node('Rules').click();
  await expect(panel('Rules')).toBeVisible();
  await node('Skills').click();
  await expect(panel('Skills')).toBeVisible();
  await expect(panel('Rules')).toHaveCount(0);
  await node('Skills').press('Escape');
  await expect(panel('Skills')).toHaveCount(0);
});

test('the panel drags wider and narrower from its edge, keeps its width on another node and through a reload, and double click resets it', async ({
  page,
  request,
}) => {
  await open(page, await make(request, 'Checkout deep check', [FIND_OWNER], 'Read only.'));
  const { panel, node } = view(page);
  await node('Rules').click();
  const handle = page.getByRole('separator', { name: 'Resize the panel' });
  const width = async (kind: 'Rules' | 'Skills' = 'Rules') => Math.round((await panel(kind).boundingBox())?.width ?? 0);
  const start = Number(await handle.getAttribute('aria-valuenow'));
  expect(await width()).toBe(start);

  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', String(start + 32));
  expect(await width()).toBe(start + 32);

  const box = await handle.boundingBox();
  if (!box) throw new Error('the handle has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', String(start + 32 - 40));

  await node('Skills').click();
  expect(await width('Skills')).toBe(start + 32 - 40);
  await page.reload();
  await node('Skills').click();
  await expect(handle).toHaveAttribute('aria-valuenow', String(start + 32 - 40));

  await handle.dblclick();
  await expect(handle).toHaveAttribute('aria-valuenow', String(start));
});

test('the Rules and Step instructions boxes fill the height of the panel', async ({ page, request }) => {
  await open(page, await make(request, 'Checkout deep check', [FIND_OWNER], 'Read only.'));
  const { panel, node } = view(page);
  for (const [name, kind, box] of [
    ['Rules', 'Rules', 'Rules'],
    ['Step 1', 'Step', 'Step instructions'],
  ] as const) {
    await node(name).click();
    const aside = await panel(kind).boundingBox();
    const area = await panel(kind).getByRole('textbox', { name: box }).boundingBox();
    if (!aside || !area) throw new Error('missing box');
    // Only the Note, the Remove row and the panel's padding sit below the box.
    expect(aside.y + aside.height - (area.y + area.height)).toBeLessThan(120);
  }
});

test('Escape with the focus in the Rules textarea closes the panel', async ({ page, request }) => {
  await open(page, await make(request, 'Checkout deep check', [FIND_OWNER], 'Read only.'));
  const { panel, node } = view(page);
  await node('Rules').click();
  const rules = panel('Rules').getByRole('textbox', { name: 'Rules' });
  await rules.focus();
  await expect(rules).toBeFocused();
  await rules.press('Escape');
  await expect(panel('Rules')).toHaveCount(0);
});

test("the Trigger node's chips attach a Playbook to a Trigger and detach it, a scratch copy step included", async ({
  page,
  request,
}) => {
  const mine = await make(request, 'Checkout deep check', [MOCK_DATA]);
  await open(page, mine);
  const { panel, node } = view(page);
  const chip = panel('Trigger').getByRole('button', { name: /Review PR/ });
  const triggersOf = async () => (await saved(request, mine))?.triggers;

  await expect(node('Trigger')).toContainText('Runs on no Trigger yet');
  await node('Trigger').click();
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(node('Trigger')).toContainText('Review PR');
  await expect.poll(triggersOf).toEqual(['review_pr']);

  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(triggersOf).toEqual([]);
  await page.getByRole('button', { name: '← All Playbooks' }).click();
  await expect(row(page, 'Review PR')).toContainText('Built-in');
});

test('a chip for a Trigger that another Playbook holds asks Replace first', async ({ page, request }) => {
  const mine = await make(request, 'Checkout deep check', [MOCK_DATA]);
  const other = await make(request, 'Safe DB fix', [FIND_USERS]);
  await attach(request, 'verify', other);
  await open(page, mine);
  const { panel, confirm, node } = view(page);
  const chip = panel('Trigger').getByRole('button', { name: /Verify/ });

  await node('Trigger').click();
  await expect(chip).toContainText('Safe DB fix');
  await chip.click();
  await expect(confirm).toContainText('Verify runs Safe DB fix. Replace it with Checkout deep check?');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(chip).toHaveAttribute('aria-pressed', 'false');

  await chip.click();
  await confirm.getByRole('button', { name: 'Replace' }).click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await saved(request, mine))?.triggers).toEqual(['verify']);
  expect((await saved(request, other))?.triggers).toEqual([]);
});

// Editing

test("the palette lists the ten Step blocks, and + appends a copy that is the operator's to edit", async ({
  page,
  request,
}) => {
  const id = await make(request, 'Checkout deep check');
  await open(page, id);
  const { palette, editor, steps, panel } = view(page);

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
  const items = palette.getByRole('listitem');
  await expect(items).toHaveCount(10);
  for (const [index, title] of titles.entries()) await expect(items.nth(index)).toHaveAttribute('aria-label', title);
  await expect(palette.getByRole('listitem', { name: 'Make mock data' })).toContainText('scratch copy');
  await expect(palette.getByRole('listitem', { name: 'Find who else uses it' })).not.toContainText('scratch copy');

  await palette.getByRole('button', { name: 'Add Find the Repo that owns it to steps' }).click();
  await palette.getByRole('button', { name: 'Add Make mock data to steps' }).click();
  await expectTitles(page, ['Find the Repo that owns it', 'Make mock data']);
  await expect(steps.nth(1)).toContainText('scratch copy');

  await steps.first().click();
  await panel('Step').getByRole('textbox', { name: 'Step title' }).fill('Find the real owner');
  await expectTitles(page, ['Find the real owner', 'Make mock data']);
  // The block itself is untouched.
  await expect(palette.getByRole('listitem', { name: 'Find the Repo that owns it' })).toBeVisible();
  await expect(editor.getByText('Unsaved edits')).toBeVisible();
});

test('with no step the Add the first step node opens the Step blocks menu and inserts there', async ({
  page,
  request,
}) => {
  await open(page, await make(request, 'Checkout deep check'));
  const { menu, addFirst } = view(page);

  await addFirst.click();
  await expect(menu.getByRole('menuitem')).toHaveCount(10);
  await menu.getByRole('menuitem', { name: /^Find who else uses it/ }).click();
  await expect(menu).toHaveCount(0);
  await expectTitles(page, ['Find who else uses it']);
  await expect(addFirst).toHaveCount(0);
});

test('a + slot on the line opens the Step blocks menu and inserts at that point; Escape closes the menu', async ({
  page,
  request,
}) => {
  await open(page, await make(request, 'Checkout deep check', [FIND_USERS]));
  const { menu, slots, steps } = view(page);

  // The slot right after the Trigger puts the step first; the one after the last step puts it last.
  await slots.first().click();
  await menu.getByRole('menuitem', { name: /^Trace the log through the code/ }).click();
  await slots.last().click();
  await menu.getByRole('menuitem', { name: /^Run the tests/ }).click();
  await expectTitles(page, ['Trace the log through the code', 'Find who else uses it', 'Run the tests']);

  await slots.nth(1).click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(steps).toHaveCount(3);
});

test('dragging a block onto a line of the flow inserts a copy at that point', async ({ page, request }) => {
  await open(page, await make(request, 'Checkout deep check', [FIND_OWNER, MOCK_DATA]));
  const { palette, slots } = view(page);

  // The slots sit before step 1, between the two steps, and after step 2.
  await palette.getByRole('listitem', { name: 'Trace the log through the code' }).dragTo(slots.first());
  await expectTitles(page, ['Trace the log through the code', 'Find the Repo that owns it', 'Make mock data']);
  await palette.getByRole('listitem', { name: 'Run the tests' }).dragTo(slots.nth(2));
  await expectTitles(page, [
    'Trace the log through the code',
    'Find the Repo that owns it',
    'Run the tests',
    'Make mock data',
  ]);
  await palette.getByRole('listitem', { name: 'Find who else uses it' }).dragTo(slots.last());
  await expectTitles(page, [
    'Trace the log through the code',
    'Find the Repo that owns it',
    'Run the tests',
    'Make mock data',
    'Find who else uses it',
  ]);
});

test('a step dragged to another slot moves', async ({ page, request }) => {
  await open(page, await make(request, 'Checkout deep check', [TRACE_LOG, FIND_OWNER, FIND_USERS]));
  const { steps, slots } = view(page);

  // Dropped on the slot after the last step, the first step goes last.
  await steps.first().dragTo(slots.last());
  await expectTitles(page, ['Find the Repo that owns it', 'Find who else uses it', 'Trace the log through the code']);
  // Dropped on the slot before the first, the last step comes first.
  await steps.last().dragTo(slots.first());
  await expectTitles(page, ['Trace the log through the code', 'Find the Repo that owns it', 'Find who else uses it']);
});

test('a step dropped on blank canvas inside the flow area stays', async ({ page, request }) => {
  await open(page, await make(request, 'Checkout deep check', [TRACE_LOG]));
  const { steps, canvas } = view(page);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('the flow has no box');

  await steps.first().dragTo(canvas, { targetPosition: { x: 24, y: box.height - 24 } });
  await expectTitles(page, ['Trace the log through the code']);
});

test('a step dropped outside the canvas is removed', async ({ page, request }) => {
  await open(page, await make(request, 'Checkout deep check', [TRACE_LOG, FIND_OWNER]));
  await view(page).steps.nth(1).dragTo(view(page).palette);
  await expectTitles(page, ['Trace the log through the code']);
});

test('Alt+arrows move a focused step one place and it keeps the focus', async ({ page, request }) => {
  await open(page, await make(request, 'Checkout deep check', [TRACE_LOG, FIND_OWNER, FIND_USERS]));
  const { steps, palette } = view(page);
  await expect(palette).toContainText('Alt+←/→ moves it and Delete removes it');

  await steps.first().focus();
  await steps.first().press('Alt+ArrowRight');
  await expectTitles(page, ['Find the Repo that owns it', 'Trace the log through the code', 'Find who else uses it']);
  await expect(steps.nth(1)).toBeFocused();
  await page.keyboard.press('Alt+ArrowRight');
  await expectTitles(page, ['Find the Repo that owns it', 'Find who else uses it', 'Trace the log through the code']);
  // The last step cannot go further right.
  await page.keyboard.press('Alt+ArrowRight');
  await expectTitles(page, ['Find the Repo that owns it', 'Find who else uses it', 'Trace the log through the code']);
  await steps.last().press('Alt+ArrowLeft');
  await expectTitles(page, ['Find the Repo that owns it', 'Trace the log through the code', 'Find who else uses it']);
});

test('Delete removes a focused step and closes its panel', async ({ page, request }) => {
  await open(page, await make(request, 'Checkout deep check', [TRACE_LOG, FIND_OWNER, FIND_USERS]));
  const { steps, panel } = view(page);
  await steps.nth(1).click();
  await expect(panel('Step')).toBeVisible();
  await steps.nth(1).press('Delete');
  await expectTitles(page, ['Trace the log through the code', 'Find who else uses it']);
  await expect(panel('Step')).toHaveCount(0);
});

test('the step panel keeps no Earlier, Later, Move up or Move down buttons', async ({ page, request }) => {
  await open(page, await make(request, 'Checkout deep check', [TRACE_LOG, FIND_OWNER]));
  const { steps, panel } = view(page);
  await steps.nth(1).click();
  await expect(panel('Step').getByRole('button', { name: 'Remove' })).toBeVisible();
  for (const name of ['Move up', 'Move down', 'Earlier', 'Later']) {
    await expect(panel('Step').getByRole('button', { name })).toHaveCount(0);
  }
});

test('Remove in the Step panel removes that step', async ({ page, request }) => {
  await open(page, await make(request, 'Checkout deep check', [TRACE_LOG, FIND_OWNER]));
  const { steps, panel, editor } = view(page);
  await steps.first().click();
  await panel('Step').getByRole('button', { name: 'Remove' }).click();
  await expect(panel('Step')).toHaveCount(0);
  await expectTitles(page, ['Find the Repo that owns it']);
  await expect(editor.getByText('Unsaved edits')).toBeVisible();
});

test('Save writes the steps, and the scratch copy tag of a Custom step', async ({ page, request }) => {
  const id = await make(request, 'Checkout deep check', [FIND_OWNER]);
  await open(page, id);
  const { palette, steps, panel, editor, yours } = view(page);

  await palette.getByRole('button', { name: 'Add Custom step to steps' }).click();
  await steps.last().click();
  const tag = panel('Step').getByRole('checkbox', { name: /scratch copy/ });
  await expect(tag).not.toBeChecked();
  await tag.check();
  await panel('Step').getByRole('textbox', { name: 'Step title' }).fill('Seed carts');
  await panel('Step').getByRole('textbox', { name: 'Step instructions' }).fill('Seed three made-up guest carts.');
  await expect(steps.last()).toContainText('scratch copy');

  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(editor.getByText('Unsaved edits')).toHaveCount(0);
  expect((await saved(request, id))?.steps).toMatchObject([
    { block: 'find_owner', writes: false },
    { block: 'custom', title: 'Seed carts', instructions: 'Seed three made-up guest carts.', writes: true },
  ]);
  await editor.getByRole('button', { name: '← All Playbooks' }).click();
  await expect(yours.getByText('unsaved')).toHaveCount(0);
});

test('unsaved edits stay through a page switch and a reload', async ({ page, request }) => {
  const id = await make(request, 'Safe DB fix', [], 'Read only.');
  await open(page, id);
  const { editor, node, panel } = view(page);
  const rules = panel('Rules').getByRole('textbox', { name: 'Rules' });
  await node('Rules').click();
  await expect(rules).toHaveValue('Read only.');
  await expect(editor.getByText('Unsaved edits')).toHaveCount(0);

  await rules.fill('Never write to PROD.');
  await expect(panel('Rules')).toContainText('20 / 8000');
  await expect(editor.getByText('Unsaved edits')).toBeVisible();

  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Monitor' }).click();
  await nav.getByRole('link', { name: 'Playbooks' }).click();
  await open(page, id);
  await node('Rules').click();
  await expect(rules).toHaveValue('Never write to PROD.');
  await page.reload();
  await node('Rules').click();
  await expect(rules).toHaveValue('Never write to PROD.');
  await expect(editor.getByText('Unsaved edits')).toBeVisible();
  expect((await saved(request, id))?.rules).toBe('Read only.');
});

test('unsaved edits show in a new tab until Discard restores the saved Playbook', async ({ page, request }) => {
  const id = await make(request, 'Safe DB fix', [], 'Read only.');
  await open(page, id);
  await view(page).node('Rules').click();
  await view(page).panel('Rules').getByRole('textbox', { name: 'Rules' }).fill('Never write to PROD.');
  await expect(view(page).editor.getByText('Unsaved edits')).toBeVisible();

  const again = await page.context().newPage();
  await open(again, id);
  const reopened = view(again);
  const rules = reopened.panel('Rules').getByRole('textbox', { name: 'Rules' });
  await reopened.node('Rules').click();
  await expect(rules).toHaveValue('Never write to PROD.');
  await reopened.editor.getByRole('button', { name: 'Discard' }).click();
  await reopened.node('Rules').click();
  await expect(rules).toHaveValue('Read only.');
  await expect(reopened.editor.getByText('Unsaved edits')).toHaveCount(0);
  await again.reload();
  await reopened.node('Rules').click();
  await expect(rules).toHaveValue('Read only.');
});

test('Branch and the Jira ticket switch save what Verify and Fix read', async ({ page, request }) => {
  const id = await make(request, 'Prod first');
  await open(page, id);
  const { editor, panel, node } = view(page);
  await node('Settings').click();
  const branch = page.locator('#playbook-branch');
  const ticket = panel('Settings').getByRole('switch', { name: 'Jira ticket' });
  await expect(branch).toHaveValue('');
  await expect(branch).toHaveAttribute('placeholder', 'production, master, main');
  await expect(panel('Settings')).toContainText("Blank: the Repo's default branch.");
  await expect(ticket).toHaveAttribute('aria-checked', 'false');

  await branch.fill('production, master, main');
  await ticket.click();
  await expect(ticket).toHaveAttribute('aria-checked', 'true');
  await expect(node('Settings')).toContainText('Branch: production, master, main · Jira ticket on');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('button', { name: 'Save' })).toHaveCount(0);
  expect(await saved(request, id)).toMatchObject({ branches: 'production, master, main', jira_ticket: true });
  await page.reload();
  await node('Settings').click();
  await expect(ticket).toHaveAttribute('aria-checked', 'true');
  await expect(branch).toHaveValue('production, master, main');
});

test('a Branch git would take as an option is refused on Save', async ({ page, request }) => {
  const id = await make(request, 'Prod first', [], '', { branches: 'main' });
  await open(page, id);
  const { editor, node } = view(page);
  await node('Settings').click();
  await page.locator('#playbook-branch').fill('--upload-pack=x');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('alert')).toBeVisible();
  expect((await saved(request, id))?.branches).toBe('main');
});

test('every Playbook shows the console pull request description rule under its Rules', async ({ page, request }) => {
  const id = await make(request, 'PR depth');
  await open(page, id);
  const { panel, node } = view(page);
  await node('Rules').click();
  await panel('Rules').getByText("Every run also gets the console's pull request description rule").click();
  await expect(panel('Rules')).toContainText('Testing: the commands you ran and their results');
  await expect(panel('Rules')).toContainText('Never a one-line description.');
});

test('a failed Save shows why beside Save and keeps the edits', async ({ page, request }) => {
  await make(request, 'Alpha checks');
  const id = await make(request, 'Beta checks');
  await open(page, id);
  const { editor, yours } = view(page);

  await editor.getByRole('textbox', { name: 'Name' }).fill('alpha checks');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('alert')).toContainText('Another Playbook is named alpha checks');
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('alpha checks');
  await expect(editor.getByRole('button', { name: 'Save' })).toBeVisible();
  expect((await saved(request, id))?.name).toBe('Beta checks');

  await editor.getByRole('button', { name: '← All Playbooks' }).click();
  await expect(yours.getByRole('button', { name: /^Beta checks/ })).toContainText('unsaved');
});

// Token meter

test('the Rules meter shows ceil(characters / 4) tokens as the operator types', async ({ page, request }) => {
  await open(page, await make(request, 'Heavy rules'));
  const { panel, node } = view(page);
  await node('Rules').click();
  const rules = panel('Rules').getByRole('textbox', { name: 'Rules' });
  const meter = panel('Rules').locator('p').filter({ hasText: 'tokens' });

  await expect(meter).toContainText('≈ 0 tokens');
  await expect(meter).toContainText('sent on every turn of every run');
  await rules.pressSequentially('abcde');
  await expect(meter).toContainText('≈ 2 tokens');
  await rules.fill('x'.repeat(8));
  await expect(meter).toContainText('≈ 2 tokens');
  await rules.fill('x'.repeat(9));
  await expect(meter).toContainText('≈ 3 tokens');
});

test('past 1500 characters of Rules the meter is tinted and says Long', async ({ page, request }) => {
  await open(page, await make(request, 'Heavy rules'));
  const { panel, node } = view(page);
  await node('Rules').click();
  const rules = panel('Rules').getByRole('textbox', { name: 'Rules' });
  const meter = panel('Rules').locator('p').filter({ hasText: 'tokens' });
  const long = 'Long. Move how-to text into a Skill.';

  await rules.fill('x'.repeat(1500));
  await expect(meter).toContainText('≈ 375 tokens');
  await expect(panel('Rules')).not.toContainText(long);
  const calm = await meter.evaluate((el) => getComputedStyle(el).backgroundColor);
  await rules.fill('x'.repeat(1501));
  await expect(meter).toContainText('≈ 376 tokens');
  await expect(panel('Rules')).toContainText(long);
  await expect(meter).not.toHaveCSS('background-color', calm);
});

test("a built-in's Rules show the meter without the warning, and its Skills panel says it holds none", async ({
  page,
}) => {
  await overview(page, '?trigger=verify&view=flow');
  const { panel, node } = view(page);
  await node('Rules').click();
  await expect(panel('Rules')).toContainText(/≈ \d[\d,]* tokens/);
  await expect(panel('Rules')).not.toContainText('Long. Move how-to text into a Skill.');
  await expect(panel('Rules').getByRole('textbox')).toHaveCount(0);

  await node('Skills').click();
  await expect(panel('Skills')).toContainText('A built-in Playbook holds no Skills.');
  await expect(panel('Skills')).not.toContainText('tokens');
  await expect(panel('Skills').getByRole('button', { name: '+ Add a Skill' })).toHaveCount(0);
});

test('the Skills meter appears once a Skill is held and counts the held names and descriptions', async ({
  page,
  request,
}) => {
  await makeSkill(request, 'alpha-method', 'Use it to read a log.');
  await makeSkill(request, 'beta-method', 'Use it when a test is flaky.');
  await open(page, await make(request, 'Skill weight'));
  const { panel, node } = view(page);
  await node('Skills').click();
  await expect(panel('Skills')).not.toContainText('tokens per turn');

  const add = async (name: RegExp) => {
    await panel('Skills').getByRole('button', { name: '+ Add a Skill' }).click();
    await panel('Skills').getByRole('button', { name }).click();
  };
  const alpha = 'alpha-method'.length + 'Use it to read a log.'.length;
  const beta = 'beta-method'.length + 'Use it when a test is flaky.'.length;
  await add(/^alpha-method/);
  await expect(panel('Skills')).toContainText(`≈ ${Math.ceil(alpha / 4)} tokens per turn`);
  await expect(panel('Skills')).toContainText(
    "names and descriptions only. A Skill's full text costs tokens only when a step loads it",
  );
  await add(/^beta-method/);
  await expect(panel('Skills')).toContainText(`≈ ${Math.ceil((alpha + beta) / 4)} tokens per turn`);

  await panel('Skills').getByRole('button', { name: 'Remove alpha-method' }).click();
  await expect(panel('Skills')).toContainText(`≈ ${Math.ceil(beta / 4)} tokens per turn`);
  await panel('Skills').getByRole('button', { name: 'Remove beta-method' }).click();
  await expect(panel('Skills')).not.toContainText('tokens per turn');
});

// Controls

test('standard buttons share one height, icon buttons are 30 pixels, and the dropdown field is one size', async ({
  page,
  request,
}) => {
  const id = await make(request, 'Checkout deep check', [FIND_OWNER], 'Read only.');
  await open(page, id);
  const { editor, panel, node } = view(page);
  await node('Rules').click();
  await panel('Rules').getByRole('textbox', { name: 'Rules' }).fill('Never write to PROD.');

  const standard = [
    page.getByRole('button', { name: '+ New Playbook' }),
    editor.getByRole('button', { name: '← All Playbooks' }),
    editor.getByRole('button', { name: 'Discard' }),
    editor.getByRole('button', { name: 'Save' }),
    editor.getByRole('button', { name: 'Delete' }),
  ];
  const sizes = await Promise.all(standard.map(sizeOf));
  for (const size of sizes) expect(size.height).toBe(sizes[0]?.height);
  expect(await sizeOf(panel('Rules').getByRole('button', { name: 'Close' }))).toEqual({ width: 30, height: 30 });

  await editor.getByRole('button', { name: '← All Playbooks' }).click();
  const field = await sizeOf(page.getByRole('button', { name: 'Playbook for Verify' }));
  await page.getByRole('button', { name: '+ New Playbook' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'New Playbook' });
  const copy = await sizeOf(dialog.getByRole('button', { name: 'Built-in to copy' }));
  expect(copy.height).toBe(field.height);
});

// Monitor and Workspace jobs come from the Datadog and Git host fakes, so these answer with fixtures.

type StepStatus = `${PlaybookStepStatus}`;

const jobPlaybook = (
  id: string | null,
  name: string,
  steps: [string, StepStatus, string | null, boolean?][],
): JobPlaybook => ({
  id,
  name,
  skills: [],
  steps: steps.map(([title, status, summary, writes = false]) => ({
    title,
    status: status as JobPlaybook['steps'][number]['status'],
    summary,
    writes,
    // A step that ran started at NOW; one that ended, ended then too.
    started_at: status === 'pending' || status === 'skipped' ? null : NOW,
    finished_at: status === 'pending' || status === 'running' ? null : NOW,
  })),
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
      skills: [],
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
  started_at: NOW,
  finished_at: status === 'running' ? null : NOW,
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
  last_scanned_at: NOW as string | null,
  scan_overdue: false,
  awaiting_prod_check: false,
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
  started_at: NOW,
  finished_at: extra.status === 'running' ? null : NOW,
  stale: false,
  playbook: null,
  note: null,
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

test('Skip step on a running Report, Fix and Agent Review step stops that step and goes on', async ({ page }) => {
  const skipped: string[] = [];
  const running = (name: string) =>
    jobPlaybook(null, name, [
      ['Trace', 'done', 'traced'],
      ['Run the tests and build', 'running', null, true],
      ['Classify', 'pending', null],
    ]);
  const verifying = {
    ...alert('a7', 'verifying', report('a7', 'running', running('Verify (built-in)'))),
    session_id: 'sv7',
  };
  const fixing = alert('a8', 'fixing', report('a8', 'ready', null), {
    id: 'fix8',
    review_id: 'rv8',
    session_id: 'sf8',
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
    playbook: running('Fix (built-in)'),
  });
  await routeAlerts(page, [verifying, fixing]);
  await page.route('**/api/jobs/*/*/skip-step', (route) => {
    skipped.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/repos/r1/pull-requests/7', (route) =>
    route.fulfill({
      json: {
        data: {
          ...pullRequest(agentReview({ id: 'ar9', status: 'running', playbook: running('Review PR (built-in)') })),
          agent_session_id: 'sr9',
        },
      },
    }),
  );

  await page.goto(`${daemon.url}/monitor?service=checkout-api&alert=a7#token=${daemon.token}`);
  const reportSteps = page
    .getByRole('region', { name: 'Report', exact: true })
    .getByRole('list', { name: 'Playbook steps' });
  // Only the running step can be skipped while the job runs.
  await expect(reportSteps.getByRole('button', { name: /^Skip step/ })).toHaveCount(1);
  await reportSteps.getByRole('button', { name: 'Skip step 2' }).click();
  await expect.poll(() => skipped).toEqual(['/api/jobs/report/rep-a7/skip-step']);

  await page.goto(`${daemon.url}/monitor?service=checkout-api&alert=a8#token=${daemon.token}`);
  await page.getByRole('region', { name: 'Fix', exact: true }).getByRole('button', { name: 'Skip step 2' }).click();
  await expect.poll(() => skipped).toHaveLength(2);
  expect(skipped[1]).toBe('/api/jobs/fix/fix8/skip-step');

  await page.goto(`${daemon.url}/workspace?tab=pulls&pr=r1/7#token=${daemon.token}`);
  await page.getByRole('region', { name: 'Agent Review' }).getByRole('button', { name: 'Skip step 2' }).click();
  await expect.poll(() => skipped).toHaveLength(3);
  expect(skipped[2]).toBe('/api/jobs/agent_review/ar9/skip-step');
});

test('Retry from step and Skip step on a failed Verification are the same size', async ({ page }) => {
  const failed = alert(
    'a10',
    'open',
    report('a10', 'failed', jobPlaybook(null, 'Verify (built-in)', [['Trace', 'failed', 'stopped by the operator']])),
  );
  await routeAlerts(page, [failed]);
  await page.goto(`${daemon.url}/monitor?service=checkout-api&alert=a10#token=${daemon.token}`);
  const retry = page.getByRole('button', { name: 'Retry from step 1' }).first();
  const skip = page.getByRole('button', { name: 'Skip step 1' }).first();
  await expect(retry).toBeVisible();
  const [a, b] = [await retry.boundingBox(), await skip.boundingBox()];
  expect(b?.height).toBe(a?.height);
  expect(await skip.evaluate((node) => getComputedStyle(node).fontSize)).toBe(
    await retry.evaluate((node) => getComputedStyle(node).fontSize),
  );
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
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook,
  queued_message: null,
});

test('a Session names the Playbook its rules come from and links to its flow', async ({ page, request }) => {
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
  await view(page).node('Rules').click();
  await expect(view(page).panel('Rules').getByRole('textbox', { name: 'Rules' })).toHaveValue('Never write to PROD.');
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

  const logs = page
    .getByRole('list', { name: 'Logs' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button') });
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
