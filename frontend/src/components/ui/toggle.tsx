/** On/off switch: a round knob that slides right as the pill fills with the accent. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Shown on hover: what the switch does, or why it is off limits. */
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6.5 w-11.5 flex-none cursor-pointer rounded-full border-0 p-0 transition-colors duration-200 disabled:cursor-default disabled:opacity-60 ${
        checked ? 'bg-accent' : 'bg-neutral-400'
      }`}
    >
      <span
        className={`absolute top-0.75 size-5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-[left] duration-200 ${
          checked ? 'left-5.75' : 'left-0.75'
        }`}
      />
    </button>
  );
}
