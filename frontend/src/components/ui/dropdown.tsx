import { useState } from 'react';

export type DropdownOption<T extends string> = { value: T; label: string; description: string };

/** A button that opens a list of options with descriptions; the current one carries an accent bar. */
export function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value);
  return (
    <div className={`relative ${className}`}>
      {open && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="fixed inset-0 z-50 cursor-default"
          onClick={() => setOpen(false)}
        />
      )}
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 border-[1.5px] border-text bg-bg px-2.5 py-1.5 text-left text-[13px] text-text"
      >
        <span className="flex-1">{current?.label ?? value}</span>
        <span className="text-[9px]" aria-hidden>
          ▼
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={label}
          className="absolute top-[calc(100%+4px)] right-0 z-51 max-h-80 w-68 overflow-auto border-2 border-text bg-bg shadow-lg"
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setOpen(false);
                  if (!selected) onChange(option.value);
                }}
                className={`flex w-full cursor-pointer flex-col border-0 border-l-3 px-3 py-2 text-left text-text hover:bg-neutral-200 ${
                  selected ? 'border-l-accent bg-neutral-200 font-extrabold' : 'border-l-transparent bg-transparent'
                }`}
              >
                <span className="text-[13px]">{option.label}</span>
                <span className="text-[11px] font-normal text-neutral-700">{option.description}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
