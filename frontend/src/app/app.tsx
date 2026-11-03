import { ErrorCode, UpdateStatus } from '@ops-console/shared';
import { useEffect, useRef } from 'react';
import { Empty } from '../components/ui/empty';
import { TipLayer } from '../components/ui/tip';
import { ApiError } from '../lib/api';
import { useHealth, useUpdates } from '../lib/queries';
import { forgetToken, sessionToken } from '../lib/session';
import { Shell } from './shell';
import { useUi } from './ui-store';

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div role="status" className="rounded-lg border border-line bg-card shadow-sm px-6 py-5 text-[15px]">
        {children}
      </div>
    </div>
  );
}

function Gate() {
  const updates = useUpdates().data?.data;
  const restarting = updates?.status === UpdateStatus.Updating;
  const health = useHealth(restarting);
  useReloadOnNewVersion(health.data?.data.version);
  if (sessionToken() === null) {
    return <SignIn />;
  }
  if (health.isPending) return <Empty>Connecting to the daemon…</Empty>;
  if (health.error instanceof ApiError && health.error.code === ErrorCode.Unauthorized) {
    // A reinstall made a new token; the kept one will not work again.
    forgetToken();
    return <SignIn />;
  }
  if (health.isError && restarting) {
    return <Panel>Ops Console is restarting on v{updates?.latest?.version}. This page reloads by itself.</Panel>;
  }
  if (health.isError) {
    return (
      <Panel>
        The console daemon is not running. Run <code>ops-console start</code>.
      </Panel>
    );
  }
  return <Shell />;
}

/** The daemon serves this page: once it answers on a new version, the page loads that version's UI. */
function useReloadOnNewVersion(version: string | undefined) {
  const first = useRef<string | null>(null);
  useEffect(() => {
    if (version === undefined) return;
    if (first.current === null) first.current = version;
    else if (version !== first.current) window.location.reload();
  }, [version]);
}

function SignIn() {
  return (
    <Panel>
      Run <code>ops-console open</code> to sign in.
    </Panel>
  );
}

export function App() {
  const theme = useUi((state) => state.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <div className="theme-anim flex h-screen min-h-160 flex-col bg-bg font-body text-text">
      <Gate />
      <TipLayer />
    </div>
  );
}
