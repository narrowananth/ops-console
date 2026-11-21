import type { ReactNode } from 'react';

type Width = 'full' | 'narrow' | 'wide' | 'xwide';

const WIDTH: Record<Width, string> = { full: '', narrow: 'max-w-250', wide: 'max-w-280', xwide: 'max-w-350' };

/**
 * A sidebar page. The sidebar already names the page, so a page with no actions has no bar: its title stays as a
 * hidden h1 and the body takes the whole height. A page with actions gets one slim bar, the title small on the left
 * (the line under it is the tooltip) and the actions on the right. A page whose body is one centered column passes
 * its width, so the bar lines up with the column.
 */
export function Page({
  title,
  sub,
  actions,
  width = 'full',
  children,
}: {
  title: string;
  sub: string;
  actions?: ReactNode;
  width?: Width;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {actions ? (
        <header className="h-10 flex-none border-b border-line">
          <div className={`mx-auto flex h-full w-full items-center gap-2 px-8 ${WIDTH[width]}`}>
            <h1 title={sub} className="m-0 flex-none text-[13px] whitespace-nowrap">
              {title}
            </h1>
            <span className="flex-1" />
            <div className="flex items-center gap-2 [&>button]:py-1 [&>button]:text-[13px]">{actions}</div>
          </div>
        </header>
      ) : (
        <h1 className="sr-only">{title}</h1>
      )}
      <div className="flex min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

/** A settings-style page body: a readable column, centered, with room around it. */
export function PageColumn({
  children,
  wide = false,
  xwide = false,
}: {
  children: ReactNode;
  wide?: boolean;
  xwide?: boolean;
}) {
  return (
    <div className={`mx-auto w-full self-start px-8 py-7 ${WIDTH[xwide ? 'xwide' : wide ? 'wide' : 'narrow']}`}>
      {children}
    </div>
  );
}

/** One group of settings on a column page: a heading and a line under it, then its rows in a card. */
export function Section({
  title,
  sub,
  aside,
  children,
}: {
  title: string;
  sub?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mb-8 last:mb-0">
      <div className="mb-3 flex items-end gap-4 px-1">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[15px]">{title}</h2>
          {sub && <p className="mt-1 mb-0 text-xs text-neutral-700">{sub}</p>}
        </div>
        {aside}
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">{children}</div>
    </section>
  );
}
