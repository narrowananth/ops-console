const WINDOW_FEATURES = 'popup=yes,width=1100,height=800';

/** The address of a tab's Inspector window: Chrome's DevTools, served by the daemon, told which socket to talk to. */
export const inspectorPath = (tabId: string) =>
  `/devtools-frontend/devtools_app.html?ws=${window.location.host}/browser/${tabId}/devtools`;

const open = new Map<string, Window>();

/**
 * Opens a tab's Inspector window, or brings the one already open forward, with DevTools' state as the operator left
 * it. False when the browser refused the window. The address names the tab only: `devtools-socket.js`, which runs in
 * the window ahead of DevTools, adds the token from local storage.
 */
export function openInspector(tabId: string): boolean {
  const current = open.get(tabId);
  if (current && !current.closed) {
    current.focus();
    return true;
  }
  const opened = window.open(inspectorPath(tabId), `ops-console-inspect-${tabId}`, WINDOW_FEATURES);
  if (!opened) return false;
  open.set(tabId, opened);
  return true;
}
