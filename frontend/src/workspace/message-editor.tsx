import { fileToken, PASTE_AS_FILE_LIMIT } from '@ops-console/shared';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { filesIn } from './attachments';
import { attachedName, CHIP_CLASS, CUBE_PATH, chipsIn, describeMention, type Token } from './mentions';

export type MessageEditorHandle = {
  /** Focuses the message with the cursor after its last character. */
  focusEnd: () => void;
  /** Takes the `$`, `@` or `/` word before the cursor out and puts the mention in its place, as a chip. */
  replaceToken: (raw: string | null) => void;
  /** Types `text` at the cursor, as the keyboard would. */
  insertText: (text: string) => void;
  /** Puts an attached file's chip where the cursor is, or where it was last, or at the end. */
  insertFile: (name: string) => void;
};

type Props = {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  /** The word before the cursor when it starts with `$`, `@` or `/`; null when it does not. */
  onToken?: (token: Token | null) => void;
  /** The option the open menu has picked, for assistive technology. */
  activeId?: string;
  onPasteFiles: (files: File[]) => void;
  onSubmit: () => void;
  /** A click on an attached file's chip. */
  onOpenFile?: (name: string) => void;
  /** Sees each key first; true means it was handled (the menus' arrows and Enter) and the editor leaves it. */
  onKey?: (event: KeyboardEvent) => boolean;
};

const MENTION_ATTR = 'data-mention';
/** What copy writes besides plain text, so a paste inside the console brings the chips back. */
const CLIPBOARD_TYPE = 'application/x-ops-console-composer';

/**
 * The message box: text with a chip for each `$skill` and `@file` mention. Its value is the plain text the agent reads,
 * each chip written as its mention (`$code-review`, `@src/app.ts`). Enter sends, Shift+Enter adds a line, pasted text
 * comes in plain, and a paste that came from this box brings its chips back.
 */
export const MessageEditor = forwardRef<MessageEditorHandle, Props>(function MessageEditor(
  { label, value, placeholder, onChange, onToken, activeId, onPasteFiles, onSubmit, onOpenFile, onKey },
  handle,
) {
  const root = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | null>(null);
  const reported = useRef<string | null>(null);
  const tokenRef = useRef(onToken);
  tokenRef.current = onToken;
  // Where the cursor last was in the box: a file picker takes the focus, and the file still goes there.
  const lastCaret = useRef<Range | null>(null);

  const report = useCallback(() => {
    const node = root.current;
    if (!node) return;
    const selection = document.getSelection();
    if (selection && selection.rangeCount > 0 && node.contains(selection.anchorNode)) {
      lastCaret.current = selection.getRangeAt(0).cloneRange();
    }
    const found = tokenAtCaret(node);
    const key = found?.token.key ?? null;
    if (key === reported.current) return;
    reported.current = key;
    tokenRef.current?.(found?.token ?? null);
  }, []);

  const emit = useCallback(() => {
    const node = root.current;
    if (!node) return;
    const next = serialize(node);
    emitted.current = next;
    onChange(next);
    report();
  }, [onChange, report]);

  // The value changed from outside (sent, restored, taken back): draw it again.
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || value === emitted.current || value === serialize(node)) return;
    draw(node, value, true);
    emitted.current = value;
    if (document.activeElement === node) placeCaret(endOf(node));
  }, [value]);

  // Back from another tab or window with the box still focused: the browser may have dropped the cursor.
  useEffect(() => {
    const restore = () => {
      const node = root.current;
      if (!node || document.visibilityState !== 'visible' || document.activeElement !== node) return;
      const selection = document.getSelection();
      if (selection && selection.rangeCount > 0 && node.contains(selection.anchorNode)) return;
      placeCaret(
        lastCaret.current && node.contains(lastCaret.current.startContainer) ? lastCaret.current : endOf(node),
      );
    };
    document.addEventListener('visibilitychange', restore);
    window.addEventListener('focus', restore);
    return () => {
      document.removeEventListener('visibilitychange', restore);
      window.removeEventListener('focus', restore);
    };
  }, []);

  // The menus follow the cursor: a move into or out of a `$`, `@` or `/` word opens or closes its menu.
  useEffect(() => {
    document.addEventListener('selectionchange', report);
    return () => document.removeEventListener('selectionchange', report);
  }, [report]);

  useImperativeHandle(
    handle,
    () => ({
      focusEnd: () => {
        const node = root.current;
        if (!node) return;
        node.focus();
        placeCaret(endOf(node));
        revealCaret(node);
      },
      replaceToken: (raw) => {
        const node = root.current;
        const found = node && tokenAtCaret(node);
        if (!node || !found) return;
        node.focus();
        const range = document.createRange();
        range.setStart(found.text, found.start);
        range.setEnd(found.text, found.end);
        placeCaret(range);
        if (raw === null) {
          document.execCommand('delete');
          return;
        }
        // Two commands, so undo steps back over the chip and then the space.
        insertHtml(chip(raw).outerHTML);
        document.execCommand('insertText', false, ' ');
      },
      insertText: (text) => {
        root.current?.focus();
        document.execCommand('insertText', false, text);
      },
      insertFile: (name) => {
        const node = root.current;
        if (!node) return;
        node.focus();
        const selection = document.getSelection();
        const inside = selection && selection.rangeCount > 0 && node.contains(selection.anchorNode);
        if (!inside)
          placeCaret(
            lastCaret.current && node.contains(lastCaret.current.startContainer) ? lastCaret.current : endOf(node),
          );
        insertHtml(chip(fileToken(name)).outerHTML);
        document.execCommand('insertText', false, ' ');
        revealCaret(node);
      },
    }),
    [],
  );

  return (
    <div className="relative">
      {value === '' && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-3.5 right-4 left-4 text-sm leading-relaxed text-neutral-600"
        >
          {placeholder}
        </span>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: a textarea cannot hold the mention chips; this is the text box */}
      <div
        ref={root}
        role="textbox"
        tabIndex={0}
        aria-multiline
        aria-label={label}
        aria-placeholder={placeholder}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onClick={(event) => {
          const target = event.target instanceof Element ? event.target.closest(`[${MENTION_ATTR}]`) : null;
          const name = attachedName(target?.getAttribute(MENTION_ATTR) ?? '');
          if (name !== null) onOpenFile?.(name);
        }}
        onCopy={(event) => copy(event, false)}
        onCut={(event) => copy(event, true)}
        onPaste={(event) => {
          event.preventDefault();
          const files = filesIn(event.clipboardData);
          // A pasted screenshot or copied file attaches; pasted text comes in as plain text.
          if (files.length > 0) {
            onPasteFiles(files);
            return;
          }
          const own = event.clipboardData.getData(CLIPBOARD_TYPE);
          if (own) {
            const holder = document.createElement('div');
            draw(holder, own);
            insertHtml(holder.innerHTML);
            revealCaret(event.currentTarget);
            return;
          }
          const text = event.clipboardData.getData('text/plain');
          // Text too long to draw in the box attaches as a file the operator can still open and read.
          if (text.length > PASTE_AS_FILE_LIMIT) {
            onPasteFiles([new File([text], 'pasted-text.txt', { type: 'text/plain' })]);
            return;
          }
          document.execCommand('insertText', false, text);
          revealCaret(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (onKey?.(event.nativeEvent)) {
            event.preventDefault();
            return;
          }
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (event.shiftKey) document.execCommand('insertLineBreak');
          else onSubmit();
        }}
        className="block max-h-[50vh] min-h-28 w-full overflow-y-auto px-4 pt-3.5 pb-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-text outline-none"
      />
    </div>
  );
});

/** Writes the selection as plain text and as the box's own form; a cut takes it out too. */
function copy(event: React.ClipboardEvent<HTMLElement>, cut: boolean) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  event.preventDefault();
  const text = serialize(selection.getRangeAt(0).cloneContents());
  event.clipboardData.setData('text/plain', text);
  event.clipboardData.setData(CLIPBOARD_TYPE, text);
  if (cut) document.execCommand('delete');
}

/** The message as text: each chip as its mention, each line break as `\n`. A last `<br>` only holds the cursor. */
function serialize(node: Node): string {
  let out = '';
  const walk = (parent: Node) => {
    parent.childNodes.forEach((child, index) => {
      if (child.nodeType === Node.TEXT_NODE) out += (child.textContent ?? '').replace(/\u00a0/g, ' ');
      else if (child instanceof HTMLElement && child.hasAttribute(MENTION_ATTR))
        out += child.getAttribute(MENTION_ATTR) ?? '';
      else if (child.nodeName === 'BR') {
        if (!(parent === node && index === parent.childNodes.length - 1)) out += '\n';
      } else if (child.nodeName === 'DIV' || child.nodeName === 'P') {
        if (out !== '' && !out.endsWith('\n')) out += '\n';
        walk(child);
      } else walk(child);
    });
  };
  walk(node);
  return out;
}

/** Draws `value` into the box: text, a `<br>` per line break, a chip per mention. */
function draw(node: HTMLElement, value: string, anchorCursor = false) {
  node.replaceChildren();
  let at = 0;
  const text = (piece: string) => {
    piece.split('\n').forEach((line, index) => {
      if (index > 0) node.append(document.createElement('br'));
      if (line) node.append(document.createTextNode(line));
    });
  };
  for (const { raw, start, end } of chipsIn(value)) {
    text(value.slice(at, start));
    node.append(chip(raw));
    at = end;
  }
  text(value.slice(at));
  // A line break at the very end needs one more for the cursor to sit on the new line. In the box itself a last chip
  // needs one too: the cursor after it has no line to draw on, and a `<br>` last in the box is not part of the text.
  const last = node.lastChild;
  const endsInChip = anchorCursor && last instanceof HTMLElement && last.hasAttribute(MENTION_ATTR);
  if (value.endsWith('\n') || endsInChip) node.append(document.createElement('br'));
}

const SVG = 'http://www.w3.org/2000/svg';

/** A mention as a chip that cannot be edited into: the cursor steps over it and Backspace takes it whole. */
function chip(raw: string): HTMLElement {
  const { kind, label, title, badge } = describeMention(raw);
  const element = document.createElement('span');
  element.setAttribute(MENTION_ATTR, raw);
  element.contentEditable = 'false';
  element.setAttribute('role', 'img');
  element.setAttribute(
    'aria-label',
    `${kind === 'skill' ? 'Skill' : kind === 'attachment' ? 'Attached file' : 'File'} ${label}`,
  );
  element.title = title;
  element.className = CHIP_CLASS[kind];
  const name = Object.assign(document.createElement('span'), { className: 'min-w-0 truncate', textContent: label });
  if (kind === 'attachment') element.setAttribute('role', 'button');
  if (kind === 'skill') {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'flex-none');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', CUBE_PATH);
    svg.append(path);
    element.append(svg, name);
  } else {
    const mark = Object.assign(document.createElement('span'), { className: CHIP_CLASS.badge });
    mark.setAttribute('data-badge', badge || 'FILE');
    mark.setAttribute('aria-hidden', 'true');
    element.append(mark, name);
  }
  return element;
}

/** The `$`, `@` or `/` word that ends at the cursor, with where it sits in its text node. */
function tokenAtCaret(node: HTMLElement): { token: Token; text: Text; start: number; end: number } | null {
  const selection = document.getSelection();
  const at = selection?.anchorNode;
  if (!selection?.isCollapsed || !at || !node.contains(at) || !(at instanceof Text)) return null;
  const end = selection.anchorOffset;
  const word = /\S*$/.exec(at.data.slice(0, end))?.[0] ?? '';
  const trigger = word.charAt(0);
  if (trigger !== '$' && trigger !== '@' && trigger !== '/') return null;
  const start = end - word.length;
  // Where the word starts in the message, so the same word in another place is another menu.
  const before = document.createRange();
  before.setStart(node, 0);
  before.setEnd(at, start);
  const place = serialize(before.cloneContents()).length;
  return { token: { trigger, query: word.slice(1), text: word, key: `${place}:${word}` }, text: at, start, end };
}

/** Inserts markup at the cursor with the browser's own command, so undo steps back over it. */
function insertHtml(html: string) {
  document.execCommand('insertHTML', false, html);
  // The browser can leave the cursor inside the last chip, where nothing can be typed: it goes after it.
  const at = document.getSelection()?.anchorNode;
  const inside = (at instanceof Element ? at : at?.parentElement)?.closest(`[${MENTION_ATTR}]`);
  if (!inside) return;
  const after = document.createRange();
  after.setStartAfter(inside);
  after.collapse(true);
  placeCaret(after);
}

function placeCaret(range: Range) {
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Scrolls the box so the cursor, which a paste leaves after the pasted text, is in view. */
function revealCaret(node: HTMLElement) {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const caret = selection.getRangeAt(0).cloneRange();
  caret.collapse(false);
  // The cursor at the very end: the last line, whatever the browser's own scroll did.
  if (caret.compareBoundaryPoints(Range.END_TO_END, endOf(node)) >= 0) {
    node.scrollTop = node.scrollHeight;
  } else {
    const at = caret.getClientRects()[0];
    const box = node.getBoundingClientRect();
    if (at && at.bottom > box.bottom) node.scrollTop += at.bottom - box.bottom + 8;
    else if (at && at.top < box.top) node.scrollTop -= box.top - at.top + 8;
  }
  node.scrollIntoView({ block: 'nearest' });
}

function endOf(node: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(node);
  // Before the `<br>` that only holds the cursor.
  if (node.lastChild?.nodeName === 'BR') range.setEndBefore(node.lastChild);
  range.collapse(false);
  return range;
}
