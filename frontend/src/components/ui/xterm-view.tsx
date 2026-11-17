import { WS_PROTOCOL } from '@ops-console/shared';
import '@xterm/xterm/css/xterm.css';
import { type MutableRefObject, useEffect, useRef } from 'react';
import { sessionToken } from '../../lib/session';

export const TERMINAL_BG = '#0f0e0e';

const SCROLLBACK_LINES = 5000;

/** The text of an `{ type: 'output', data }` message, or null for any other message. */
function outputOf(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  if (!('type' in message) || message.type !== 'output') return null;
  return 'data' in message && typeof message.data === 'string' ? message.data : null;
}

/**
 * A terminal drawn from a daemon socket at `path`, sized to its box. The box tells the daemon its columns and rows on
 * open and on every change. `{ type: 'output', data }` messages go to the screen, a frame at a time; every other
 * message goes to `onMessage` as parsed JSON. With `interactive`, keys and paste go back as `{ type: 'input', data }`.
 * `socketRef` holds the open socket for a caller that sends more. A `hidden` view is invisible but keeps its box, its socket
 * and its screen, so showing it again costs nothing and xterm can measure it. xterm loads on first use, so it stays out of the main bundle.
 */
export function XtermView({
  path,
  interactive = false,
  hidden = false,
  onMessage,
  socketRef,
  className = '',
}: {
  path: string;
  interactive?: boolean;
  hidden?: boolean;
  onMessage?: (message: unknown) => void;
  socketRef?: MutableRefObject<WebSocket | null>;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(onMessage);
  latest.current = onMessage;
  const screen = useRef<{ focus(): void; fit(): void } | null>(null);
  const hiddenNow = useRef(hidden);
  hiddenNow.current = hidden;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the socket belongs to the path; `socketRef` is a ref
  useEffect(() => {
    const token = sessionToken();
    const node = host.current;
    if (!node || token === null) return;
    let disposed = false;
    let dispose = () => {};
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${path}`;
    const ws = new WebSocket(url, [WS_PROTOCOL, token]);
    if (socketRef) socketRef.current = ws;
    // Output that arrives before xterm has loaded waits here.
    const early: string[] = [];
    let write = (data: string): void => void early.push(data);
    ws.addEventListener('message', (event) => {
      const message: unknown = JSON.parse(String(event.data));
      const output = outputOf(message);
      if (output !== null) write(output);
      else latest.current?.(message);
    });

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed) return;
      const terminal = new Terminal({
        convertEol: true,
        fontSize: 13,
        disableStdin: !interactive,
        cursorBlink: interactive,
        scrollback: SCROLLBACK_LINES,
        theme: { background: TERMINAL_BG },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(node);
      fit.fit();
      screen.current = {
        focus: () => terminal.focus(),
        fit: () => fit.fit(),
      };
      const sendSize = () => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      };
      ws.addEventListener('open', sendSize);
      if (ws.readyState === WebSocket.OPEN) sendSize();
      // The terminal fills its box, and the program redraws at the new size whenever the box changes.
      const resized = new ResizeObserver(() => {
        const before = `${terminal.cols}x${terminal.rows}`;
        fit.fit();
        if (`${terminal.cols}x${terminal.rows}` !== before) sendSize();
      });
      resized.observe(node);
      // Chunks that arrive within a frame are written together.
      let queued: string[] = [];
      let frame = 0;
      const flush = () => {
        frame = 0;
        terminal.write(queued.join(''));
        queued = [];
      };
      write = (data) => {
        queued.push(data);
        if (frame === 0) frame = requestAnimationFrame(flush);
      };
      for (const data of early) write(data);
      early.length = 0;
      const typed = interactive
        ? terminal.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
          })
        : null;
      if (interactive && !hiddenNow.current) terminal.focus();
      dispose = () => {
        if (frame !== 0) cancelAnimationFrame(frame);
        typed?.dispose();
        resized.disconnect();
        terminal.dispose();
        screen.current = null;
      };
    })();

    return () => {
      disposed = true;
      dispose();
      ws.close();
      if (socketRef) socketRef.current = null;
    };
  }, [path, interactive]);

  // A view shown again takes the keyboard and the size its box has now.
  useEffect(() => {
    if (hidden) return;
    screen.current?.fit();
    if (interactive) screen.current?.focus();
  }, [hidden, interactive]);

  return (
    <div
      ref={host}
      className={`overflow-hidden ${hidden ? 'pointer-events-none invisible' : ''} ${className}`}
      style={{ background: TERMINAL_BG }}
    />
  );
}
