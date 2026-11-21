import { useCallback, useEffect, useRef, useState } from 'react';

const WINDOW_FEATURES = 'popup=yes,width=1280,height=860';
const CLOSED_CHECK_MS = 500;

/** The address of a tab's own window. It names the Session and the tab; the token stays in local storage. */
export const browserWindowPath = (sessionId: string, tabId: string) => `/browser-window/${sessionId}/${tabId}`;

/**
 * The tabs of this panel that sit in a window of their own. A window has no event for its closing, so it is checked
 * twice a second while one is open. Naming the window by its tab makes a second open reuse the first.
 */
export function usePopOuts() {
  const windows = useRef(new Map<string, Window>());
  const [out, setOut] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (out.size === 0) return;
    const timer = setInterval(() => {
      const still = [...out].filter((id) => windows.current.get(id)?.closed === false);
      if (still.length === out.size) return;
      for (const id of out) if (!still.includes(id)) windows.current.delete(id);
      setOut(new Set(still));
    }, CLOSED_CHECK_MS);
    return () => clearInterval(timer);
  }, [out]);

  /** Opens the tab in a window; false when the browser refused to. */
  const open = useCallback((sessionId: string, tabId: string): boolean => {
    const opened = window.open(browserWindowPath(sessionId, tabId), `ops-console-tab-${tabId}`, WINDOW_FEATURES);
    if (!opened) return false;
    windows.current.set(tabId, opened);
    setOut((now) => new Set(now).add(tabId));
    return true;
  }, []);

  const show = useCallback((tabId: string) => windows.current.get(tabId)?.focus(), []);

  const bringBack = useCallback((tabId: string) => {
    windows.current.get(tabId)?.close();
    windows.current.delete(tabId);
    setOut((now) => {
      const next = new Set(now);
      next.delete(tabId);
      return next;
    });
  }, []);

  return { out, open, show, bringBack };
}
