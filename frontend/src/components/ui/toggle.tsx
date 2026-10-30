/** On/off switch: a square knob that slides right and fills with the accent when on. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex h-6 w-11 flex-none cursor-pointer border-[1.5px] border-text p-0 disabled:cursor-default disabled:opacity-60 ${
        checked ? 'justify-end bg-accent' : 'justify-start bg-bg'
      }`}
    >
      <span className={`m-[1.5px] size-4.5 ${checked ? 'bg-bg' : 'bg-text'}`} />
    </button>
  );
}
