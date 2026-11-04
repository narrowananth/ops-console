import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import {
  ErrorCode,
  type Release,
  SessionState,
  type UpdateState,
  UpdateStatus,
  type UpdatesSetting,
  UpdateWhen,
  updatesSettingSchema,
} from '@ops-console/shared';
import { count, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DATA_DIR } from '../common/data-dir';
import { ApiError } from '../common/errors';
import { SESSION, type Session } from '../common/session';
import { sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { SettingsRegistry } from '../settings/settings.registry';
import { SettingsService } from '../settings/settings.service';
import { INSTALLER, type Installer } from './installer';
import { RELEASES, type ReleaseSource } from './releases';

export const UPDATES = 'updates';
const FIRST_CHECK_MS = 10_000;
/** A release is found within a minute of going out; each check is one small request to GitHub (`GithubReleases`). */
const CHECK_EVERY_MS = 60_000;
/** How often an update waiting on agent runs looks again. */
const IDLE_POLL_MS = 30_000;
/** The states the Running count shows; a restart fails each of them. */
const GOING = [SessionState.Working, SessionState.WaitingInput, SessionState.WaitingApproval];

/** `update.json` in the data folder: the version this data last ran on, and the one it came from. */
const versionRecord = z.object({
  version: z.string(),
  previous: z.string().nullable(),
  at: z.string().nullable(),
  automatic: z.boolean(),
  /** An install under way: the version it puts in place, and whether auto-update started it. */
  pending: z.object({ to: z.string(), automatic: z.boolean() }).nullable(),
});
type VersionRecord = z.infer<typeof versionRecord>;

/**
 * The console's own version against the newest GitHub release. It checks at start and every 6 hours, installs a
 * newer release when asked or, with auto-update on, by itself, and always waits for agent runs to finish unless the
 * operator says now. Installing restarts the daemon on the new version.
 */
@Injectable()
export class UpdatesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('updates');
  private readonly dev: boolean;
  private latest: Release | null = null;
  private status: UpdateStatus;
  private checkedAt: string | null = null;
  private error: string | null = null;
  private updated: UpdateState['updated'] = null;
  /** The operator asked to install once no run is going. */
  private waitForIdle = false;
  private installing = false;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SESSION) private readonly session: Session,
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(RELEASES) private readonly releases: ReleaseSource,
    @Inject(INSTALLER) private readonly installer: Installer,
    @Inject(SettingsRegistry) registry: SettingsRegistry,
  ) {
    this.dev = session.version === 'dev';
    this.status = this.dev ? UpdateStatus.Dev : UpdateStatus.Unknown;
    registry.register<UpdatesSetting>({
      key: UPDATES,
      schema: updatesSettingSchema,
      default: { auto_update: true },
      onChange: () => {
        this.announce();
        void this.installIfDue();
      },
    });
  }

  onApplicationBootstrap(): void {
    if (this.dev) return;
    this.updated = this.recordVersion();
    this.timers.push(setTimeout(() => void this.check().catch(() => {}), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => void this.check().catch(() => {}), CHECK_EVERY_MS));
    this.timers.push(
      setInterval(() => {
        if (this.status === UpdateStatus.Waiting) void this.installIfDue();
      }, IDLE_POLL_MS),
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.splice(0)) clearTimeout(timer);
  }

  state(): UpdateState {
    return {
      current: this.session.version,
      latest: this.latest,
      status: this.status,
      checked_at: this.checkedAt,
      error: this.error,
      auto_update: this.autoUpdate(),
      runs_going: this.runsGoing(),
      updated: this.updated,
    };
  }

  /** Reads the newest release; a newer one installs at once when auto-update is on and no run is going. */
  async check(): Promise<UpdateState> {
    if (this.dev) return this.state();
    try {
      this.latest = await this.releases.latest();
      this.error = null;
    } catch (error) {
      this.error = `Could not reach GitHub: ${(error as Error).message}`;
      this.log.warn(this.error);
    }
    this.checkedAt = new Date().toISOString();
    if (!this.installing && this.status !== UpdateStatus.Waiting && this.status !== UpdateStatus.Failed) {
      this.status = this.newer() ? UpdateStatus.Available : UpdateStatus.UpToDate;
    }
    this.announce();
    await this.installIfDue();
    return this.state();
  }

  /** Installs the newest release now, stopping runs going, or once none is going. */
  async install(when: UpdateWhen): Promise<UpdateState> {
    if (this.dev) throw new ApiError(409, ErrorCode.InvalidState, 'A development build does not update itself');
    if (this.installing) return this.state();
    if (!this.newer()) throw new ApiError(409, ErrorCode.InvalidState, 'This is the newest version');
    if (when === UpdateWhen.Now) {
      await this.put(false);
    } else {
      this.waitForIdle = true;
      await this.installIfDue();
    }
    return this.state();
  }

  private async installIfDue(): Promise<void> {
    if (this.dev || this.installing || !this.newer()) return;
    const automatic = this.autoUpdate() && !this.waitForIdle;
    if (!automatic && !this.waitForIdle) return;
    // An automatic install that failed waits for the operator, or the next release, instead of trying every check.
    if (automatic && this.status === UpdateStatus.Failed) return;
    if (this.runsGoing() > 0) {
      if (this.status !== UpdateStatus.Waiting) {
        this.status = UpdateStatus.Waiting;
        this.announce();
      }
      return;
    }
    await this.put(automatic);
  }

  /** Puts the newest release in place and restarts on it; a failure leaves this version running. */
  private async put(automatic: boolean): Promise<void> {
    const version = this.latest?.version;
    if (!version) return;
    this.installing = true;
    this.status = UpdateStatus.Updating;
    this.error = null;
    this.announce();
    this.log.log(`installing ${version}${automatic ? ' (auto-update)' : ''}`);
    try {
      this.writeRecord({ ...this.readRecord(), pending: { to: version, automatic } });
      await this.installer.install(version);
      this.log.log(`installed ${version}; restarting on it`);
      this.installer.restart();
    } catch (error) {
      this.installing = false;
      this.waitForIdle = false;
      this.status = UpdateStatus.Failed;
      this.error = `The update to ${version} did not install: ${(error as Error).message}`;
      this.log.warn(this.error);
      this.writeRecord({ ...this.readRecord(), pending: null });
      this.announce();
    }
  }

  /** Notes this start's version; the first start on a new one says what it came from. */
  private recordVersion(): UpdateState['updated'] {
    const current = this.session.version;
    const saved = this.readOptionalRecord();
    if (saved === null) {
      this.writeRecord({ version: current, previous: null, at: null, automatic: false, pending: null });
      return null;
    }
    if (saved.version !== current) {
      const record: VersionRecord = {
        version: current,
        previous: saved.version,
        at: new Date().toISOString(),
        automatic: saved.pending?.to === current && saved.pending.automatic,
        pending: null,
      };
      this.writeRecord(record);
      this.log.log(`updated from ${saved.version} to ${current}${record.automatic ? ' (auto-update)' : ''}`);
    }
    const record = this.readRecord();
    return record.previous !== null && record.at !== null
      ? { from: record.previous, at: record.at, automatic: record.automatic }
      : null;
  }

  private newer(): boolean {
    return this.latest !== null && compareVersions(this.latest.version, this.session.version) > 0;
  }

  private autoUpdate(): boolean {
    return this.settings.get(UPDATES, updatesSettingSchema).auto_update;
  }

  private runsGoing(): number {
    const [row] = this.store.db.select({ n: count() }).from(sessions).where(inArray(sessions.state, GOING)).all();
    return row?.n ?? 0;
  }

  private announce(): void {
    this.store.write((_tx, emit) => emit('update.changed', { status: this.status }));
  }

  private get recordFile(): string {
    return path.join(this.dataDir, 'update.json');
  }

  private readOptionalRecord(): VersionRecord | null {
    try {
      return versionRecord.parse(JSON.parse(readFileSync(this.recordFile, 'utf8')));
    } catch {
      return null;
    }
  }

  private readRecord(): VersionRecord {
    return (
      this.readOptionalRecord() ?? {
        version: this.session.version,
        previous: null,
        at: null,
        automatic: false,
        pending: null,
      }
    );
  }

  private writeRecord(record: VersionRecord): void {
    writeFileSync(this.recordFile, `${JSON.stringify(record, null, 2)}\n`);
  }
}

/** Orders `1.2.10` after `1.2.9`; anything after a `-` is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) =>
    version
      .split('-')[0]
      ?.split('.')
      .map((part) => Number.parseInt(part, 10) || 0) ?? [];
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
