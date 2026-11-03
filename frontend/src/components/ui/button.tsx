import { type ButtonHTMLAttributes, forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';

const variants: Record<Variant, string> = {
  primary:
    'border-accent bg-accent text-white shadow-[0_1px_2px_rgb(236_48_19/0.25),0_2px_8px_rgb(236_48_19/0.18)] hover:bg-accent-600 active:bg-accent-700 disabled:border-neutral-300 disabled:bg-neutral-300 disabled:text-neutral-700 disabled:hover:bg-neutral-300',
  secondary: 'border-divider bg-card shadow-sm hover:bg-neutral-200',
  ghost: 'border-transparent text-accent hover:bg-accent/10',
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', icon = false, className = '', type = 'button', ...props },
  ref,
) {
  const size = icon ? 'size-9 justify-center p-0' : 'px-4 py-2';
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border font-heading text-sm font-semibold transition-[background-color,box-shadow,transform] duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none disabled:active:translate-y-0 ${variants[variant]} ${size} ${className}`}
      {...props}
    />
  );
});

/** A small turning ring for a button whose work is still going. */
export function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3 flex-none animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
