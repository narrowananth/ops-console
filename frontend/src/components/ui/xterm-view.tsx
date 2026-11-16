import { WS_PROTOCOL } from '@ops-console/shared';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { type MutableRefObject, useEffect, useRef } from 'react';
import { sessionToken } from '../../lib/session';

export const TERMINAL_BG = '#0f0e0e';

const SCROLLBACK_LINES = 5000;

/**
 * A terminal drawn from a daemon socket at `path`, sized to its box. The box tells the daemon its columns and rows on
 * open and on every change. Messages go to `onMessage` as parsed JSON with a `write` for the screen; with `interactive`,
 * keys and paste go back as `{ type: 'input', data }`. `socketRef` holds the open socket for a caller that sends more.
 */
export function XtermView({
  path,
  interactive = false,
  onMessage,
  socketRef,
  className = '',
}: {
  path: string;
  interactive?: boolean;
  onMessage: (message: unknown, write: (data: string) => void) => void;
  socketRef?: MutableRefObject<WebSocket | null>;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(onMessage);
  latest.current = onMessage;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the socket belongs to the path; `socketRef` is a ref
  useEffect(() => {
    const token = sessionToken();
    if (!host.current || token === null) return;
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
    terminal.open(host.current);
    fit.fit();
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${path}`;
    const ws = new WebSocket(url, [WS_PROTOCOL, token]);
    if (socketRef) socketRef.current = ws;
    const sendSize = () => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };
    ws.addEventListener('open', sendSize);
    // The terminal fills its box, and the program redraws at the new size whenever the box changes.
    const resized = new ResizeObserver(() => {
      const before = `${terminal.cols}x${terminal.rows}`;
      fit.fit();
      if (`${terminal.cols}x${terminal.rows}` !== before) sendSize();
    });
    resized.observe(host.current);
    ws.addEventListener('message', (event) => {
      latest.current(JSON.parse(String(event.data)), (data) => terminal.write(data));
    });
    const typed = interactive
      ? terminal.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
        })
      : null;
    if (interactive) terminal.focus();
    return () => {
      typed?.dispose();
      resized.disconnect();
      ws.close();
      terminal.dispose();
      if (socketRef) socketRef.current = null;
    };
  }, [path, interactive]);

  return <div ref={host} className={`overflow-hidden ${className}`} style={{ background: TERMINAL_BG }} />;
}
