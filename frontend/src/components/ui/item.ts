/**
 * A pickable row in a list, menu or tab strip: inset from its container, rounded, tinted when picked. Every selection
 * in the console looks like this one.
 */
export const item = (selected: boolean) =>
  `cursor-pointer rounded-md border-0 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    selected
      ? 'bg-accent-100 text-accent-900 shadow-[inset_0_0_0_1px_var(--color-accent-200)]'
      : 'bg-transparent text-text hover:bg-neutral-200'
  }`;

/** The floating box a menu opens in. */
export const menu = 'rounded-lg border border-line bg-card p-1.5 shadow-lg';
