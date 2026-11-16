import type { BrowserServerMessage, Tab } from '@ops-console/shared';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useChooseFiles } from '../lib/queries';
import { createPainter } from './frame-painter';
import { fillSize, fitScale, isFill, pageSize, type Size, toPagePoint } from './geometry';
import { buttonName, isPasteShortcut, keyMessage, modifiersOf, wheelPixels } from './input';
import { usePageStream } from './use-page-stream';

/** Room kept around a device-sized page for its bezel. */
const BEZEL = 20;
const RESIZE_WAIT_MS = 120;
const NOTICE_MS = 8000;

type Pointer = {
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  detail: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/**
 * One tab's page: JPEG frames from `/browser/:tabId` on a canvas, and the operator's mouse, wheel, keys and paste sent
 * back as a person's. A Fill page takes the stage's size; a device page keeps its own and shrinks to fit. `overlay`
 * covers the page, for a blank tab or an error.
 */
export function PageStage({
  tab,
  overlay,
  onTab,
  onClosed,
}: {
  tab: Tab;
  overlay?: ReactNode;
  onTab: (tab: Tab) => void;
  onClosed: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [frame, setFrame] = useState<Size | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fill = isFill(tab.viewport);
  const choose = useChooseFiles();
  const picker = useRef<HTMLInputElement>(null);

  const paint = useMemo(
    () =>
      createPainter(
        () => canvas.current,
        (size) => setFrame(size),
      ),
    [],
  );
  const { connected, send } = usePageStream(tab.id, (message: BrowserServerMessage) => {
    if (message.type === 'frame') paint(message);
    else if (message.type === 'tab') onTab(message.tab);
    else if (message.type === 'dialog') setNotice(message.message);
    else onClosed();
  });

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setBox({ width: node.clientWidth, height: node.clientHeight }));
    observer.observe(node);
    setBox({ width: node.clientWidth, height: node.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // Fill asks the daemon for the stage's own size, once it settles.
  useEffect(() => {
    if (!connected || !fill) return;
    const size = fillSize({ width: box.width, height: box.height });
    if (!size) return;
    const timer = setTimeout(() => send({ type: 'resize', ...size }), RESIZE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [connected, fill, box.width, box.height, send]);

  const page: Size | null = frame
    ? pageSize(tab.viewport, frame)
    : tab.viewport.width !== null && tab.viewport.height !== null
      ? { width: tab.viewport.width, height: tab.viewport.height }
      : null;
  const pageRef = useRef(page);
  pageRef.current = page;

  const message = (action: 'move' | 'down' | 'up', event: Pointer) => {
    const target = canvas.current;
    const size = pageRef.current;
    if (!target || !size) return;
    const point = toPagePoint({ x: event.clientX, y: event.clientY }, target.getBoundingClientRect(), size);
    const pressed = event.buttons & 1 ? 'left' : event.buttons & 4 ? 'middle' : event.buttons & 2 ? 'right' : 'none';
    send({
      type: 'mouse',
      action,
      ...point,
      button: action === 'move' ? pressed : buttonName(event.button),
      click_count: action === 'move' ? 0 : Math.min(3, Math.max(1, event.detail)),
      delta_x: 0,
      delta_y: 0,
      modifiers: modifiersOf(event),
    });
  };

  // Moves go out once per frame drawn, the latest only.
  const move = useRef<{ event: Pointer; frame: number } | null>(null);
  const dragging = useRef(false);
  const queueMove = (event: Pointer) => {
    if (move.current) {
      move.current.event = event;
      return;
    }
    const queued = {
      event,
      frame: requestAnimationFrame(() => {
        move.current = null;
        message('move', queued.event);
      }),
    };
    move.current = queued;
  };
  useEffect(
    () => () => {
      if (move.current) cancelAnimationFrame(move.current.frame);
    },
    [],
  );

  // A wheel listener that can stop the console from scrolling under the page needs `passive: false`.
  const wheel = useRef((_event: WheelEvent) => {});
  wheel.current = (event) => {
    const target = canvas.current;
    const size = pageRef.current;
    if (!target || !size) return;
    event.preventDefault();
    const point = toPagePoint({ x: event.clientX, y: event.clientY }, target.getBoundingClientRect(), size);
    const travel = wheelPixels(event, size.height);
    send({
      type: 'mouse',
      action: 'wheel',
      ...point,
      button: 'none',
      click_count: 0,
      delta_x: travel.x,
      delta_y: travel.y,
      modifiers: modifiersOf(event),
    });
  };
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const onWheel = (event: WheelEvent) => wheel.current(event);
    target.addEventListener('wheel', onWheel, { passive: false });
    return () => target.removeEventListener('wheel', onWheel);
  }, []);

  const scale = page && !fill ? fitScale(page, { width: box.width - BEZEL, height: box.height - BEZEL }) : 1;
  const drawn =
    page && !fill ? { width: Math.round(page.width * scale), height: Math.round(page.height * scale) } : undefined;

  return (
    <div
      ref={stage}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-neutral-300"
    >
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label={tab.title || 'Page'}
        style={drawn}
        className={
          fill
            ? 'absolute inset-0 size-full bg-white outline-none'
            : 'flex-none rounded-3xl bg-white ring-8 ring-neutral-900 outline-none'
        }
        onFocus={() => send({ type: 'focus' })}
        onContextMenu={(event) => event.preventDefault()}
        onMouseMove={(event) => {
          if (!dragging.current) queueMove(event);
        }}
        onMouseDown={(event) => {
          message('down', event);
          dragging.current = true;
          // A drag that leaves the page goes on, and its release is the page's.
          const track = (next: MouseEvent) => queueMove(next);
          const release = (next: MouseEvent) => {
            dragging.current = false;
            window.removeEventListener('mousemove', track);
            window.removeEventListener('mouseup', release);
            message('up', next);
          };
          window.addEventListener('mousemove', track);
          window.addEventListener('mouseup', release);
        }}
        onKeyDown={(event) => {
          // A paste arrives as its own event, with the text.
          if (isPasteShortcut(event)) return;
          event.preventDefault();
          send(keyMessage('down', event));
        }}
        onKeyUp={(event) => {
          if (isPasteShortcut(event)) return;
          event.preventDefault();
          send(keyMessage('up', event));
        }}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData('text/plain');
          if (text) send({ type: 'text', text: text.slice(0, 100_000) });
        }}
      />
      {overlay && <div className="absolute inset-0 overflow-auto bg-card">{overlay}</div>}
      <div className="pointer-events-none absolute right-3 bottom-3 left-3 flex items-end justify-between gap-3">
        {tab.agent_active ? (
          <span
            role="status"
            className="flex items-center gap-2 rounded-full bg-neutral-900 px-3.5 py-1.5 text-xs text-bg shadow-md"
          >
            <span aria-hidden className="size-2 rounded-full bg-accent" />
            Agent is using this tab
          </span>
        ) : (
          <span />
        )}
        {tab.called_hosts.length > 0 && (
          <span
            title={`Hosts this page called: ${tab.called_hosts.join(', ')}. Nothing is blocked.`}
            className="pointer-events-auto min-w-0 truncate rounded-lg border border-line bg-card px-3 py-1.5 text-xs text-neutral-700 shadow-sm"
          >
            <b className="font-semibold">Called:</b> {tab.called_hosts.join(', ')}
          </span>
        )}
      </div>
      {tab.file_chooser && (
        <div
          role="dialog"
          aria-label="The page asks for a file"
          className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-xs shadow-md"
        >
          <span>{tab.file_chooser.multiple ? 'The page asks for files.' : 'The page asks for a file.'}</span>
          <input
            ref={picker}
            type="file"
            hidden
            multiple={tab.file_chooser.multiple}
            aria-label="Choose from this computer"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              if (files.length > 0) choose.mutate({ tabId: tab.id, files });
            }}
          />
          <button
            type="button"
            disabled={choose.isPending}
            onClick={() => picker.current?.click()}
            className="cursor-pointer rounded-md border border-line bg-card px-2.5 py-1 text-xs font-semibold hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Choose from this computer
          </button>
          <button
            type="button"
            disabled={choose.isPending}
            onClick={() => choose.mutate({ tabId: tab.id, files: [] })}
            className="cursor-pointer border-0 bg-transparent px-1 text-xs text-neutral-700 hover:text-text"
          >
            Cancel
          </button>
          {choose.isError && <span role="alert">{choose.error.message}</span>}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="absolute top-3 left-1/2 flex max-w-[80%] -translate-x-1/2 items-start gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs shadow-md"
        >
          <span className="min-w-0 flex-1 break-words">{notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
            className="cursor-pointer border-0 bg-transparent p-0 text-neutral-600 hover:text-text"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
