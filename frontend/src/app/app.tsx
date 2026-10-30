import { ErrorCode } from '@ops-console/shared';
import { useEffect } from 'react';
import { Empty } from '../components/ui/empty';
import { ApiError } from '../lib/api';
import { useHealth } from '../lib/queries';
import { sessionToken } from '../lib/session';
import { Shell } from './shell';
import { useUi } from './ui-store';

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div role="status" className="border-2 border-divider bg-surface px-6 py-5 text-[15px]">
        {children}
      </div>
    </div>
  );
}

function Gate() {
  const health = useHealth();
  if (sessionToken() === null) {
    return <SignIn />;
  }
  if (health.isPending) return <Empty>Connecting to the daemon…</Empty>;
  if (health.error instanceof ApiError && health.error.code === ErrorCode.Unauthorized) return <SignIn />;
  if (health.isError) {
    return (
      <Panel>
        The console daemon is not running. Run <code>ops-console start</code>.
      </Panel>
    );
  }
  return <Shell />;
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
    </div>
  );
}
