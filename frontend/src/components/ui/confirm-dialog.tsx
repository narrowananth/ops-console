import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { Button, Spinner } from './button';

/**
 * A modal that asks before an action: a title, what will happen, Cancel and the action. Escape, Cancel and a click
 * on the dimmed page close it. Focus starts on Cancel, so Enter alone never confirms.
 */
export function ConfirmDialog({
  title,
  children,
  action,
  dismiss = 'Cancel',
  pending = false,
  disabled = false,
  error,
  initialFocus,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  /** The confirm button's text, such as "Delete". */
  action: string;
  /** The close button's text, for an action whose own name is Cancel. */
  dismiss?: string;
  pending?: boolean;
  /** The action cannot run yet, such as with nothing picked. */
  disabled?: boolean;
  error?: string | null;
  /** A field in the body that takes focus instead of Cancel, for a dialog the operator opens to type in. */
  initialFocus?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus is set once, when the dialog opens
  useEffect(() => {
    const box = dialog.current;
    if (!box || box.open) return;
    box.showModal();
    (initialFocus?.current ?? cancel.current)?.focus();
    return () => box.close();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog natively; the click is the backdrop
    <dialog
      ref={dialog}
      role="alertdialog"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      onClick={(event) => {
        // A click on the dialog element itself, not its box, landed on the backdrop.
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
      className="m-auto w-[min(420px,calc(100vw-32px))] rounded-xl border border-line bg-card p-0 text-text shadow-2xl backdrop:bg-neutral-900/35"
    >
      <div className="flex flex-col gap-2 px-5 pt-5 pb-4">
        <h2 id="confirm-title" className="m-0 font-heading text-base">
          {title}
        </h2>
        {children && <div className="text-[13px] text-neutral-700">{children}</div>}
        {error && (
          <p role="alert" className="m-0 text-xs text-accent-700">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-line bg-surface/40 px-5 py-3">
        <Button ref={cancel} className="px-3 py-1.5 text-xs" disabled={pending} onClick={onCancel}>
          {dismiss}
        </Button>
        <Button variant="primary" className="px-3 py-1.5 text-xs" disabled={pending || disabled} onClick={onConfirm}>
          {pending && <Spinner />}
          {action}
        </Button>
      </div>
    </dialog>
  );
}
