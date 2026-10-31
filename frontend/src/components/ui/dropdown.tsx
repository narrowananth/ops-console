import { type CSSProperties, useEffect, useRef, useState } from 'react';

export type DropdownOption<T extends string> = { value: T; label: string; description?: string };

/**
 * A button that opens a list of options with descriptions; the current one carries an accent bar. `chip` is the
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

  const toggle = () => {
    const box = trigger.current?.getBoundingClientRect();
    if (open || !box) return setPlace(null);
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
            ? `flex cursor-pointer items-center gap-1.25 border bg-transparent px-2.25 py-1 text-xs text-text hover:border-divider disabled:cursor-not-allowed disabled:opacity-50 ${
                open ? 'border-text' : 'border-transparent'
              }`
            : 'flex w-full cursor-pointer items-center gap-2 border-[1.5px] border-text bg-bg px-2.5 py-1.5 text-left text-[13px] text-text disabled:cursor-not-allowed disabled:opacity-50'
        }
      >
        {chip && caption && <span className="text-neutral-700">{caption}</span>}
        <span className={chip ? 'font-semibold' : 'min-w-0 flex-1 truncate'}>{current?.label ?? value}</span>
        <span className={`text-[9px] ${chip ? 'text-neutral-600' : ''}`} aria-hidden>
          ▼
        </span>
      </button>
      {place && (
        <div
          role="listbox"
          aria-label={label}
          style={place}
          className={`fixed z-51 max-h-80 max-w-[calc(100vw-16px)] overflow-auto border-2 border-text bg-bg shadow-lg ${listClassName}`}
        >
          {heading && <div className="px-3 pt-2 pb-1 text-[11px] font-extrabold text-neutral-700">{heading}</div>}
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
                className={`flex w-full cursor-pointer items-start gap-2.5 border-0 border-l-3 px-3 py-2 text-left text-text hover:bg-neutral-200 ${
                  selected ? 'border-l-accent bg-neutral-200 font-extrabold' : 'border-l-transparent bg-transparent'
                }`}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] break-words">{option.label}</span>
                  {option.description && (
                    <span className="text-[11px] font-normal text-neutral-700">{option.description}</span>
                  )}
                </span>
                {option.value === defaultValue && (
                  <span className="text-[10px] font-normal whitespace-nowrap text-neutral-700">default</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
