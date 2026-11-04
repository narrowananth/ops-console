import { KEYCHAIN_WAIT_MESSAGE } from '@ops-console/shared';
import { useKeychainWait } from '../lib/queries';

/**
 * Above every page while a Keychain call has waited past 10 seconds: the Mac is asking for the login password, and agent
 * runs that need a secret stand still until someone answers. It goes when every pending call has ended.
 */
export function KeychainWaitBanner() {
  const wait = useKeychainWait().data;
  if (!wait?.waiting) return null;
  return (
    <div
      role="alert"
      aria-label="Keychain wait"
      className="flex flex-none items-start gap-2.5 border-accent-300 border-b bg-accent-100 px-6 py-2.5 text-accent-900 text-xs"
    >
      <span aria-hidden className="mt-0.5 flex-none">
        ◐
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{KEYCHAIN_WAIT_MESSAGE}</div>
        <div className="mt-0.5">Answer it on the Mac.</div>
      </div>
    </div>
  );
}
