import {
  type BrowserClientMessage,
  type BrowserServerMessage,
  browserServerMessageSchema,
  readFrameHeader,
  WS_PROTOCOL,
} from '@ops-console/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionToken } from '../lib/session';

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;

/** A page frame: the size it was drawn at and its JPEG. */
export type PageFrame = { width: number; height: number; jpeg: Uint8Array<ArrayBuffer> };

/**
 * The page stream of one tab: JSON messages go to `onMessage`, binary frames to `onFrame`, and `send` carries input
 * back. A dropped socket opens again after a wait that doubles to a cap; `closed` from the daemon ends it. `connected`
 * is true while open.
 */
export function usePageStream(
  tabId: string,
  onMessage: (message: BrowserServerMessage) => void,
  onFrame: (frame: PageFrame) => void,
) {
  const socket = useRef<WebSocket | null>(null);
  const latest = useRef(onMessage);
  latest.current = onMessage;
  const latestFrame = useRef(onFrame);
  latestFrame.current = onFrame;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const token = sessionToken();
    if (token === null) return;
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/browser/${tabId}`;
    let ended = false;
    let wait = RECONNECT_MIN_MS;
    let reopen: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      const ws = new WebSocket(url, [WS_PROTOCOL, token]);
      ws.binaryType = 'arraybuffer';
      socket.current = ws;
      ws.addEventListener('open', () => {
        wait = RECONNECT_MIN_MS;
        setConnected(true);
      });
      ws.addEventListener('message', (event) => {
        // A frame is binary and goes straight to the painter; only the small JSON messages are checked.
        if (event.data instanceof ArrayBuffer) {
          const frame = readFrameHeader(event.data);
          if (frame) latestFrame.current(frame);
          return;
        }
        const parsed = browserServerMessageSchema.safeParse(JSON.parse(String(event.data)));
        if (!parsed.success) return;
        if (parsed.data.type === 'closed') ended = true;
        latest.current(parsed.data);
      });
      ws.addEventListener('close', () => {
        if (socket.current === ws) socket.current = null;
        setConnected(false);
        if (ended) return;
        reopen = setTimeout(connect, wait);
        wait = Math.min(wait * 2, RECONNECT_MAX_MS);
      });
    };
    connect();
    return () => {
      ended = true;
      if (reopen) clearTimeout(reopen);
      socket.current?.close();
      socket.current = null;
      setConnected(false);
    };
  }, [tabId]);

  const send = useCallback((message: BrowserClientMessage) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  return { connected, send };
}
