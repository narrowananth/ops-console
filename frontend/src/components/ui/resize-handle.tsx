import { type PointerEvent, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useStored } from '../../lib/remember';

/** How a side panel is sized: its stored key, the width it starts at, its narrowest, and what stays for its neighbour. */
export type PanelSize = { key: string; initial: number; narrowest: number; keep: number };

/**
 * A side panel's width, kept through reloads, and the widest it may be in `container` now: the neighbour keeps its
 * room as the window narrows, and the stored width comes back as it widens.
 */
export function usePanelWidth(size: PanelSize, container: HTMLElement | null) {
  const { key, initial, narrowest, keep } = size;
  const [stored, setStored] = useStored(key, z.number(), initial);
  const [room, setRoom] = useState<number | null>(null);
  useEffect(() => {
    const node = container;
    if (!node) return;
    const observer = new ResizeObserver(() => setRoom(node.clientWidth));
    observer.observe(node);
    setRoom(node.clientWidth);
    return () => observer.disconnect();
  }, [container]);
  const widest = Math.max(narrowest, (room ?? initial + keep) - keep);
  const clamp = (next: number) => Math.round(Math.min(widest, Math.max(narrowest, next)));
  return { width: clamp(stored), widest, setWidth: (next: number) => setStored(clamp(next)) };
}

/**
 * The bar between a page and the side panel on its right. Dragging it, or the arrow keys on it, makes the panel wider
 * or narrower; a double click puts it back.
 */
export function ResizeHandle({
  label,
  width,
  initial,
  narrowest,
  widest,
  onWidth,
}: {
  label: string;
  width: number;
  initial: number;
  narrowest: number;
  widest: number;
  onWidth: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current) onWidth(start.current.width + start.current.x - event.clientX);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a vertical bar that resizes is a separator; <hr> cannot take focus or drags
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={narrowest}
      aria-valuemax={widest}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width };
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        start.current = null;
      }}
      onDoubleClick={() => onWidth(initial)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') onWidth(width + 32);
        else if (event.key === 'ArrowRight') onWidth(width - 32);
        else return;
        event.preventDefault();
      }}
      className="group relative w-1.5 flex-none cursor-col-resize touch-none border-l border-line outline-none hover:bg-accent-200 focus-visible:bg-accent-300"
    >
      <span
        aria-hidden
        className="absolute top-1/2 left-1/2 h-8 w-0.5 -translate-1/2 rounded-full bg-neutral-400 group-hover:bg-accent-500"
      />
    </div>
  );
}
