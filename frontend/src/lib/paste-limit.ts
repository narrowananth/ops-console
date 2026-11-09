import { type ClipboardEvent, useState } from 'react';

type Field = HTMLTextAreaElement | HTMLInputElement;

/**
 * How a box treats a paste that is too long:
 * - `reject`: a paste longer than `limit` is dropped whole. The field's own `maxLength` still caps the total.
 * - `fit`: the field holds `limit` characters at most; a paste is cut to the room left and the rest is left out.
 */
export type PasteMode = 'reject' | 'fit';

/**
 * Guards a text field against a huge paste, which would freeze the page while it draws. `onPaste` goes on the field;
 * `over` is true after a paste was cut or dropped, until the operator types again.
 */
export function usePasteLimit(limit: number, mode: PasteMode) {
  const [over, setOver] = useState(false);
  const onPaste = (event: ClipboardEvent<Field>) => {
    const text = event.clipboardData.getData('text/plain');
    const field = event.currentTarget;
    const room =
      mode === 'fit' ? limit - (field.value.length - (field.selectionEnd ?? 0) + (field.selectionStart ?? 0)) : limit;
    if (text.length <= room) return;
    event.preventDefault();
    if (mode === 'fit' && room > 0) document.execCommand('insertText', false, text.slice(0, room));
    setOver(true);
  };
  return { over, onPaste, clear: () => setOver(false) };
}
