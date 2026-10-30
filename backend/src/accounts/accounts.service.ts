import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type AgentAccountsSetting,
  agentAccountsSettingSchema,
  type ClaudeAccount,
  ErrorCode,
  type SmartPick,
  SwitchReason,
} from '@ops-console/shared';
import { asc, eq, isNull, max } from 'drizzle-orm';
import { z } from 'zod';
import { AGENT_CONFIG, type AgentConfig } from '../agent/agent-config';
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

export const AGENT_ACCOUNTS = 'agent_accounts';

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
export class AccountsService implements OnApplicationBootstrap {
  private readonly logger = new Logger('accounts');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(CLAUDE_CLI) private readonly claude: ClaudeCli,
    @Inject(AGENT_CONFIG) private readonly config: AgentConfig,
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(RunRegistry) private readonly runs: RunRegistry,
    @Inject(Transcripts) private readonly transcripts: Transcripts,
    @Inject(SettingsRegistry) registry: SettingsRegistry,
  ) {
    registry.register({
      key: AGENT_ACCOUNTS,
      schema: agentAccountsSettingSchema,
      default: { active_account_id: this.seeded().id, auto_switch: true, threshold: 95, smart_usage: true },
    });
  }

  /** First start checks the seeded account. Runs in the background: the daemon does not wait on the CLI. */
  onApplicationBootstrap(): void {
    const seeded = this.seeded();
    if (seeded.lastCheckedAt !== null) return;
    this.check(seeded.id).catch((error: unknown) =>
      this.logger.warn(
        `checking the Claude Code sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  setting(): AgentAccountsSetting {
    return this.settings.get(AGENT_ACCOUNTS, agentAccountsSettingSchema);
  }

  get(id: string): AccountRow {
    const row = this.store.db.select().from(claudeAccounts).where(eq(claudeAccounts.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Claude account');
    return row;
  }

  active(): AccountRow {
    return this.get(this.setting().active_account_id);
  }

  /** The account's `CLAUDE_CONFIG_DIR`; the seeded account uses the operator's own Claude Code setup. */
  configDir(account: AccountRow): string {
    return account.configDir ?? this.config.claudeHome;
  }

  list(): {
    data: ClaudeAccount[];
    meta: { next_cursor: null; active_account_id: string; smart_pick: SmartPick | null };
  } {
    const setting = this.setting();
    const rows = this.rows();
    const now = new Date();
    const { ranked, notes } = smartRank(rows.map(usageOf), setting.threshold, now);
    const top = ranked[0];
    const smartPick =
      setting.smart_usage && top && top.id !== setting.active_account_id
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
  async add(label: string): Promise<{ account: ClaudeAccount; sign_in_command: string }> {
    const id = crypto.randomUUID();
    const configDir = path.join(this.dataDir, 'accounts', id);
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    this.store.write((tx) => {
      const last = tx
        .select({ position: max(claudeAccounts.position) })
        .from(claudeAccounts)
        .get();
      tx.insert(claudeAccounts)
        .values({ id, label, configDir, position: (last?.position ?? 0) + 1 })
        .run();
    });
    return { account: this.one(id), sign_in_command: `CLAUDE_CONFIG_DIR='${configDir}' claude auth login` };
  }

  async check(id: string): Promise<ClaudeAccount> {
    const status = await this.claude.authStatus(this.get(id).configDir);
    this.store.write((tx, emit) => {
      const row = tx
        .update(claudeAccounts)
        .set({ signedIn: status.signedIn, email: status.email, plan: status.plan, lastCheckedAt: nowIso })
        .where(eq(claudeAccounts.id, id))
        .returning()
        .get();
      if (row) this.emitUpdated(emit, row);
    });
    return this.one(id);
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
    const resetIso = (window: Window) => new Date(window.resetsAt * 1000).toISOString();
    this.store.write((tx, emit) => {
      const row = tx
        .update(claudeAccounts)
        .set({
          ...(fiveHour ? { fiveHourPct: fiveHour.utilization * 100, fiveHourResetsAt: resetIso(fiveHour) } : {}),
          ...(weekly ? { weeklyPct: weekly.utilization * 100, weeklyResetsAt: resetIso(weekly) } : {}),
          usageSeenAt: nowIso,
        })
        .where(eq(claudeAccounts.id, accountId))
        .returning()
        .get();
      if (row) this.emitUpdated(emit, row);
    });
    // A rejected run switches with reason `rate_limited` when it ends (Behavior 26).
    if (info.status !== 'rejected') this.autoSwitch();
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

  /** Each Session on the account moves its transcript to the active account first (Behavior 27). */
  async remove(id: string): Promise<void> {
    const account = this.get(id);
    if (account.configDir === null) {
      throw new ApiError(409, ErrorCode.InvalidState, "the operator's own Claude Code account cannot be removed");
    }
    if (id === this.setting().active_account_id) {
      throw new ApiError(409, ErrorCode.InvalidState, 'the active account cannot be removed; use another one first');
    }
    if (this.runs.onAccount(id))
      throw new ApiError(409, ErrorCode.InvalidState, 'a run on this account is still going');
    const active = this.active();
    const moved = this.store.db.select().from(sessions).where(eq(sessions.accountId, id)).all();
    for (const session of moved) {
      if (session.sdkSessionId !== null) {
        await this.transcripts.copy(session.sdkSessionId, this.configDir(account), this.configDir(active));
      }
    }
    await this.claude.authLogout(account.configDir);
    this.store.write((tx, emit) => {
      const updated = tx
        .update(sessions)
        .set({ accountId: active.id })
        .where(eq(sessions.accountId, id))
        .returning()
        .all();
      for (const session of updated) emitSessionUpdated(emit, session);
      tx.delete(claudeAccounts).where(eq(claudeAccounts.id, id)).run();
    });
  }

  private autoSwitch(): void {
    const setting = this.setting();
    if (!setting.auto_switch) return;
    const active = this.active();
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
    const from = this.get(setting.active_account_id);
    this.store.write((tx: Tx, emit) => {
      this.settings.set(tx, AGENT_ACCOUNTS, { ...setting, active_account_id: to });
      emit('account.switched', {
        from: from.id,
        to,
        reason,
        five_hour_pct: effectivePct(from.fiveHourPct, from.fiveHourResetsAt, new Date()),
      });
      emit('settings.updated', { keys: [AGENT_ACCOUNTS] });
    });
  }

  private rows(): AccountRow[] {
    return this.store.db.select().from(claudeAccounts).orderBy(asc(claudeAccounts.position)).all();
  }

  private seeded(): AccountRow {
    const row = this.store.db.select().from(claudeAccounts).where(isNull(claudeAccounts.configDir)).get();
    if (!row) throw new Error('the seeded Claude account is missing; migration 0001 inserts it');
    return row;
  }

  private view(row: AccountRow, now: Date): Omit<ClaudeAccount, 'is_active' | 'smart_note'> {
    return {
      id: row.id,
      label: row.label,
      position: row.position,
      signed_in: row.signedIn,
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
