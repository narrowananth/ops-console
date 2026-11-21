import { useEffect, useRef, useState } from 'react';
import { ResizeHandle } from '../components/ui/resize-handle';
import { AlertView } from './alert-view';

/** The width every opening starts at. Dragging the left edge widens or narrows it until the drawer closes. */
const DEFAULT_WIDTH = 580;
const NARROWEST = 380;
/** Room the table keeps beside the widest drawer. */
const KEEP = 200;

/**
 * The picked Alert, in a drawer over the right of the Monitor. It opens at one size each time; drag its left edge to
 * make it wider. Esc, the close button or a click on the dimmed rest closes it; the Alert's address goes with it.
 */
export function AlertDrawer({
  id,
  container,
  onClose,
}: {
  id: string | null;
  /** The Monitor's box, which bounds how wide the drawer may grow. */
  container: HTMLElement | null;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const open = id !== null;
  const [wanted, setWanted] = useState(DEFAULT_WIDTH);
  const [room, setRoom] = useState<number | null>(null);
  useEffect(() => {
    if (!container) return;
    const observer = new ResizeObserver(() => setRoom(container.clientWidth));
    observer.observe(container);
    setRoom(container.clientWidth);
    return () => observer.disconnect();
  }, [container]);
  // Closing puts the size back, so the next Alert opens at the default.
  useEffect(() => {
    if (!open) setWanted(DEFAULT_WIDTH);
  }, [open]);
  const widest = Math.max(NARROWEST, (room ?? DEFAULT_WIDTH + KEEP) - KEEP);
  const clamp = (next: number) => Math.round(Math.min(widest, Math.max(NARROWEST, next)));
  const width = clamp(wanted);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      // A menu or dropdown open inside the drawer takes the Escape first.
      if (event.key === 'Escape' && !panel.current?.querySelector('[aria-expanded="true"][aria-haspopup]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={onClose}
        className={`absolute inset-0 z-30 cursor-default border-0 bg-black/20 transition-opacity ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      />
      {/* An open drawer has no transform: a transformed box would hold the menus that float inside it. */}
      <aside
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-label="Alert"
        aria-hidden={!open}
        style={{ width }}
        className={`absolute inset-y-0 right-0 z-31 flex max-w-full bg-bg shadow-lg outline-none transition-[translate,visibility] duration-200 ${open ? 'visible [translate:none]' : 'invisible translate-x-[102%]'}`}
      >
        <ResizeHandle
          label="Resize the Alert"
          width={width}
          initial={DEFAULT_WIDTH}
          narrowest={NARROWEST}
          widest={widest}
          onWidth={(next) => setWanted(clamp(next))}
        />
        <div className="flex min-w-0 flex-1 flex-col">{id && <AlertView key={id} id={id} onClose={onClose} />}</div>
      </aside>
    </>
  );
}
