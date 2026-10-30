import { type ButtonHTMLAttributes, forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-bg hover:bg-accent-600 active:bg-accent-700',
  secondary: 'border-divider hover:bg-text/7',
  ghost: 'text-accent hover:bg-accent/10',
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', icon = false, className = '', type = 'button', ...props },
  ref,
) {
  const size = icon ? 'size-9 justify-center p-0' : 'px-3.5 py-2';
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex cursor-pointer items-center gap-2 border font-heading text-sm font-extrabold border-transparent ${variants[variant]} ${size} ${className}`}
      {...props}
    />
  );
});
