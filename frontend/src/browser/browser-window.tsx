import type { TabAction, Viewport } from '@ops-console/shared';
import { useEffect, useState } from 'react';
import { Empty } from '../components/ui/empty';
import { ApiError } from '../lib/api';
import { useBrowserState, useOpenExternal, usePatchTab, useStoreTab } from '../lib/queries';
import { openInspector } from './inspector-window';
import { PageStage } from './page-stage';
import { Toolbar } from './toolbar';

/**
 * One tab of a Session's Chrome in a window of its own, at `/browser-window/:sessionId/:tabId`: the panel's toolbar and
 * page, without the tab strip. The window is one more viewer of the tab, so the tab takes its size once the operator
 * types or clicks here.
 */
export function BrowserWindow({ sessionId, tabId }: { sessionId: string; tabId: string }) {
  const state = useBrowserState(sessionId, true);
  const tab = state.data?.tabs.find((candidate) => candidate.id === tabId);
  const patch = usePatchTab(sessionId);
  const external = useOpenExternal();
  const storeTab = useStoreTab(sessionId);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    document.title = tab?.title || 'Ops Console browser';
  }, [tab?.title]);

  if (state.isPending) return <Empty>Reading the browser…</Empty>;
  if (state.isError) {
    const gone = state.error instanceof ApiError && state.error.status === 404;
    return <Empty>{gone ? 'This Session was deleted.' : `Could not read the browser: ${state.error.message}`}</Empty>;
  }
  if (tab === undefined) return <Empty>This tab was closed.</Empty>;

  const change = (body: { url?: string; action?: TabAction; viewport?: Viewport }) => {
    setRefused(null);
    patch.mutate({ tabId, body }, { onError: (error) => setRefused(error.message) });
  };
  return (
    <section aria-label="Browser window" className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <Toolbar
        tab={tab}
        chromeMissing={false}
        error={refused}
        onAction={(action) => change({ action })}
        onAddress={(url) => change({ url })}
        onViewport={(viewport) => change({ viewport })}
        onInspect={() => {
          setRefused(null);
          if (!openInspector(tabId)) setRefused('The browser blocked the window. Allow pop-ups for this page.');
        }}
        onExternal={() => external.mutate(tabId)}
      />
      {external.isError && (
        <p role="alert" className="m-0 px-3.5 py-1.5 text-xs text-accent-700">
          {external.error.message}
        </p>
      )}
      <PageStage tab={tab} onTab={storeTab} onClosed={() => void state.refetch()} />
    </section>
  );
}
