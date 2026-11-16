import type { BrowserClientMessage } from '@ops-console/shared';

type Modified = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/** Chrome's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const modifiersOf = (event: Modified): number =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

const BUTTONS = ['left', 'middle', 'right'] as const;

/** The mouse button a DOM `button` number names. */
export const buttonName = (button: number): 'left' | 'middle' | 'right' => BUTTONS[button] ?? 'left';

/** A wheel's travel in pixels, whatever unit the browser counts in. */
export function wheelPixels(event: { deltaMode: number; deltaX: number; deltaY: number }, pageHeight: number) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  return { x: event.deltaX * unit, y: event.deltaY * unit };
}

type Typed = Modified & { key: string; code: string };

/** The text a key press types: one character, or Enter. Shortcuts (Ctrl, Cmd) type nothing. */
export function typedText(event: Typed): string | undefined {
  if (event.ctrlKey || event.metaKey) return undefined;
  if (event.key === 'Enter') return '\r';
  return [...event.key].length === 1 ? event.key : undefined;
}

/** A paste is its own `text` message, so the key press that began it is not sent too. */
export const isPasteShortcut = (event: Typed): boolean =>
  (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v';

export function keyMessage(action: 'down' | 'up', event: Typed): BrowserClientMessage {
  const text = action === 'down' ? typedText(event) : undefined;
  return {
    type: 'key',
    action,
    key: event.key.slice(0, 40),
    code: event.code.slice(0, 40),
    ...(text === undefined ? {} : { text }),
    modifiers: modifiersOf(event),
  };
}
