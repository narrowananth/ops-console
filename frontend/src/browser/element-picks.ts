import { type ElementCapture, elementCaptureSchema } from '@ops-console/shared';
import { useEffect, useRef } from 'react';
import { z } from 'zod';
import { readStored, writeStored } from '../lib/remember';

const inboxKey = (sessionId: string) => `browser.element-picks.${sessionId}`;
const inbox = z.array(elementCaptureSchema);
const EVENT = 'ops-console:element-pick';
const END_EVENT = 'ops-console:pick-end';
const END_CHANNEL = 'ops-console:pick-end';
/** The message box. Focus in it ends pick mode; the composer needs no hook for that. */
const MESSAGE_BOX = '[role="textbox"][aria-label="Message"]';

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
    // Focus in the message box ends pick mode in the panel and in a tab's window.
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest(MESSAGE_BOX)) endPicking(sessionId);
    };
    drain();
    window.addEventListener(EVENT, onEvent);
    window.addEventListener('storage', onStorage);
    document.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener(EVENT, onEvent);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('focusin', onFocus);
    };
  }, [sessionId]);
}

function endPicking(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(END_EVENT, { detail: sessionId }));
  const channel = new BroadcastChannel(END_CHANNEL);
  channel.postMessage(sessionId);
  channel.close();
}

/** Calls `onEnd` when the operator takes the message box for the Session, here or in another window of this browser. */
export function usePickEnds(sessionId: string, onEnd: () => void): void {
  const latest = useRef(onEnd);
  latest.current = onEnd;
  useEffect(() => {
    const onEvent = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === sessionId) latest.current();
    };
    const channel = new BroadcastChannel(END_CHANNEL);
    channel.onmessage = (event) => {
      if (event.data === sessionId) latest.current();
    };
    window.addEventListener(END_EVENT, onEvent);
    return () => {
      window.removeEventListener(END_EVENT, onEvent);
      channel.close();
    };
  }, [sessionId]);
}
