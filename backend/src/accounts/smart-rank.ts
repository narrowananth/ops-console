const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

export type AccountUsage = {
  id: string;
  signedIn: boolean;
  fiveHourPct: number | null;
  fiveHourResetsAt: string | null;
  weeklyPct: number | null;
  weeklyResetsAt: string | null;
};

export type Ranked = { id: string; score: number; weeklyLeft: number; days: number };

/** A window past its reset time reads 0%; one never seen reads `null`. */
export function effectivePct(pct: number | null, resetsAt: string | null, now: Date): number | null {
  if (pct === null) return null;
  return resetsAt !== null && Date.parse(resetsAt) <= now.getTime() ? 0 : pct;
}

/** Days until the weekly reset; a reset already past means a fresh week ahead. */
function daysUntilWeeklyReset(resetsAt: string | null, now: Date): number {
  const left = resetsAt === null ? 0 : Date.parse(resetsAt) - now.getTime();
  return left > 0 ? left / DAY_MS : WEEK_DAYS;
}

export function formatNumber(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/**
 * Smart usage: candidates are signed in, have known usage, a 5-hour usage under the threshold and a weekly usage
 * under 100%. Score is weekly % left ÷ days until the weekly reset, highest first. `notes` says, per account, why
 * it ranks or is skipped.
 */
export function smartRank(
  accounts: AccountUsage[],
  threshold: number,
  now: Date,
): { ranked: Ranked[]; notes: Map<string, string> } {
  const ranked: Ranked[] = [];
  const notes = new Map<string, string>();
  for (const account of accounts) {
    const fiveHour = effectivePct(account.fiveHourPct, account.fiveHourResetsAt, now);
    const weekly = effectivePct(account.weeklyPct, account.weeklyResetsAt, now);
    if (!account.signedIn) notes.set(account.id, 'not signed in, skipped');
    else if (fiveHour === null || weekly === null) notes.set(account.id, 'no usage yet, skipped');
    else if (fiveHour >= threshold) notes.set(account.id, '5-hour window nearly full, skipped');
    else if (weekly >= 100) notes.set(account.id, 'weekly quota used up, skipped');
    else {
      const weeklyLeft = 100 - weekly;
      const days = daysUntilWeeklyReset(account.weeklyResetsAt, now);
      const score = weeklyLeft / days;
      ranked.push({ id: account.id, score, weeklyLeft, days });
      notes.set(
        account.id,
        `${formatNumber(weeklyLeft)}% weekly left ÷ ${formatNumber(days)}d = ${formatNumber(score)}% / day`,
      );
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return { ranked, notes };
}
