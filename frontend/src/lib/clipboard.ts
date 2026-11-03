import { useEffect, useState } from 'react';

/**
 * Puts `text` on the clipboard. Chrome's Clipboard API refuses while the page lacks focus, as on the click that brings
 * the window forward, so the older copy command runs then; the click is still a user gesture, so the browser allows it.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Not focused, or no Clipboard API: the copy command below.
  }
  const before = document.activeElement;
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.style.position = 'fixed';
  box.style.opacity = '0';
  document.body.append(box);
  box.select();
  const copied = document.execCommand('copy');
  box.remove();
  if (before instanceof HTMLElement) before.focus();
  if (!copied) throw new Error('The browser would not copy');
}

export type CopyState = 'idle' | 'copied' | 'failed';

export const COPY_FAILED = 'The browser would not copy. Select the text and press ⌘C instead.';

/** A Copy button's word: its own while idle, then for a moment whether the copy took. */
export const copyLabel = (state: CopyState, idle: string) =>
  state === 'copied' ? 'Copied' : state === 'failed' ? 'Not copied' : idle;

/** Copy for a button: the state shows `Copied` or `Not copied` for 1.5 s, then goes back to idle. */
export function useCopy(): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = (text: string) =>
    void copyText(text).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  return [state, copy];
}
