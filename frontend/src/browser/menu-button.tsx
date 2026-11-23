import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { item, menu } from '../components/ui/item';

/**
 * A button that opens a floating menu under it, right edge to right edge. The menu floats over the page, so a panel
 * that clips its contents does not cut it; a scroll or a resize closes it, as does Escape and a click outside.
 */
export function MenuButton({
  label,
  title,
  disabled = false,
  className = '',
  width = 'w-64',
  opens = 'down',
  icon = false,
  children,
  menuChildren,
}: {
  label: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  width?: string;
  opens?: 'up' | 'down';
  /** A bare square for an icon, in place of the bordered button. */
  icon?: boolean;
  /** The button's face. */
  children: ReactNode;
  menuChildren: (close: () => void) => ReactNode;
}) {
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = place !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPlace(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      trigger.current?.focus();
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest('[data-menu-button]'))) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = () => {
    const box = trigger.current?.getBoundingClientRect();
    if (open || !box) return setPlace(null);
    const right = Math.max(8, window.innerWidth - box.right);
    setPlace(
      opens === 'up'
        ? { bottom: window.innerHeight - box.top + 4, right, maxHeight: box.top - 16 }
        : { top: box.bottom + 4, right, maxHeight: window.innerHeight - box.bottom - 16 },
    );
  };

  return (
    <div className={`relative flex-none ${className}`}>
      {open && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="fixed inset-0 z-50 cursor-default"
          onClick={() => setPlace(null)}
        />
      )}
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={toggle}
        className={
          icon
            ? `flex size-7 cursor-pointer items-center justify-center rounded-md border-0 p-0 text-neutral-700 transition-colors hover:bg-neutral-200 hover:text-text disabled:cursor-not-allowed disabled:opacity-50 ${open ? 'bg-neutral-200' : 'bg-transparent'}`
            : `flex cursor-pointer items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1 text-xs text-text transition-colors hover:border-neutral-400 disabled:cursor-not-allowed disabled:opacity-50 ${open ? 'border-accent-400' : 'border-line'}`
        }
      >
        {children}
      </button>
      {place && (
        <div
          role="menu"
          aria-label={label}
          data-menu-button
          style={place}
          className={`fixed z-51 max-w-[calc(100vw-16px)] overflow-auto ${menu} ${width}`}
        >
          {menuChildren(() => setPlace(null))}
        </div>
      )}
    </div>
  );
}

/** A row in a `MenuButton`'s menu. Give `selected` for a choice among several: the picked one is ticked. */
export function MenuItem({
  selected,
  disabled = false,
  hint,
  title,
  onClick,
  children,
}: {
  selected?: boolean;
  disabled?: boolean;
  /** Small text at the right edge, such as a size. */
  hint?: string;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a choice among several is a menuitemradio, which takes aria-checked
    <button
      type="button"
      role={selected === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={selected}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] outline-none focus-visible:bg-neutral-200 ${item(selected === true)}`}
    >
      <span className={`min-w-0 flex-1 truncate ${selected ? 'font-semibold' : ''}`}>{children}</span>
      {hint && <span className="flex-none font-mono text-xs text-neutral-600">{hint}</span>}
      {selected !== undefined && (
        <span aria-hidden className={`w-3 flex-none text-xs ${selected ? 'text-accent' : 'invisible'}`}>
          ✓
        </span>
      )}
    </button>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-1.5 pb-1 text-xs font-semibold tracking-[0.06em] text-neutral-600 uppercase">
      {children}
    </div>
  );
}

export function MenuRule() {
  return <hr className="my-1.5 border-0 border-t border-line" />;
}
