import { type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { DockBottomIcon, DockRightIcon, DockWindowIcon } from '../components/ui/icons';
import { useStored } from '../lib/remember';
import { inspectorPath } from './inspector-window';

const DOCK_SIDES = ['bottom', 'right'] as const;
export type DockSide = (typeof DOCK_SIDES)[number];

/** Where DevTools sit in the panel. Kept per browser. */
export function useDockSide() {
  return useStored<DockSide>('browser.inspector-dock', z.enum(DOCK_SIDES), 'bottom');
}

/** Per side: the stored size of the DevTools part, where it starts, its smallest, and the least the page keeps. */
const SIZES = {
  bottom: { key: 'browser.inspector-height', initial: 360, least: 160, pageLeast: 120 },
  right: { key: 'browser.inspector-width', initial: 520, least: 240, pageLeast: 200 },
} as const;
const STEP = 32;

/** The tabs of this panel that have DevTools docked in it. */
export function useDockedTabs() {
  const [docked, setDocked] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (tabId: string) =>
      setDocked((now) => {
        const next = new Set(now);
        if (!next.delete(tabId)) next.add(tabId);
        return next;
      }),
    [],
  );
  const close = useCallback(
    (tabId: string) =>
      setDocked((now) => {
        const next = new Set(now);
        next.delete(tabId);
        return next;
      }),
    [],
  );
  return { docked, toggle, close };
}

const DOCK_BUTTON =
  'flex size-6 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-neutral-700 hover:bg-neutral-200 hover:text-text aria-pressed:bg-neutral-200 aria-pressed:text-accent-700';

/** The bar between the page and DevTools: drag it, or press the arrow keys on it, to resize DevTools. Double click resets. */
function Splitter({
  side,
  size,
  least,
  widest,
  onSize,
  onReset,
}: {
  side: DockSide;
  size: number;
  least: number;
  widest: number;
  onSize: (size: number) => void;
  onReset: () => void;
}) {
  const start = useRef<{ at: number; size: number } | null>(null);
  const bottom = side === 'bottom';
  const point = (event: { clientX: number; clientY: number }) => (bottom ? event.clientY : event.clientX);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a bar that resizes is a separator; <hr> cannot take focus or drags
    <div
      role="separator"
      aria-orientation={bottom ? 'horizontal' : 'vertical'}
      aria-label="Resize DevTools"
      aria-valuenow={size}
      aria-valuemin={least}
      aria-valuemax={widest}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { at: point(event), size };
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        if (start.current) onSize(start.current.size + start.current.at - point(event));
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        start.current = null;
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const grow = bottom ? 'ArrowUp' : 'ArrowLeft';
        const shrink = bottom ? 'ArrowDown' : 'ArrowRight';
        if (event.key === grow) onSize(size + STEP);
        else if (event.key === shrink) onSize(size - STEP);
        else return;
        event.preventDefault();
      }}
      className={`flex-none touch-none outline-none hover:bg-accent-200 focus-visible:bg-accent-300 ${
        bottom ? 'h-1.5 cursor-row-resize border-t border-line' : 'w-1.5 cursor-col-resize border-l border-line'
      }`}
    />
  );
}

/**
 * The page area, with Chrome's DevTools docked beside it or under it when `inspecting` names a tab. The page is the
 * first child of the area, so it measures only its own part: docking shrinks it and closing gives the room back.
 */
export function InspectorLayout({
  inspecting,
  onClose,
  onWindow,
  children,
}: {
  /** The tab whose DevTools are docked, or null. */
  inspecting: string | null;
  onClose: () => void;
  /** Takes DevTools out of the panel into a window of their own. */
  onWindow: () => void;
  children: ReactNode;
}) {
  const [side, setSide] = useDockSide();
  const [height, setHeight] = useStored(SIZES.bottom.key, z.number(), SIZES.bottom.initial);
  const [width, setWidth] = useStored(SIZES.right.key, z.number(), SIZES.right.initial);
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!area) return;
    const observer = new ResizeObserver(() => setRoom({ width: area.clientWidth, height: area.clientHeight }));
    observer.observe(area);
    setRoom({ width: area.clientWidth, height: area.clientHeight });
    return () => observer.disconnect();
  }, [area]);

  const spec = SIZES[side];
  const total = side === 'bottom' ? room.height : room.width;
  const widest = Math.max(spec.least, total - spec.pageLeast);
  const clamp = (next: number) => Math.round(Math.min(widest, Math.max(spec.least, next)));
  const size = clamp(side === 'bottom' ? height : width);
  const resize = (next: number) => (side === 'bottom' ? setHeight : setWidth)(clamp(next));

  return (
    <div ref={setArea} className={`flex min-h-0 min-w-0 flex-1 ${side === 'bottom' ? 'flex-col' : 'flex-row'}`}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      {inspecting !== null && (
        <section
          aria-label="DevTools"
          style={side === 'bottom' ? { height: size } : { width: size }}
          className={`flex flex-none bg-card ${side === 'bottom' ? 'flex-col' : 'flex-row'}`}
        >
          <Splitter
            side={side}
            size={size}
            least={spec.least}
            widest={widest}
            onSize={resize}
            onReset={() => resize(spec.initial)}
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-1 border-b border-line bg-surface px-2 py-1">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">DevTools</span>
              <button
                type="button"
                aria-label="Open DevTools in a window"
                title="Open DevTools in a window of their own"
                onClick={onWindow}
                className={DOCK_BUTTON}
              >
                <DockWindowIcon />
              </button>
              <button
                type="button"
                aria-label="Dock to the bottom"
                title="Dock to the bottom"
                aria-pressed={side === 'bottom'}
                onClick={() => setSide('bottom')}
                className={DOCK_BUTTON}
              >
                <DockBottomIcon />
              </button>
              <button
                type="button"
                aria-label="Dock to the right"
                title="Dock to the right"
                aria-pressed={side === 'right'}
                onClick={() => setSide('right')}
                className={DOCK_BUTTON}
              >
                <DockRightIcon />
              </button>
              <button
                type="button"
                aria-label="Close DevTools"
                title="Close DevTools"
                onClick={onClose}
                className={`${DOCK_BUTTON} text-sm`}
              >
                <span aria-hidden>×</span>
              </button>
            </div>
            {/* A tab's DevTools are its own: another tab starts them over. */}
            <iframe
              key={inspecting}
              title="DevTools"
              src={inspectorPath(inspecting)}
              allow="clipboard-read; clipboard-write"
              className="min-h-0 w-full flex-1 border-0 bg-white"
            />
          </div>
        </section>
      )}
    </div>
  );
}
