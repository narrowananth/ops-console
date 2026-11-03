import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { item, menu } from './item';

export type DropdownOption<T extends string> = { value: T; label: string; description?: string };

/**
 * A button that opens a list of options with descriptions; the current one is tinted and ticked. `chip` is the
 * composer's borderless `Label Value ▼` button, whose list opens upward under a heading unless `opens` says down.
 * The list floats over the page, so a scrolling pane around the button does not clip it; scrolling closes it.
 */
export function Dropdown<T extends string>({
  label,
  caption = label,
  value,
  options,
  onChange,
  className = '',
  listClassName = 'w-68',
  variant = 'field',
  opens = variant === 'chip' ? 'up' : 'down',
  align = variant === 'chip' && opens === 'up' ? 'left' : 'right',
  heading,
  defaultValue,
  title,
  disabled = false,
}: {
  label: string;
  /** The text a chip shows before its value; empty for none. */
  caption?: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  /** The list's width. */
  listClassName?: string;
  variant?: 'field' | 'chip';
  opens?: 'up' | 'down';
  /** Which edge of the button the list lines up with. */
  align?: 'left' | 'right';
  heading?: string;
  /** Tagged `default` in the list. */
  defaultValue?: T;
  title?: string;
  disabled?: boolean;
}) {
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The list renders hidden first, so its height is known before it picks a side.
  const [measured, setMeasured] = useState(false);
  const open = place !== null;
  const current = options.find((option) => option.value === value);
  const chip = variant === 'chip';

  useEffect(() => {
    if (!open) return;
    const close = () => setPlace(null);
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close();
    // A scroll anywhere but inside the list would leave it floating away from its button.
    const scroll = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest('[role=listbox]'))) close();
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

  // `opens` is the preferred side. A list taller than the room there opens on the other side when that has more
  // room, and scrolls inside whatever room it gets.
  useLayoutEffect(() => {
    if (!open || measured) return;
    const box = trigger.current?.getBoundingClientRect();
    const height = list.current?.scrollHeight;
    if (!box || height === undefined) return;
    const margin = 8;
    const below = window.innerHeight - box.bottom - 4 - margin;
    const above = box.top - 6 - margin;
    const preferred = opens === 'up' ? above : below;
    const other = opens === 'up' ? below : above;
    const side = height <= preferred || preferred >= other ? opens : opens === 'up' ? 'down' : 'up';
    const room = side === 'up' ? above : below;
    setPlace((now) => {
      if (now === null) return now;
      const { top: _top, bottom: _bottom, ...rest } = now;
      return {
        ...rest,
        ...(side === 'up' ? { bottom: window.innerHeight - box.top + 6 } : { top: box.bottom + 4 }),
        maxHeight: Math.min(320, room),
      };
    });
    setMeasured(true);
  }, [open, measured, opens]);

  const toggle = () => {
    const box = trigger.current?.getBoundingClientRect();
    if (open || !box) return setPlace(null);
    setMeasured(false);
    setPlace({
      ...(opens === 'up' ? { bottom: window.innerHeight - box.top + 6 } : { top: box.bottom + 4 }),
      ...(align === 'left' ? { left: box.left } : { right: window.innerWidth - box.right }),
      minWidth: variant === 'field' ? box.width : undefined,
    });
  };

  return (
    <div className={`relative ${className}`}>
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
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={toggle}
        className={
          chip
            ? `flex cursor-pointer items-center gap-1.25 rounded-full border px-3 py-1 text-xs text-text transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-50 ${
                open ? 'border-divider bg-neutral-200' : 'border-transparent bg-transparent'
              }`
            : `flex w-full cursor-pointer items-center gap-2 rounded-md border bg-card px-3 py-2 text-left text-[13px] text-text shadow-sm transition-colors hover:border-neutral-400 disabled:cursor-not-allowed disabled:opacity-50 ${
                open ? 'border-accent-400 shadow-[0_0_0_3px_var(--color-accent-100)]' : 'border-divider'
              }`
        }
      >
        {chip && caption && <span className="text-neutral-700">{caption}</span>}
        <span className={chip ? 'font-semibold' : 'min-w-0 flex-1 truncate'}>{current?.label ?? value}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden
          className={`flex-none text-neutral-600 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {place && (
        <div
          role="listbox"
          aria-label={label}
          ref={list}
          style={{ ...place, visibility: measured ? undefined : 'hidden' }}
          className={`fixed z-51 max-h-80 max-w-[calc(100vw-16px)] overflow-auto ${menu} ${listClassName}`}
        >
          {heading && (
            <div className="px-2.5 pt-1.5 pb-1 text-xs font-semibold tracking-[0.06em] text-neutral-600 uppercase">
              {heading}
            </div>
          )}
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setPlace(null);
                  if (!selected) onChange(option.value);
                }}
                className={`flex w-full items-start gap-2.5 px-2.5 py-2 ${item(selected)}`}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={`text-[13px] break-words ${selected ? 'font-semibold' : ''}`}>{option.label}</span>
                  {option.description && (
                    <span className="text-xs font-normal text-neutral-700">{option.description}</span>
                  )}
                </span>
                {option.value === defaultValue && (
                  <span className="mt-0.5 rounded-full bg-neutral-200 px-1.5 text-xs whitespace-nowrap text-neutral-700">
                    default
                  </span>
                )}
                <span aria-hidden className={`mt-0.5 w-3 flex-none text-xs ${selected ? 'text-accent' : 'invisible'}`}>
                  ✓
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
