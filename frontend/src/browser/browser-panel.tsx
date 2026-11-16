import { ChromeState, type Tab, TabAction, type Viewport } from '@ops-console/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Empty } from '../components/ui/empty';
import {
  useBrowserState,
  useClearBrowserData,
  useCloseTab,
  useCreateTab,
  useLocalServers,
  useOpenExternal,
  usePatchTab,
  useProcesses,
  useStoreTab,
} from '../lib/queries';
import { LocalServers } from './local-servers';
import { PageStage } from './page-stage';
import { TabStrip } from './tab-strip';
import { blankTabFor, isBlank } from './tabs';
import { Toolbar } from './toolbar';

/** The Browser panel's size: its width until the operator drags it, its narrowest, and the room the conversation keeps. */
export const BROWSER_PANEL = { key: 'workspace.session-browser-width', initial: 640, narrowest: 360, keep: 360 };

/** A link the operator clicked in the conversation. `id` is new for every click, so the same link opens again. */
export type OpenRequest = { id: number; url: string };

/**
 * The Session's Chrome beside its conversation: tabs, the toolbar, and the page. The tabs live in the daemon, so
 * closing the panel keeps them, and the agent's tabs show here as they open.
 */
export function BrowserPanel({
  sessionId,
  request,
  onClose,
}: {
  sessionId: string;
  request: OpenRequest | null;
  onClose: () => void;
}) {
  const state = useBrowserState(sessionId, true);
  const servers = useLocalServers(sessionId, true, true);
  const processes = useProcesses(sessionId, true);
  const create = useCreateTab(sessionId);
  const patch = usePatchTab(sessionId);
  const close = useCloseTab(sessionId);
  const external = useOpenExternal();
  const clear = useClearBrowserData(sessionId);
  const storeTab = useStoreTab(sessionId);
  const [picked, setPicked] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const tabs = state.data?.tabs ?? [];
  const active = tabs.find((tab) => tab.id === picked) ?? tabs[0];
  const missing = state.data?.chrome === ChromeState.Missing;

  /** An address goes in the blank tab, else in a new one. The daemon's refusal shows under the toolbar. */
  const open = (address: string) => {
    setRefused(null);
    const fail = (error: Error) => setRefused(error.message);
    const blank = blankTabFor(tabs, active);
    if (blank) {
      setPicked(blank.id);
      patch.mutate({ tabId: blank.id, body: { url: address } }, { onError: fail });
    } else create.mutate({ url: address }, { onSuccess: (tab) => setPicked(tab.id), onError: fail });
  };

  const handled = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a request opens once, from the tabs as they are when it arrives
  useEffect(() => {
    if (!request || handled.current === request.id || !state.data || missing) return;
    handled.current = request.id;
    open(request.url);
  }, [request, state.data, missing]);

  const act = (body: { action?: TabAction; viewport?: Viewport }) => {
    if (!active) return;
    setRefused(null);
    patch.mutate({ tabId: active.id, body }, { onError: (error) => setRefused(error.message) });
  };

  let body: ReactNode;
  if (state.isPending) body = <Empty>Reading the browser…</Empty>;
  else if (state.isError) body = <Empty>Could not read the browser: {state.error.message}</Empty>;
  else if (missing) body = <ChromeMissing request={request} />;
  else if (active === undefined) {
    body = (
      <div className="min-h-0 flex-1 overflow-auto bg-card">
        <LocalServers
          servers={servers.data}
          processes={processes.data ?? []}
          error={servers.error?.message ?? null}
          onOpen={open}
        />
      </div>
    );
  } else {
    body = (
      <PageStage
        // A tab's page is its own: another tab starts a new stream.
        key={active.id}
        tab={active}
        overlay={
          active.error !== null ? (
            <PageError tab={active} onReload={() => act({ action: TabAction.Reload })} />
          ) : isBlank(active) ? (
            <LocalServers
              servers={servers.data}
              processes={processes.data ?? []}
              error={servers.error?.message ?? null}
              onOpen={open}
            />
          ) : undefined
        }
        onTab={storeTab}
        onClosed={() => void state.refetch()}
      />
    );
  }

  return (
    <aside aria-label="Browser" className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <div className="flex items-start">
        <div className="min-w-0 flex-1">
          <TabStrip
            tabs={tabs}
            activeId={active?.id}
            onPick={setPicked}
            onClose={(id) => close.mutate(id)}
            onNew={() => {
              setRefused(null);
              create.mutate({}, { onSuccess: (tab) => setPicked(tab.id) });
            }}
          />
        </div>
        <div className="flex flex-none items-center self-stretch bg-surface px-1.5">
          <button
            type="button"
            aria-label="Close the browser"
            title="Close the panel. The tabs stay open."
            onClick={onClose}
            className="cursor-pointer rounded-md border-0 bg-transparent px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 hover:text-text"
          >
            ×
          </button>
        </div>
      </div>
      <Toolbar
        tab={active}
        chromeMissing={missing}
        error={refused}
        onAction={(action) => act({ action })}
        onAddress={open}
        onViewport={(viewport) => act({ viewport })}
        onExternal={() => active && external.mutate(active.id)}
        onClear={() => setClearing(true)}
      />
      {external.isError && (
        <p role="alert" className="m-0 px-3.5 py-1.5 text-xs text-accent-700">
          {external.error.message}
        </p>
      )}
      {body}
      {clearing && (
        <ConfirmDialog
          title="Clear this Session's cookies?"
          action="Clear"
          pending={clear.isPending}
          error={clear.error?.message}
          onConfirm={() => clear.mutate(undefined, { onSuccess: () => setClearing(false) })}
          onCancel={() => {
            clear.reset();
            setClearing(false);
          }}
        >
          Every site this Session signed in to forgets it, and the pages' stored data and cache go. Other Sessions are
          not touched.
        </ConfirmDialog>
      )}
    </aside>
  );
}

function PageError({ tab, onReload }: { tab: Tab; onReload: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-8 text-center">
      <h4 className="m-0 text-base font-semibold">{tab.error}</h4>
      <p className="m-0 max-w-sm text-[13px] text-neutral-700">
        Start the server in this Session or fix the page, then reload.
      </p>
      <Button variant="primary" onClick={onReload}>
        Reload
      </Button>
    </div>
  );
}

function ChromeMissing({ request }: { request: OpenRequest | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 bg-card px-8 text-center">
      <h4 className="m-0 text-base font-semibold">Google Chrome is needed</h4>
      <p className="m-0 max-w-sm text-[13px] text-neutral-700">
        The console runs pages in the Chrome installed on this Mac. Install it, or set OPS_CONSOLE_CHROME_PATH. Links
        still open in your browser.
      </p>
      {request && (
        <a href={request.url} target="_blank" rel="noreferrer" className="text-[13px] text-info">
          Open {request.url} in your browser
        </a>
      )}
    </div>
  );
}
