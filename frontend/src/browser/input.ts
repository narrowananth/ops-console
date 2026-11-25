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
type Pressed = Typed & { repeat: boolean; isComposing: boolean; keyCode: number };

/** The text a key press types: one character, or Enter. Shortcuts (Ctrl, Cmd) type nothing. */
export function typedText(event: Typed): string | undefined {
  if (event.ctrlKey || event.metaKey) return undefined;
  if (event.key === 'Enter') return '\r';
  return [...event.key].length === 1 ? event.key : undefined;
}

/**
 * A key that belongs to an input method: the method turns it into text, so the page gets that text from the composition
 * and not the key. `Process` and keyCode 229 are what a method in use reports; `Dead` starts an accent.
 */
export const isComposingKey = (event: Pressed): boolean =>
  event.isComposing || event.key === 'Process' || event.key === 'Dead' || event.keyCode === 229;

/** Whether the console runs on a Mac, whose key bindings the page should follow. */
export const onMac = (): boolean => /Mac/.test(navigator.platform);

/**
 * How a paste shortcut reaches the console: `native` fires a paste event that carries the clipboard; `clipboard` is a
 * Mac's Control+V, which fires none, so the clipboard is read by hand. Anything else is not a paste.
 */
export function pasteShortcut(event: Typed, mac: boolean): 'native' | 'clipboard' | null {
  if (event.key.toLowerCase() !== 'v' || event.altKey) return null;
  if (mac) return event.metaKey ? 'native' : event.ctrlKey ? 'clipboard' : null;
  return event.ctrlKey || event.metaKey ? 'native' : null;
}

const SELECT = 'AndModifySelection';

/** Chrome's editing commands for the shortcuts a Mac text field answers; the key alone does nothing in a headless page. */
const MAC_COMMANDS: Record<string, string[]> = {
  'Meta+KeyA': ['selectAll'],
  'Meta+KeyC': ['copy'],
  'Meta+KeyX': ['cut'],
  'Meta+KeyZ': ['undo'],
  'Shift+Meta+KeyZ': ['redo'],
  'Alt+ArrowLeft': ['moveWordLeft'],
  'Alt+ArrowRight': ['moveWordRight'],
  'Shift+Alt+ArrowLeft': [`moveWordLeft${SELECT}`],
  'Shift+Alt+ArrowRight': [`moveWordRight${SELECT}`],
  'Alt+ArrowUp': ['moveBackward', 'moveToBeginningOfParagraph'],
  'Alt+ArrowDown': ['moveForward', 'moveToEndOfParagraph'],
  'Shift+Alt+ArrowUp': ['moveParagraphBackwardAndModifySelection'],
  'Shift+Alt+ArrowDown': ['moveParagraphForwardAndModifySelection'],
  'Alt+Backspace': ['deleteWordBackward'],
  'Shift+Alt+Backspace': ['deleteWordBackward'],
  'Alt+Delete': ['deleteWordForward'],
  'Shift+Alt+Delete': ['deleteWordForward'],
  'Meta+ArrowLeft': ['moveToLeftEndOfLine'],
  'Meta+ArrowRight': ['moveToRightEndOfLine'],
  'Meta+ArrowUp': ['moveToBeginningOfDocument'],
  'Meta+ArrowDown': ['moveToEndOfDocument'],
  'Shift+Meta+ArrowLeft': [`moveToLeftEndOfLine${SELECT}`],
  'Shift+Meta+ArrowRight': [`moveToRightEndOfLine${SELECT}`],
  'Shift+Meta+ArrowUp': [`moveToBeginningOfDocument${SELECT}`],
  'Shift+Meta+ArrowDown': [`moveToEndOfDocument${SELECT}`],
  'Meta+Backspace': ['deleteToBeginningOfLine'],
  'Shift+Meta+Backspace': ['deleteToBeginningOfLine'],
  'Control+KeyA': ['moveToBeginningOfParagraph'],
  'Control+KeyE': ['moveToEndOfParagraph'],
  'Shift+Control+KeyA': [`moveToBeginningOfParagraph${SELECT}`],
  'Shift+Control+KeyE': [`moveToEndOfParagraph${SELECT}`],
  'Control+KeyK': ['deleteToEndOfParagraph'],
};

/** The same for Windows and Linux keyboards, which use Control and Home and End. */
const OTHER_COMMANDS: Record<string, string[]> = {
  'Control+KeyA': ['selectAll'],
  'Control+KeyC': ['copy'],
  'Control+KeyX': ['cut'],
  'Control+KeyZ': ['undo'],
  'Control+KeyY': ['redo'],
  'Shift+Control+KeyZ': ['redo'],
  'Control+ArrowLeft': ['moveWordLeft'],
  'Control+ArrowRight': ['moveWordRight'],
  'Shift+Control+ArrowLeft': [`moveWordLeft${SELECT}`],
  'Shift+Control+ArrowRight': [`moveWordRight${SELECT}`],
  'Control+Backspace': ['deleteWordBackward'],
  'Control+Delete': ['deleteWordForward'],
  Home: ['moveToBeginningOfLine'],
  End: ['moveToEndOfLine'],
  'Shift+Home': [`moveToBeginningOfLine${SELECT}`],
  'Shift+End': [`moveToEndOfLine${SELECT}`],
  'Control+Home': ['moveToBeginningOfDocument'],
  'Control+End': ['moveToEndOfDocument'],
  'Shift+Control+Home': [`moveToBeginningOfDocument${SELECT}`],
  'Shift+Control+End': [`moveToEndOfDocument${SELECT}`],
};

/** The editing commands a key combination stands for on this platform, none for a plain key. */
export function editingCommands(event: Typed, mac: boolean): string[] {
  const parts = [
    event.shiftKey ? 'Shift' : '',
    event.ctrlKey ? 'Control' : '',
    event.altKey ? 'Alt' : '',
    event.metaKey ? 'Meta' : '',
    event.code,
  ].filter(Boolean);
  return (mac ? MAC_COMMANDS : OTHER_COMMANDS)[parts.join('+')] ?? [];
}

export function keyMessage(action: 'down' | 'up', event: Pressed, mac: boolean): BrowserClientMessage {
  const text = action === 'down' ? typedText(event) : undefined;
  const commands = action === 'down' ? editingCommands(event, mac) : [];
  return {
    type: 'key',
    action,
    key: event.key.slice(0, 40),
    code: event.code.slice(0, 40),
    ...(text === undefined ? {} : { text }),
    modifiers: modifiersOf(event),
    ...(commands.length === 0 ? {} : { commands }),
    ...(action === 'down' && event.repeat ? { repeat: true } : {}),
  };
}
