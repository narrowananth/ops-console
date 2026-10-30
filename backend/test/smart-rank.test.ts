import { describe, expect, it } from 'vitest';
import { type AccountUsage, smartRank } from '../src/accounts/smart-rank';

const now = new Date('2026-10-30T12:00:00.000Z');
const inHours = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();

const account = (id: string, usage: Partial<AccountUsage>): AccountUsage => ({
  id,
  signedIn: true,
  fiveHourPct: null,
  fiveHourResetsAt: null,
  weeklyPct: null,
  weeklyResetsAt: null,
  ...usage,
});

describe('Smart rank', () => {
  const accounts = [
    account('work', { fiveHourPct: 92, fiveHourResetsAt: inHours(1), weeklyPct: 35, weeklyResetsAt: inHours(48) }),
    account('personal', { fiveHourPct: 18, fiveHourResetsAt: inHours(3), weeklyPct: 10, weeklyResetsAt: inHours(120) }),
    account('full', { fiveHourPct: 96, fiveHourResetsAt: inHours(2), weeklyPct: 5, weeklyResetsAt: inHours(24) }),
    account('spent', { fiveHourPct: 10, fiveHourResetsAt: inHours(2), weeklyPct: 100, weeklyResetsAt: inHours(24) }),
    account('fresh', {}),
    account('signed-out', { signedIn: false, fiveHourPct: 0, weeklyPct: 0, weeklyResetsAt: inHours(24) }),
    // Both windows reset since the numbers were seen: 0% used, and a new week ahead.
    account('stale', { fiveHourPct: 99, fiveHourResetsAt: inHours(-1), weeklyPct: 60, weeklyResetsAt: inHours(-2) }),
  ];

  it('ranks by weekly quota left per day until the weekly reset, highest first', () => {
    const { ranked } = smartRank(accounts, 95, now);
    expect(ranked.map((entry) => [entry.id, Number(entry.score.toFixed(1))])).toEqual([
      ['work', 32.5],
      ['personal', 18],
      ['stale', 14.3],
    ]);
  });

  it('notes why each account ranks or is skipped', () => {
    const { notes } = smartRank(accounts, 95, now);
    expect(Object.fromEntries(notes)).toEqual({
      work: '65% weekly left ÷ 2d = 32.5% / day',
      personal: '90% weekly left ÷ 5d = 18% / day',
      full: '5-hour window nearly full, skipped',
      spent: 'weekly quota used up, skipped',
      fresh: 'no usage yet, skipped',
      'signed-out': 'not signed in, skipped',
      stale: '100% weekly left ÷ 7d = 14.3% / day',
    });
  });

  it('skips an account at the threshold', () => {
    const { ranked } = smartRank(
      [account('edge', { fiveHourPct: 80, weeklyPct: 0, weeklyResetsAt: inHours(24) })],
      80,
      now,
    );
    expect(ranked).toEqual([]);
  });
});
