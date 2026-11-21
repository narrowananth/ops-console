import type { Tab } from '@ops-console/shared';

/** A tab with no page yet: the one a new panel opens with, and the one "+" makes. */
export const isBlank = (tab: Pick<Tab, 'url'>): boolean => tab.url === '' || tab.url === 'about:blank';

/**
 * The tab an address opens in: the one in front when it is blank, else any blank one. `undefined` means a new tab.
 */
export function blankTabFor(tabs: readonly Tab[], active: Tab | undefined): Tab | undefined {
  return active && isBlank(active) ? active : tabs.find(isBlank);
}

/**
 * The tab already on the address's site (same scheme, host and port): the one in front when it matches, else the
 * first. An address opens there and the page reloads, instead of piling up a tab per open. `undefined` means none.
 */
export function tabOnSite(tabs: readonly Tab[], active: Tab | undefined, address: string): Tab | undefined {
  const site = originOf(address);
  if (site === null) return undefined;
  const same = (tab: Tab) => originOf(tab.url) === site;
  return active && same(active) ? active : tabs.find(same);
}

function originOf(address: string): string | null {
  try {
    const { origin } = new URL(address);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}
