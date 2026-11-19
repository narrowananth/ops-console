import { Hint } from './tip';

/** A row of radio options drawn as a pill group; the legend names the choice. */
export function Segmented<T extends string>({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  /** `title` shows on hover: what the option does, or why it is off. */
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <legend className="flex items-center gap-1.5 p-0 text-xs font-semibold">
        {label} {hint && <Hint text={hint} />}
      </legend>
      <div className="flex w-max gap-0.5 rounded-lg bg-neutral-200 p-1">
        {options.map((option) => (
          <label
            key={option.value}
            title={option.title}
            className={`rounded-md px-3.5 py-1.5 text-xs transition-colors has-focus-visible:outline-2 has-focus-visible:outline-accent ${option.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${
              value === option.value
                ? 'bg-card font-semibold text-text shadow-sm'
                : 'bg-transparent text-neutral-700 hover:text-text'
            }`}
          >
            <input
              type="radio"
              name={label}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
