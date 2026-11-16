import { createContext, useContext } from 'react';

/**
 * How a link in a Session's conversation opens in that Session's Browser panel. A Session view provides it when the
 * Session has a Browser button and the link setting is "In the console"; with none, every link opens in a new tab of
 * the operator's browser.
 */
const BrowserLinks = createContext<((url: string) => void) | null>(null);

export const BrowserLinksProvider = BrowserLinks.Provider;

export function useBrowserPanel(): { open: (url: string) => void } | null {
  const open = useContext(BrowserLinks);
  return open === null ? null : { open };
}
