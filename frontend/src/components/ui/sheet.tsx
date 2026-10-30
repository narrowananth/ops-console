import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { Button } from './button';

/** A panel docked to the right edge over a dimmed page; closes on the backdrop, Escape or the X. */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-neutral-900/35" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-0 right-0 bottom-0 z-41 flex w-[600px] max-w-screen flex-col border-l-2 border-text bg-bg text-text shadow-lg"
        >
          <div className="flex items-center gap-2.5 border-b-2 border-divider px-5 py-3.5">
            <Dialog.Title asChild>
              <h4 className="m-0">{title}</h4>
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button icon variant="secondary" aria-label="Close" title="Close" className="ml-auto size-7.5 border-0">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </Button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
