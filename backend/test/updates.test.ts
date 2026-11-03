import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessMode, Effort, Model, type Release, SessionKind, SessionState, UpdateStatus } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { sessions } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { type Installer, ScriptInstaller } from '../src/updates/installer';
import type { ReleaseSource } from '../src/updates/releases';
import { UpdatesModule } from '../src/updates/updates.module';
import { compareVersions } from '../src/updates/updates.service';
import { removeDir, startTestDaemon, type TestDaemon, tempDir } from './helpers';

class FakeReleases implements ReleaseSource {
  release: Release = { version: '1.2.3', published_at: null, url: 'https://example.com/v1.2.3', notes: null };
  failure: Error | null = null;

  async latest(): Promise<Release> {
    if (this.failure) throw this.failure;
    return this.release;
  }
}

class FakeInstaller implements Installer {
  installed: string[] = [];
  restarts = 0;
  failure: Error | null = null;

  async install(version: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.installed.push(version);
  }

  restart(): void {
    this.restarts += 1;
  }
}

type Ctx = { daemon: TestDaemon; releases: FakeReleases; installer: FakeInstaller; dataDir: string };
const running: { daemon: TestDaemon; dataDir: string }[] = [];
afterEach(async () => {
  for (const { daemon, dataDir } of running.splice(0)) {
    await daemon.stop();
    await removeDir(dataDir);
  }
});

async function start(
  options: { dataDir?: string; releases?: FakeReleases; installer?: FakeInstaller } = {},
): Promise<Ctx> {
  const releases = options.releases ?? new FakeReleases();
  const installer = options.installer ?? new FakeInstaller();
  const dataDir = options.dataDir ?? (await tempDir());
  const daemon = await startTestDaemon({ dataDir, modules: [UpdatesModule.forRoot({ releases, installer })] });
  running.push({ daemon, dataDir });
  return { daemon, releases, installer, dataDir };
}

const call = (ctx: Ctx) => ({
  get: (url: string) => request(ctx.daemon.url).get(`/api${url}`).set('Authorization', `Bearer ${ctx.daemon.token}`),
  post: (url: string, body?: object) =>
    request(ctx.daemon.url).post(`/api${url}`).set('Authorization', `Bearer ${ctx.daemon.token}`).send(body),
  patch: (url: string, body: object) =>
    request(ctx.daemon.url).patch(`/api${url}`).set('Authorization', `Bearer ${ctx.daemon.token}`).send(body),
});

const newer = (releases: FakeReleases) => {
  releases.release = {
    version: '1.2.4',
    published_at: '2026-11-03T00:00:00Z',
    url: 'https://example.com/v1.2.4',
    notes: '- A fix',
  };
};

const autoUpdate = (ctx: Ctx, on: boolean) => call(ctx).patch('/settings', { updates: { auto_update: on } });

/** A Session whose run is going, as the Running count shows it. */
function runGoing(ctx: Ctx): string {
  const id = crypto.randomUUID();
  ctx.daemon.app.get<Store>(STORE).write((tx) => {
    tx.insert(sessions)
      .values({
        id,
        kind: SessionKind.Anonymous,
        title: 'a run',
        model: Model.Sonnet,
        effort: Effort.Medium,
        accessMode: AccessMode.Supervised,
        state: SessionState.Working,
      })
      .run();
  });
  return id;
}

function runEnds(ctx: Ctx, id: string): void {
  ctx.daemon.app.get<Store>(STORE).write((tx) => {
    tx.update(sessions).set({ state: SessionState.Idle }).where(eq(sessions.id, id)).run();
  });
}

describe('the console version', () => {
  it('reads the installed version up to date against the newest release, with auto-update on by default', async () => {
    const ctx = await start();
    expect((await call(ctx).get('/updates')).body.data).toMatchObject({
      current: '1.2.3-test',
      status: UpdateStatus.Unknown,
      auto_update: true,
    });

    const checked = (await call(ctx).post('/updates/checks')).body.data;
    expect(checked).toMatchObject({ status: UpdateStatus.UpToDate, latest: { version: '1.2.3' }, error: null });
    expect(checked.checked_at).not.toBeNull();
    expect(ctx.installer.installed).toEqual([]);
  });

  it('installs a newer release by itself with auto-update on, then restarts on it', async () => {
    const ctx = await start();
    newer(ctx.releases);

    const checked = (await call(ctx).post('/updates/checks')).body.data;

    expect(checked.status).toBe(UpdateStatus.Updating);
    expect(ctx.installer.installed).toEqual(['1.2.4']);
    expect(ctx.installer.restarts).toBe(1);
  });

  it('shows a newer release with auto-update off, and Update installs it', async () => {
    const ctx = await start();
    await autoUpdate(ctx, false);
    newer(ctx.releases);

    const checked = (await call(ctx).post('/updates/checks')).body.data;
    expect(checked).toMatchObject({
      status: UpdateStatus.Available,
      auto_update: false,
      latest: { version: '1.2.4', notes: '- A fix' },
    });
    expect(ctx.installer.installed).toEqual([]);

    const updating = await call(ctx).post('/updates', { when: 'now' });
    expect(updating.status).toBe(202);
    expect(updating.body.data.status).toBe(UpdateStatus.Updating);
    expect(ctx.installer.installed).toEqual(['1.2.4']);
    expect(ctx.installer.restarts).toBe(1);
  });

  it('waits for agent runs to finish before an automatic update', async () => {
    const ctx = await start();
    const run = runGoing(ctx);
    newer(ctx.releases);

    const checked = (await call(ctx).post('/updates/checks')).body.data;
    expect(checked).toMatchObject({ status: UpdateStatus.Waiting, runs_going: 1 });
    expect(ctx.installer.installed).toEqual([]);

    runEnds(ctx, run);
    await call(ctx).post('/updates/checks');
    expect(ctx.installer.installed).toEqual(['1.2.4']);
  });

  it('Update now installs while runs go; Wait until idle installs once they end', async () => {
    const ctx = await start();
    await autoUpdate(ctx, false);
    const run = runGoing(ctx);
    newer(ctx.releases);
    await call(ctx).post('/updates/checks');

    const waiting = (await call(ctx).post('/updates', { when: 'idle' })).body.data;
    expect(waiting.status).toBe(UpdateStatus.Waiting);
    expect(ctx.installer.installed).toEqual([]);

    const now = (await call(ctx).post('/updates', { when: 'now' })).body.data;
    expect(now.status).toBe(UpdateStatus.Updating);
    expect(ctx.installer.installed).toEqual(['1.2.4']);
    runEnds(ctx, run);
  });

  it('keeps this version running and says why when the install fails', async () => {
    const ctx = await start();
    ctx.installer.failure = new Error('checksum mismatch for ops-console-darwin-arm64.tar.gz; nothing was installed');
    newer(ctx.releases);

    const checked = (await call(ctx).post('/updates/checks')).body.data;

    expect(checked).toMatchObject({
      status: UpdateStatus.Failed,
      error:
        'The update to 1.2.4 did not install: checksum mismatch for ops-console-darwin-arm64.tar.gz; nothing was installed',
    });
    expect(ctx.installer.restarts).toBe(0);
    // An automatic install that failed is not tried again on every check.
    ctx.installer.failure = null;
    await call(ctx).post('/updates/checks');
    expect(ctx.installer.installed).toEqual([]);
    // The operator's Update still does.
    await call(ctx).post('/updates', { when: 'now' });
    expect(ctx.installer.installed).toEqual(['1.2.4']);
  });

  it('says GitHub could not be reached and keeps the last answer', async () => {
    const ctx = await start();
    await call(ctx).post('/updates/checks');
    ctx.releases.failure = new Error('GitHub answered 502');

    const checked = (await call(ctx).post('/updates/checks')).body.data;

    expect(checked).toMatchObject({
      status: UpdateStatus.UpToDate,
      latest: { version: '1.2.3' },
      error: 'Could not reach GitHub: GitHub answered 502',
    });
  });

  it('refuses Update when no newer release is known', async () => {
    const ctx = await start();
    await call(ctx).post('/updates/checks');
    const refused = await call(ctx).post('/updates', { when: 'now' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe('This is the newest version');
  });

  it('says on the first start of a new version which one it came from, and whether auto-update put it there', async () => {
    const dataDir = await tempDir();
    await writeRecord(dataDir, { version: '1.2.2', pending: { to: '1.2.3-test', automatic: true } });

    const ctx = await start({ dataDir });

    const state = (await call(ctx).get('/updates')).body.data;
    expect(state.updated).toMatchObject({ from: '1.2.2', automatic: true });
    expect(JSON.parse(await readFile(path.join(dataDir, 'update.json'), 'utf8'))).toMatchObject({
      version: '1.2.3-test',
      previous: '1.2.2',
      pending: null,
    });
  });

  it('says nothing was updated on a first install', async () => {
    const ctx = await start();
    expect((await call(ctx).get('/updates')).body.data.updated).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders by number, part by part', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.1.12')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3-test')).toBe(0);
    expect(compareVersions('0.1.2', '0.1.3')).toBeLessThan(0);
  });
});

async function writeRecord(dataDir: string, record: { version: string; pending: { to: string; automatic: boolean } }) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(dataDir, 'update.json'),
    JSON.stringify({ previous: null, at: null, automatic: false, ...record }),
  );
}

describe('ScriptInstaller', () => {
  it("runs the installed version's install.sh for the version asked, and says why it failed", async () => {
    const root = await tempDir();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(root, 'install.sh'),
      `echo "$OPS_CONSOLE_VERSION" > "${root}/asked"\n[ "$OPS_CONSOLE_VERSION" = 9.9.9 ] && { echo "ops-console install: could not download" >&2; exit 1; }\nexit 0\n`,
    );
    const installer = new ScriptInstaller(root);

    await installer.install('1.2.4');
    expect((await readFile(path.join(root, 'asked'), 'utf8')).trim()).toBe('1.2.4');
    await expect(installer.install('9.9.9')).rejects.toThrow('ops-console install: could not download');
    await removeDir(root);
  });
});
