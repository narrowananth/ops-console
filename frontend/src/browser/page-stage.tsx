import type { BrowserServerMessage, ElementCapture, Tab } from '@ops-console/shared';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChooseFiles } from '../lib/queries';
import { createPainter, frameCache } from './frame-painter';
import { clampRatio, fillSize, fitScale, isFill, type Size, toPagePoint } from './geometry';
import { buttonName, isComposingKey, keyMessage, modifiersOf, onMac, pasteShortcut, wheelPixels } from './input';
import { readPastedFiles } from './pasted-files';
import { usePageStream } from './use-page-stream';

/** Room kept around a device-sized page for its bezel. */
const BEZEL = 20;
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
 * covers the page, for a blank tab or an error. While `picking`, the pointer picks an element instead of reaching the
 * page: the daemon highlights what is under it, a click goes to `onPicked` with the capture, and Escape calls `onPickEnd`.
 */
export function PageStage({
  tab,
  overlay,
  picking = false,
  onPicked,
  onPickEnd,
  onTab,
  onClosed,
}: {
  tab: Tab;
  overlay?: ReactNode;
  picking?: boolean;
  onPicked?: (capture: ElementCapture) => void;
  onPickEnd?: () => void;
  onTab: (tab: Tab) => void;
  onClosed: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [framePage, setFramePage] = useState<Size | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fill = isFill(tab.viewport);
  const choose = useChooseFiles();
  const picker = useRef<HTMLInputElement>(null);
  // The element that takes the keys: a hidden text field, so the system's input method has something to type into.
  const keys = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);

  const fillRef = useRef(fill);
  fillRef.current = fill;
  const paint = useMemo(
    () =>
      createPainter(
        () => canvas.current,
        (size) => setFramePage(size),
      ),
    [],
  );
  // The size the daemon was last asked for, so a stage that changes in a way that leaves it the same sends nothing.
  const asked = useRef<string | null>(null);
  const stageSize = () => {
    const node = stage.current;
    const size = node && fillSize({ width: node.clientWidth, height: node.clientHeight });
    return size ? { ...size, dpr: clampRatio(window.devicePixelRatio) } : null;
  };
  const { connected, lost, send } = usePageStream(
    tab.id,
    (message: BrowserServerMessage) => {
      if (message.type === 'tab') onTab(message.tab);
      else if (message.type === 'dialog') setNotice(message.message);
      else if (message.type === 'picked') onPicked?.(message.capture);
      else if (message.type === 'pick_failed') setNotice(message.message);
      else if (message.type === 'clipboard') {
        // `navigator.clipboard` is missing off a secure origin, which throws before any promise exists.
        void Promise.resolve()
          .then(() => navigator.clipboard.writeText(message.text))
          .catch(() => setNotice('The browser did not allow copying to the clipboard.'));
      } else onClosed();
    },
    (frame) => {
      frameCache.remember(tab.id, frame);
      paint(frame);
    },
    () => {
      const size = fillRef.current ? stageSize() : null;
      asked.current = size ? `${size.width}x${size.height}x${size.dpr}` : null;
      return size;
    },
  );

  // A tab watched a moment ago draws its last frame at once, before the browser's first paint of the stage, when that
  // frame is the stage's size; the stream's first frame replaces it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the stage first shows
  useLayoutEffect(() => {
    const last = frameCache.recall(tab.id);
    const node = stage.current;
    if (!last || !node) return;
    if (!fillRef.current || (last.width === node.clientWidth && last.height === node.clientHeight)) paint(last);
  }, []);

  // Fill asks the daemon for the stage's own size at each change: the observer fires once per frame drawn, and the
  // daemon takes the newest of what arrives while it works, so a drag is followed and not waited out.
  const askFill = useRef(() => {});
  askFill.current = () => {
    const size = fillRef.current ? stageSize() : null;
    if (!size) return;
    const key = `${size.width}x${size.height}x${size.dpr}`;
    if (asked.current === key) return;
    // Only a size that went out counts as asked: a socket still opening takes none, and the open asks again.
    if (send({ type: 'resize', ...size })) asked.current = key;
  };
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setBox({ width: node.clientWidth, height: node.clientHeight });
      askFill.current();
    });
    observer.observe(node);
    setBox({ width: node.clientWidth, height: node.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // A connect, or a switch to Fill from a device, asks for the stage's size again; the socket's own address carried it once.
  useEffect(() => {
    if (!connected) return;
    if (!fill) asked.current = null;
    askFill.current();
  }, [connected, fill]);

  const pickEnd = useRef(onPickEnd);
  pickEnd.current = onPickEnd;
  // The daemon forgets pick mode with the socket, so it starts again whenever the stream opens.
  useEffect(() => {
    if (!picking || !connected) return;
    send({ type: 'pick', action: 'start', x: 0, y: 0 });
    return () => {
      send({ type: 'pick', action: 'end', x: 0, y: 0 });
    };
  }, [picking, connected, send]);
  useEffect(() => {
    if (!picking) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key === 'Escape') pickEnd.current?.();
    };
    window.addEventListener('keydown', leave);
    return () => window.removeEventListener('keydown', leave);
  }, [picking]);
  const pickingRef = useRef(picking);
  pickingRef.current = picking;

  const page: Size | null =
    framePage ??
    (tab.viewport.width !== null && tab.viewport.height !== null
      ? { width: tab.viewport.width, height: tab.viewport.height }
      : null);
  const pageRef = useRef(page);
  pageRef.current = page;

  const pickAt = (action: 'hover' | 'click', event: Pointer) => {
    const target = canvas.current;
    const size = pageRef.current;
    if (!target || !size) return;
    send({
      type: 'pick',
      action,
      ...toPagePoint({ x: event.clientX, y: event.clientY }, target.getBoundingClientRect(), size),
    });
  };

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
        if (pickingRef.current) pickAt('hover', queued.event);
        else message('move', queued.event);
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

  // A wheel listener that can stop the console from scrolling under the page needs `passive: false`. A trackpad swipe
  // sends a wheel event every few milliseconds: they are added up and sent once per frame drawn, at the newest place.
  const wheelPending = useRef<{ x: number; y: number; at: { x: number; y: number }; modifiers: number } | null>(null);
  const wheelFrame = useRef(0);
  const wheel = useRef((_event: WheelEvent) => {});
  wheel.current = (event) => {
    const target = canvas.current;
    const size = pageRef.current;
    if (!target || !size) return;
    event.preventDefault();
    const point = toPagePoint({ x: event.clientX, y: event.clientY }, target.getBoundingClientRect(), size);
    const travel = wheelPixels(event, size.height);
    const held = wheelPending.current;
    wheelPending.current = {
      x: (held?.x ?? 0) + travel.x,
      y: (held?.y ?? 0) + travel.y,
      at: point,
      modifiers: modifiersOf(event),
    };
    if (wheelFrame.current !== 0) return;
    wheelFrame.current = requestAnimationFrame(() => {
      wheelFrame.current = 0;
      const next = wheelPending.current;
      wheelPending.current = null;
      if (!next) return;
      send({
        type: 'mouse',
        action: 'wheel',
        ...next.at,
        button: 'none',
        click_count: 0,
        delta_x: next.x,
        delta_y: next.y,
        modifiers: next.modifiers,
      });
    });
  };
  useEffect(
    () => () => {
      if (wheelFrame.current !== 0) cancelAnimationFrame(wheelFrame.current);
    },
    [],
  );
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const onWheel = (event: WheelEvent) => wheel.current(event);
    target.addEventListener('wheel', onWheel, { passive: false });
    return () => target.removeEventListener('wheel', onWheel);
  }, []);

  // Pasted and dropped files go to the daemon, which gives them to a file field the page has.
  const sendFiles = async (list: File[], at?: { x: number; y: number }) => {
    if (list.length === 0) return;
    const { files, skipped } = await readPastedFiles(list);
    if (skipped > 0) setNotice(`${skipped} file${skipped === 1 ? ' was' : 's were'} too large or too many to send.`);
    if (files.length > 0) send({ type: 'paste', files, ...at });
  };
  const sendPaste = (text: string, files: File[]) => {
    if (text) send({ type: 'paste', text: text.slice(0, 100_000) });
    void sendFiles(files);
  };
  const pagePoint = (event: { clientX: number; clientY: number }) => {
    const target = canvas.current;
    const size = pageRef.current;
    return target && size
      ? toPagePoint({ x: event.clientX, y: event.clientY }, target.getBoundingClientRect(), size)
      : null;
  };
  const sendCompose = (text: string) => {
    if (text) send({ type: 'compose', text });
  };

  const scale = page && !fill ? fitScale(page, { width: box.width - BEZEL, height: box.height - BEZEL }) : 1;
  const drawn =
    page && !fill ? { width: Math.round(page.width * scale), height: Math.round(page.height * scale) } : undefined;

  return (
    <div
      ref={stage}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-neutral-300"
    >
      <textarea
        ref={keys}
        aria-label={`${tab.title || 'Page'} (keyboard input)`}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        // Hidden, not removed: it holds the focus, and the input method draws its candidates beside it.
        className="pointer-events-none absolute top-0 left-0 size-px resize-none overflow-hidden border-0 p-0 opacity-0 outline-none"
        onFocus={() => send({ type: 'focus' })}
        onKeyDown={(event) => {
          // While picking, keys do not reach the page; Escape leaves pick mode.
          if (picking) {
            event.preventDefault();
            return;
          }
          // The input method owns these keys: the page gets the text it composes.
          if (isComposingKey(event.nativeEvent)) return;
          const paste = pasteShortcut(event, onMac());
          // A Command+V paste arrives as its own event, with the clipboard.
          if (paste === 'native') return;
          event.preventDefault();
          if (paste === 'clipboard') {
            // A Mac's Control+V fires no paste event, so the clipboard is read by hand.
            // `navigator.clipboard` is missing off a secure origin, which throws before any promise exists.
            void Promise.resolve()
              .then(() => navigator.clipboard.readText())
              .then(
                (text) => sendPaste(text, []),
                () => setNotice('The browser did not allow reading the clipboard.'),
              );
            return;
          }
          send(keyMessage('down', event.nativeEvent, onMac()));
        }}
        onKeyUp={(event) => {
          if (picking || isComposingKey(event.nativeEvent) || pasteShortcut(event, onMac()) === 'native') return;
          event.preventDefault();
          send(keyMessage('up', event.nativeEvent, onMac()));
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          event.currentTarget.value = '';
          if (!picking) sendCompose(event.data);
        }}
        // Text an input method inserts with no composition, such as the emoji picker.
        onInput={(event) => {
          if (composing.current) return;
          const field = event.currentTarget;
          const text = field.value;
          field.value = '';
          if (text && !picking) sendCompose(text);
        }}
        onPaste={(event) => {
          event.preventDefault();
          if (picking) return;
          sendPaste(event.clipboardData.getData('text/plain'), [...event.clipboardData.files]);
        }}
      />
      <canvas
        ref={canvas}
        aria-label={tab.title || 'Page'}
        style={drawn}
        // Nothing shows before the first frame: an empty canvas would flash white.
        className={`${
          fill
            ? `absolute inset-0 size-full outline-none ${framePage === null ? 'invisible' : ''}`
            : 'flex-none rounded-3xl bg-white ring-8 ring-neutral-900 outline-none'
        } ${picking ? 'cursor-crosshair' : ''}`}
        onContextMenu={(event) => event.preventDefault()}
        // A file dropped on the page is the page's: without these Chrome would open it in the console's own tab.
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (picking) return;
          const at = pagePoint(event);
          if (at) void sendFiles([...event.dataTransfer.files], at);
        }}
        onMouseMove={(event) => {
          if (!dragging.current) queueMove(event);
        }}
        onMouseDown={(event) => {
          // The keys go to the hidden field; a click on the canvas would take the focus from it.
          event.preventDefault();
          keys.current?.focus({ preventScroll: true });
          if (picking) {
            if (event.button === 0) pickAt('click', event);
            return;
          }
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
      {framePage !== null && lost && (
        <div
          role="status"
          className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-neutral-900 px-3.5 py-1.5 text-xs text-bg shadow-md"
        >
          Lost the page. Reconnecting; clicks and keys are not sent.
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
