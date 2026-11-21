import { type ElementCapture, elementCaptureSchema } from '@ops-console/shared';
import { useEffect, useRef } from 'react';
import { z } from 'zod';
import { readStored, writeStored } from '../lib/remember';

const inboxKey = (sessionId: string) => `browser.element-picks.${sessionId}`;
const inbox = z.array(elementCaptureSchema);
const EVENT = 'ops-console:element-pick';

/**
 * Hands a picked element to the Session's message box. The Browser panel and a tab's own window both call it, and the
 * window is another page of the same browser, so the capture waits in local storage until the composer takes it: the
 * composer of the same page hears the event, one in another window the `storage` event, and one not open yet reads it
 * when it mounts.
 */
export function deliverPick(sessionId: string, capture: ElementCapture): void {
  writeStored(inboxKey(sessionId), [...readStored(inboxKey(sessionId), inbox, []), capture], []);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: sessionId }));
}

/** Calls `onPicks` with the elements picked for the Session: those waiting now, then each batch that arrives. */
export function useIncomingPicks(sessionId: string, onPicks: (captures: ElementCapture[]) => void): void {
  const latest = useRef(onPicks);
  latest.current = onPicks;
  useEffect(() => {
    const key = inboxKey(sessionId);
    const drain = () => {
      const waiting = readStored(key, inbox, []);
      if (waiting.length === 0) return;
      writeStored(key, [], []);
      latest.current(waiting);
    };
    const onEvent = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === sessionId) drain();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key?.endsWith(key)) drain();
    };
    drain();
    window.addEventListener(EVENT, onEvent);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, onEvent);
      window.removeEventListener('storage', onStorage);
    };
  }, [sessionId]);
}
