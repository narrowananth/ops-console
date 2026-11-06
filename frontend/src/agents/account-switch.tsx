import type { ClaudeAccount } from '@ops-console/shared';
import { useState } from 'react';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Toggle } from '../components/ui/toggle';
import { useSetAccountEnabled } from '../lib/queries';

/** Signed in somewhere, yet every one of those is disabled: runs are refused until one is enabled. */
export const allDisabled = (list: ClaudeAccount[]): boolean =>
  list.some((account) => account.signed_in) && !list.some((account) => account.signed_in && account.enabled);

/** The account new runs move to when `account`, the active one, is disabled: the Smart pick, else the least used. */
export function successorOf(
  account: ClaudeAccount,
  list: ClaudeAccount[],
  smartPickId: string | null | undefined,
): ClaudeAccount | null {
  const others = list.filter((one) => one.id !== account.id && one.signed_in && one.enabled);
  return (
    others.find((one) => one.id === smartPickId) ??
    [...others].sort((a, b) => (a.five_hour_pct ?? 0) - (b.five_hour_pct ?? 0))[0] ??
    null
  );
}

/** Shown on both tabs while every signed-in account is disabled. */
export function AllDisabledBanner({ onOpenAccounts }: { onOpenAccounts?: () => void }) {
  return (
    <div
      role="alert"
      className="mb-4 flex items-center gap-3 rounded-lg border border-accent-300 bg-accent-100 px-4 py-2.5 text-xs text-accent-700"
    >
      <span className="flex-1">
        <strong>Every Claude account is disabled.</strong> New runs fail until one is enabled.
      </span>
      {onOpenAccounts && (
        <button
          type="button"
          onClick={onOpenAccounts}
          className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-accent-700 underline"
        >
          Open Accounts
        </button>
      )}
    </div>
  );
}

/**
 * The Enable switch of an account row. Disabling the account runs go under asks first, naming the account they move
 * to. Dimmed with the reason while the account is signed out or CLIProxy picks the account.
 */
export function AccountSwitch({
  account,
  current,
  successor,
  proxied,
}: {
  account: ClaudeAccount;
  current: boolean;
  successor: ClaudeAccount | null;
  proxied: boolean;
}) {
  const set = useSetAccountEnabled(account.id);
  const [asking, setAsking] = useState(false);
  const reason = proxied ? 'CLIProxy picks the account' : !account.signed_in ? 'Sign in first' : undefined;
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-xs text-neutral-700">{account.enabled ? 'Enabled' : 'Disabled'}</span>
      <Toggle
        label={`Enabled ${account.label}`}
        checked={account.enabled}
        disabled={reason !== undefined}
        title={reason ?? (account.enabled ? 'Disable: agents will not use this account' : 'Enable this account')}
        onChange={(enabled) => (!enabled && current ? setAsking(true) : set.mutate(enabled))}
      />
      {asking && (
        <ConfirmDialog
          title={`Disable ${account.label}?`}
          action="Disable"
          pending={set.isPending}
          error={set.isError ? set.error.message : null}
          onCancel={() => setAsking(false)}
          onConfirm={() => set.mutate(false, { onSuccess: () => setAsking(false) })}
        >
          It is the active account. Runs going on it finish.{' '}
          {successor ? (
            <>
              New runs move to <strong className="font-mono">{successor.label}</strong>.
            </>
          ) : (
            'No account will be active, and new runs are refused until one is enabled.'
          )}{' '}
          You can enable it again any time.
        </ConfirmDialog>
      )}
      {set.isError && !asking && (
        <span role="alert" className="text-xs text-accent-700">
          {set.error.message}
        </span>
      )}
    </div>
  );
}
