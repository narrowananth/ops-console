import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import {
  type AgentAccountsSetting,
  agentAccountsSettingSchema,
  type ClaudeAccount,
  ErrorCode,
  type SmartPick,
  SwitchReason,
} from '@ops-console/shared';
import { asc, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { RunRegistry } from '../agent/runs';
import { emitSessionUpdated } from '../agent/sessions.service';
import { Transcripts } from '../agent/transcripts';
import { CLAUDE_CLI, type ClaudeCli } from '../claude-cli/claude-cli';
import { DATA_DIR } from '../common/data-dir';
import { ApiError } from '../common/errors';
import { claudeAccounts, nowIso, sessions } from '../db/schema';
import { type Emit, STORE, type Store, type Tx } from '../db/store';
import { SettingsRegistry } from '../settings/settings.registry';
import { SettingsService } from '../settings/settings.service';
import { type AccountUsage, effectivePct, formatNumber, smartRank } from './smart-rank';
import { USAGE_SOURCE, type UsageReading, type UsageSource } from './usage-source';

export const AGENT_ACCOUNTS = 'agent_accounts';

/** Until the account signs in; then its label is the email Claude reports. */
const NEW_ACCOUNT_LABEL = 'New account';

/**
 * How often each signed-in account's usage is read, so idle accounts show it too. Anthropic's usage endpoint answers
 * 429 to a client that asks every few seconds, and Claude Code then holds off for minutes.
 */
export const USAGE_POLL_MS = 5 * 60_000;

export type AccountRow = typeof claudeAccounts.$inferSelect;

const windowSchema = z.object({ utilization: z.number(), resetsAt: z.number() });

/**
 * The SDK's rate-limit event. Its documented fields carry one window at a time; the per-window numbers in
 * `unifiedWindows` are undocumented and may be missing, in which case the last values stay.
 */
export const rateLimitInfoSchema = z
  .object({
    status: z.enum(['allowed', 'allowed_warning', 'rejected']),
    resetsAt: z.number().optional(),
    rateLimitType: z.string().optional(),
    utilization: z.number().optional(),
    unifiedWindows: z
      .object({ five_hour: windowSchema.optional(), seven_day: windowSchema.optional() })
      .loose()
      .optional(),
  })
  .loose();

export type RateLimitInfo = z.infer<typeof rateLimitInfoSchema>;

type Window = z.infer<typeof windowSchema>;

function windowOf(info: RateLimitInfo, name: 'five_hour' | 'seven_day'): Window | undefined {
  const fromWindows = info.unifiedWindows?.[name];
  if (fromWindows) return fromWindows;
  if (info.rateLimitType === name && info.utilization !== undefined && info.resetsAt !== undefined) {
    return { utilization: info.utilization, resetsAt: info.resetsAt };
  }
  return undefined;
}

const usageOf = (row: AccountRow): AccountUsage => ({
  id: row.id,
  signedIn: row.signedIn,
  fiveHourPct: row.fiveHourPct,
  fiveHourResetsAt: row.fiveHourResetsAt,
  weeklyPct: row.weeklyPct,
  weeklyResetsAt: row.weeklyResetsAt,
});

@Injectable()
export class AccountsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('accounts');
  /** Sign-ins waiting on the operator, by account id. */
  private readonly logins = new Map<string, AbortController>();
  private usageTimer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(CLAUDE_CLI) private readonly claude: ClaudeCli,
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(RunRegistry) private readonly runs: RunRegistry,
    @Inject(Transcripts) private readonly transcripts: Transcripts,
    @Inject(SettingsRegistry) registry: SettingsRegistry,
    @Inject(USAGE_SOURCE) private readonly usageSource: UsageSource,
  ) {
    registry.register({
      key: AGENT_ACCOUNTS,
      schema: agentAccountsSettingSchema,
      default: { active_account_id: null, auto_switch: true, threshold: 95, smart_usage: true },
      onChange: () => this.autoSwitch(),
    });
  }

  onApplicationBootstrap(): void {
    void this.pollUsage();
    this.usageTimer = setInterval(() => void this.pollUsage(), USAGE_POLL_MS);
    this.usageTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.usageTimer);
    for (const login of this.logins.values()) login.abort();
  }

  setting(): AgentAccountsSetting {
    return this.settings.get(AGENT_ACCOUNTS, agentAccountsSettingSchema);
  }

  get(id: string): AccountRow {
    const row = this.store.db.select().from(claudeAccounts).where(eq(claudeAccounts.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Claude account');
    return row;
  }

  /** The account runs go under. */
  active(): AccountRow {
    const row = this.activeRow();
    if (!row?.signedIn) {
      throw new ApiError(409, ErrorCode.InvalidState, 'no Claude account is signed in; add one in Settings › Agents');
    }
    return row;
  }

  /** The account's `CLAUDE_CONFIG_DIR`. */
  configDir(account: AccountRow): string {
    if (account.configDir === null) throw new Error(`Claude account ${account.id} has no config dir`);
    return account.configDir;
  }

  list(): {
    data: ClaudeAccount[];
    meta: { next_cursor: null; active_account_id: string | null; smart_pick: SmartPick | null };
  } {
    const setting = this.setting();
    const rows = this.rows();
    const now = new Date();
    const { ranked, notes } = smartRank(rows.map(usageOf), setting.threshold, now);
    const top = ranked[0];
    const smartPick =
      setting.smart_usage && top
        ? {
            account_id: top.id,
            reason: `${formatNumber(top.weeklyLeft)}% of its weekly quota is left and it resets in ${formatNumber(top.days)} days, use it first`,
          }
        : null;
    return {
      data: rows.map((row) => ({
        ...this.view(row, now),
        is_active: row.id === setting.active_account_id,
        ...(setting.smart_usage ? { smart_note: notes.get(row.id) ?? '' } : {}),
      })),
      meta: { next_cursor: null, active_account_id: setting.active_account_id, smart_pick: smartPick },
    };
  }

  one(id: string): ClaudeAccount {
    const account = this.list().data.find((row) => row.id === id);
    if (!account) throw new ApiError(404, ErrorCode.NotFound, 'no such Claude account');
    return account;
  }

  /** A new config dir under the data directory; the operator signs in with Anthropic's own flow. */
  async add(): Promise<{ account: ClaudeAccount; sign_in_command: string }> {
    const id = crypto.randomUUID();
    const configDir = path.join(this.dataDir, 'accounts', id);
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    this.store.write((tx) => {
      const last = tx
        .select({ position: max(claudeAccounts.position) })
        .from(claudeAccounts)
        .get();
      tx.insert(claudeAccounts)
        .values({ id, label: NEW_ACCOUNT_LABEL, configDir, position: (last?.position ?? 0) + 1 })
        .run();
    });
    return { account: this.one(id), sign_in_command: `CLAUDE_CONFIG_DIR='${configDir}' claude auth login` };
  }

  /**
   * Starts Anthropic's sign-in for the account; the account is checked when the operator finishes. One already
   * waiting is stopped and replaced, which opens the browser page again.
   */
  startLogin(id: string): ClaudeAccount {
    const account = this.get(id);
    this.logins.get(id)?.abort();
    const abort = new AbortController();
    this.logins.set(id, abort);
    this.emitCurrent(id);
    void this.login(account, abort);
    return this.one(id);
  }

  /** Stops the sign-in. An account that never signed in is deleted with it. */
  async cancelLogin(id: string): Promise<void> {
    this.get(id);
    this.logins.get(id)?.abort();
    await this.discardIfNew(id);
  }

  private async login(account: AccountRow, abort: AbortController): Promise<void> {
    try {
      await this.claude.authLogin(account.configDir, abort.signal);
      await this.check(account.id);
    } catch (error) {
      if (!abort.signal.aborted) {
        this.logger.warn(
          `signing in "${account.label}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      // A replaced sign-in must not clear the one that replaced it.
      if (this.logins.get(account.id) === abort) this.logins.delete(account.id);
      this.emitCurrent(account.id);
    }
    // A cancel deletes through `cancelLogin`; a sign-in the operator declined, or that failed or timed out, ends here.
    if (!abort.signal.aborted) await this.discardIfNew(account.id);
  }

  /** Deletes an account that was added but never signed in, so an abandoned sign-in leaves no row behind. */
  private async discardIfNew(id: string): Promise<void> {
    const row = this.store.db.select().from(claudeAccounts).where(eq(claudeAccounts.id, id)).get();
    if (!row || row.signedIn || row.email !== null || row.label !== NEW_ACCOUNT_LABEL) return;
    try {
      await this.remove(id);
    } catch (error) {
      this.logger.warn(`removing "${row.label}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async check(id: string): Promise<ClaudeAccount> {
    const before = this.get(id);
    const status = await this.claude.authStatus(this.configDir(before));
    const same = (a: string | null, b: string | null) =>
      a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
    // A Claude account is added once: an account that signs in as one already signed in elsewhere is signed out again.
    const twin = status.signedIn
      ? this.rows().find((row) => row.id !== id && row.signedIn && same(row.email, status.email))
      : undefined;
    if (twin && !same(before.email, status.email)) return this.rejectTwin(before, status.email ?? '');
    this.store.write((tx, emit) => {
      const row = tx
        .update(claudeAccounts)
        .set({
          signedIn: status.signedIn,
          email: status.email,
          plan: status.plan,
          lastCheckedAt: nowIso,
          ...(status.email ? { label: status.email } : {}),
        })
        .where(eq(claudeAccounts.id, id))
        .returning()
        .get();
      if (row) this.emitUpdated(emit, row);
    });
    // The active account is always signed in: the first account to sign in becomes active, and so does one that signs
    // in while the active one is signed out. An active account that signs out hands over, or leaves none active.
    const active = this.activeRow();
    if (status.signedIn && id !== active?.id && !active?.signedIn) this.switchTo(id, SwitchReason.Manual);
    else if (!status.signedIn && id === active?.id) {
      const next = this.rows().find((row) => row.id !== id && row.signedIn);
      if (next) this.switchTo(next.id, SwitchReason.Manual);
      else this.clearActive();
    }
    if (status.signedIn) void this.pollUsage();
    this.autoSwitch();
    return this.one(id);
  }

  /** Signs `account` out of what it just signed in as, deletes it when it is new. */
  private async rejectTwin(account: AccountRow, email: string): Promise<never> {
    await this.claude.authLogout(this.configDir(account));
    this.store.write((tx, emit) => {
      const row = tx
        .update(claudeAccounts)
        .set({ signedIn: false, email: null, plan: null, lastCheckedAt: nowIso })
        .where(eq(claudeAccounts.id, account.id))
        .returning()
        .get();
      if (row) this.emitUpdated(emit, row);
    });
    await this.discardIfNew(account.id);
    throw new ApiError(409, ErrorCode.InvalidState, `${email} is already added`);
  }

  /** Signs the account out of its config dir. */
  async logout(id: string): Promise<ClaudeAccount> {
    const account = this.get(id);
    if (this.runs.onAccount(id))
      throw new ApiError(409, ErrorCode.InvalidState, 'a run on this account is still going');
    this.logins.get(id)?.abort();
    await this.claude.authLogout(this.configDir(account));
    return this.check(id);
  }

  /** The operator's Use: `smart` when the account is the Smart pick, `manual` otherwise. */
  activate(id: string): ClaudeAccount {
    const account = this.get(id);
    if (!account.signedIn) throw new ApiError(409, ErrorCode.InvalidState, 'the account is not signed in');
    const pick = this.list().meta.smart_pick;
    if (id !== this.setting().active_account_id) {
      this.switchTo(id, pick?.account_id === id ? SwitchReason.Smart : SwitchReason.Manual);
    }
    return this.one(id);
  }

  /** Records a rate-limit event from a run under `accountId`; may move the active account (Behavior 24). */
  recordUsage(accountId: string, info: RateLimitInfo): void {
    const fiveHour = windowOf(info, 'five_hour');
    const weekly = windowOf(info, 'seven_day');
    const asWindow = (window: Window | undefined) =>
      window ? { pct: window.utilization * 100, resetsAt: new Date(window.resetsAt * 1000).toISOString() } : null;
    this.writeUsage(accountId, { fiveHour: asWindow(fiveHour), weekly: asWindow(weekly) });
    // A rejected run switches with reason `rate_limited` when it ends (Behavior 26).
    if (info.status !== 'rejected') this.autoSwitch();
  }

  /** Reads the usage of every signed-in account from Anthropic (Behavior 22a). One failing account keeps its last values. */
  async pollUsage(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const rows = this.rows().filter((row) => row.signedIn && row.configDir !== null);
      await Promise.all(
        rows.map(async (row) => {
          try {
            const reading = await this.usageSource.read(this.configDir(row));
            if (reading) this.writeUsage(row.id, reading);
          } catch (error) {
            this.logger.debug(`usage of "${row.label}" not read: ${error instanceof Error ? error.message : error}`);
          }
        }),
      );
      this.autoSwitch();
    } finally {
      this.polling = false;
    }
  }

  /** Windows missing from `reading` keep their last values. */
  private writeUsage(accountId: string, reading: UsageReading): void {
    this.store.write((tx, emit) => {
      const row = tx
        .update(claudeAccounts)
        .set({
          ...(reading.fiveHour
            ? { fiveHourPct: reading.fiveHour.pct, fiveHourResetsAt: reading.fiveHour.resetsAt }
            : {}),
          ...(reading.weekly ? { weeklyPct: reading.weekly.pct, weeklyResetsAt: reading.weekly.resetsAt } : {}),
          usageSeenAt: nowIso,
        })
        .where(eq(claudeAccounts.id, accountId))
        .returning()
        .get();
      if (row) this.emitUpdated(emit, row);
    });
  }

  /**
   * After a run under `accountId` was rejected for a limit: the account to resume on, switching to it with reason
   * `rate_limited`, or `null` when Auto-switch is off or has no candidate.
   */
  switchAfterRejection(accountId: string): AccountRow | null {
    const setting = this.setting();
    if (!setting.auto_switch) return null;
    if (setting.active_account_id !== accountId) return this.active();
    const next = this.candidate(accountId);
    if (next === null) return null;
    this.switchTo(next, SwitchReason.RateLimited);
    return this.get(next);
  }

  /**
   * Each Session on the account moves its transcript to the account that stays active first (Behavior 27). Removing
   * the active account hands over to another signed-in one, or leaves none active.
   */
  async remove(id: string): Promise<void> {
    const account = this.get(id);
    if (this.runs.onAccount(id))
      throw new ApiError(409, ErrorCode.InvalidState, 'a run on this account is still going');
    this.logins.get(id)?.abort();
    const wasActive = id === this.setting().active_account_id;
    const target = wasActive ? (this.rows().find((row) => row.id !== id && row.signedIn) ?? null) : this.activeRow();
    const moved = this.store.db.select().from(sessions).where(eq(sessions.accountId, id)).all();
    for (const session of moved) {
      if (session.sdkSessionId !== null && target) {
        await this.transcripts.copy(session.sdkSessionId, this.configDir(account), this.configDir(target));
      }
    }
    if (account.signedIn) await this.claude.authLogout(this.configDir(account));
    if (wasActive) {
      if (target) this.switchTo(target.id, SwitchReason.Manual);
      else this.clearActive();
    }
    this.store.write((tx, emit) => {
      const updated = tx
        .update(sessions)
        .set({ accountId: target?.id ?? null })
        .where(eq(sessions.accountId, id))
        .returning()
        .all();
      for (const session of updated) emitSessionUpdated(emit, session);
      tx.delete(claudeAccounts).where(eq(claudeAccounts.id, id)).run();
      emit('account.removed', { account_id: id });
    });
    await rm(this.configDir(account), { recursive: true, force: true });
  }

  /** Smart usage moves to the Smart pick on its own; otherwise Auto-switch moves off an account at its threshold. */
  private autoSwitch(): void {
    const setting = this.setting();
    const pick = setting.smart_usage ? this.list().meta.smart_pick : null;
    if (pick && pick.account_id !== setting.active_account_id) {
      this.switchTo(pick.account_id, SwitchReason.Smart);
      return;
    }
    if (!setting.auto_switch) return;
    const active = this.activeRow();
    if (!active) return;
    const used = effectivePct(active.fiveHourPct, active.fiveHourResetsAt, new Date());
    if (used === null || used < setting.threshold) return;
    const next = this.candidate(active.id);
    if (next !== null) this.switchTo(next, SwitchReason.Auto);
  }

  /** The Smart pick when Smart usage is on, otherwise the signed-in account with the lowest known 5-hour usage. */
  private candidate(excludeId: string): string | null {
    const setting = this.setting();
    const now = new Date();
    const others = this.rows().filter((row) => row.id !== excludeId);
    if (setting.smart_usage) return smartRank(others.map(usageOf), setting.threshold, now).ranked[0]?.id ?? null;
    const lowest = others
      .filter((row) => row.signedIn)
      .map((row) => ({ id: row.id, used: effectivePct(row.fiveHourPct, row.fiveHourResetsAt, now) }))
      .filter((row): row is { id: string; used: number } => row.used !== null && row.used < setting.threshold)
      .sort((a, b) => a.used - b.used)[0];
    return lowest?.id ?? null;
  }

  private switchTo(to: string, reason: SwitchReason): void {
    const setting = this.setting();
    const from = this.activeRow();
    this.store.write((tx: Tx, emit) => {
      this.settings.set(tx, AGENT_ACCOUNTS, { ...setting, active_account_id: to });
      // The first sign-in has no account to move from.
      if (from) {
        emit('account.switched', {
          from: from.id,
          to,
          reason,
          five_hour_pct: effectivePct(from.fiveHourPct, from.fiveHourResetsAt, new Date()),
        });
      }
      emit('settings.updated', { keys: [AGENT_ACCOUNTS] });
    });
  }

  private clearActive(): void {
    const setting = this.setting();
    this.store.write((tx: Tx, emit) => {
      this.settings.set(tx, AGENT_ACCOUNTS, { ...setting, active_account_id: null });
      emit('settings.updated', { keys: [AGENT_ACCOUNTS] });
    });
  }

  private rows(): AccountRow[] {
    return this.store.db.select().from(claudeAccounts).orderBy(asc(claudeAccounts.position)).all();
  }

  private activeRow(): AccountRow | null {
    const id = this.setting().active_account_id;
    return id === null ? null : this.get(id);
  }

  private view(row: AccountRow, now: Date): Omit<ClaudeAccount, 'is_active' | 'smart_note'> {
    return {
      id: row.id,
      label: row.label,
      position: row.position,
      signed_in: row.signedIn,
      signing_in: this.logins.has(row.id),
      email: row.email,
      plan: row.plan,
      five_hour_pct: effectivePct(row.fiveHourPct, row.fiveHourResetsAt, now),
      five_hour_resets_at: row.fiveHourResetsAt,
      weekly_pct: effectivePct(row.weeklyPct, row.weeklyResetsAt, now),
      weekly_resets_at: row.weeklyResetsAt,
      usage_seen_at: row.usageSeenAt,
      last_checked_at: row.lastCheckedAt,
      created_at: row.createdAt,
    };
  }

  private emitCurrent(id: string): void {
    this.store.write((_tx, emit) => {
      const row = this.store.db.select().from(claudeAccounts).where(eq(claudeAccounts.id, id)).get();
      if (row) this.emitUpdated(emit, row);
    });
  }

  private emitUpdated(emit: Emit, row: AccountRow): void {
    const now = new Date();
    emit('account.updated', {
      account_id: row.id,
      signed_in: row.signedIn,
      five_hour_pct: effectivePct(row.fiveHourPct, row.fiveHourResetsAt, now),
      weekly_pct: effectivePct(row.weeklyPct, row.weeklyResetsAt, now),
      usage_seen_at: row.usageSeenAt,
    });
  }
}
