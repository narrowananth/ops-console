import type { Tab } from '@ops-console/shared';

/** A tab with no page yet: the one a new panel opens with, and the one "+" makes. */
export const isBlank = (tab: Pick<Tab, 'url'>): boolean => tab.url === '' || tab.url === 'about:blank';

/**
 * The tab an address opens in: the one in front when it is blank, else any blank one. `undefined` means a new tab.
 */
export function blankTabFor(tabs: readonly Tab[], active: Tab | undefined): Tab | undefined {
  return active && isBlank(active) ? active : tabs.find(isBlank);
}
