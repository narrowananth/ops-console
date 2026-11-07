import { FILE_TOKEN, fileToken } from '@ops-console/shared';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { size } from '../components/ui/attachment-viewer';
import { type FileItem, filesIn } from './attachments';

export type MessageEditorHandle = {
  /** Puts a chip per file at the cursor, or at the end when the cursor is not in the message. */
  insertFiles: (names: string[]) => void;
  /** Focuses the message with the cursor after its last character. */
  focusEnd: () => void;
};

type Props = {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  /** The file under each chip's name; a token with no file shows as the text it is. */
  find: (name: string) => FileItem | undefined;
  onOpen: (name: string) => void;
  onPasteFiles: (files: File[]) => void;
  onSubmit: () => void;
  /** Sees each key first; true means it was handled (the skill menu's arrows and Enter) and the editor leaves it. */
  onKey?: (event: KeyboardEvent) => boolean;
};

const CHIP = 'data-file';

/**
 * The message box: text with a chip in it for each attached file, where it was dropped, pasted or picked. Its value is
 * plain text, each chip written as `[📎 <name>]`. Enter sends, Shift+Enter adds a line, pasted text comes in plain.
 */
export const MessageEditor = forwardRef<MessageEditorHandle, Props>(function MessageEditor(
  { label, value, placeholder, onChange, find, onOpen, onPasteFiles, onSubmit, onKey },
  handle,
) {
  const root = useRef<HTMLDivElement>(null);
  // The cursor while the message had focus, so a file picked from the button goes where the operator was typing.
  const caret = useRef<Range | null>(null);
  const emitted = useRef<string | null>(null);
  const findRef = useRef(find);
  findRef.current = find;

  const emit = useCallback(() => {
    const node = root.current;
    if (!node) return;
    const next = serialize(node);
    emitted.current = next;
    onChange(next);
  }, [onChange]);

  // The value changed from outside (sent, restored, taken back): draw it again.
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || value === emitted.current || value === serialize(node)) return;
    draw(node, value, findRef.current);
    emitted.current = value;
    // Text put in from outside while the operator is typing here (a skill picked from the menu): carry on after it.
    if (document.activeElement === node) {
      const end = endOf(node);
      caret.current = end;
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(end);
    }
  }, [value]);

  // Chips follow their files: uploading, saved, failed, a thumbnail once read.
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    for (const chip of node.querySelectorAll<HTMLElement>(`[${CHIP}]`)) {
      paint(chip, find(chip.getAttribute(CHIP) ?? ''));
    }
  });

  useEffect(() => {
    const keep = () => {
      const selection = document.getSelection();
      const node = root.current;
      if (selection && selection.rangeCount > 0 && node?.contains(selection.anchorNode)) {
        caret.current = selection.getRangeAt(0).cloneRange();
      }
    };
    document.addEventListener('selectionchange', keep);
    return () => document.removeEventListener('selectionchange', keep);
  }, []);

  useImperativeHandle(
    handle,
    () => ({
      focusEnd: () => {
        const node = root.current;
        if (!node) return;
        node.focus();
        const end = endOf(node);
        caret.current = end;
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(end);
      },
      insertFiles: (names) => {
        const node = root.current;
        if (!node || names.length === 0) return;
        const range =
          caret.current && node.contains(caret.current.startContainer) ? caret.current.cloneRange() : endOf(node);
        range.deleteContents();
        const piece = document.createDocumentFragment();
        for (const name of names) {
          piece.append(chip(name, findRef.current(name)), document.createTextNode(' '));
        }
        const last = piece.lastChild;
        range.insertNode(piece);
        if (last) {
          const after = document.createRange();
          after.setStartAfter(last);
          after.collapse(true);
          caret.current = after;
          if (document.activeElement === node) {
            document.getSelection()?.removeAllRanges();
            document.getSelection()?.addRange(after);
          }
        }
        emit();
      },
    }),
    [emit],
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
      {/* biome-ignore lint/a11y/useSemanticElements: a textarea cannot hold the file chips; this is the text box */}
      <div
        ref={root}
        role="textbox"
        tabIndex={0}
        aria-multiline
        aria-label={label}
        aria-placeholder={placeholder}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onPaste={(event) => {
          event.preventDefault();
          const files = filesIn(event.clipboardData);
          // A pasted screenshot or copied file attaches; pasted text comes in as plain text.
          if (files.length > 0) onPasteFiles(files);
          else document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
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
        onClick={(event) => {
          const target = event.target as HTMLElement;
          const at = target.closest<HTMLElement>(`[${CHIP}]`);
          if (!at) return;
          if (target.closest('[data-remove]')) {
            const space = at.nextSibling;
            if (space?.nodeType === Node.TEXT_NODE && space.textContent === ' ') space.remove();
            at.remove();
            emit();
            return;
          }
          onOpen(at.getAttribute(CHIP) ?? '');
        }}
        className="block max-h-[50vh] min-h-28 w-full overflow-y-auto px-4 pt-3.5 pb-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-text outline-none"
      />
    </div>
  );
});

/** The message as text: each chip as its token, each line break as `\n`. A last `<br>` only holds the cursor. */
function serialize(node: HTMLElement): string {
  let out = '';
  const walk = (parent: Node) => {
    parent.childNodes.forEach((child, index) => {
      if (child.nodeType === Node.TEXT_NODE) out += (child.textContent ?? '').replace(/ /g, ' ');
      else if (child instanceof HTMLElement && child.hasAttribute(CHIP))
        out += fileToken(child.getAttribute(CHIP) ?? '');
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

/** Draws `value` into the box: text, a `<br>` per line break, a chip per token whose file is known. */
function draw(node: HTMLElement, value: string, find: (name: string) => FileItem | undefined) {
  node.replaceChildren();
  let at = 0;
  const text = (piece: string) => {
    piece.split('\n').forEach((line, index) => {
      if (index > 0) node.append(document.createElement('br'));
      if (line) node.append(document.createTextNode(line));
    });
  };
  for (const match of value.matchAll(FILE_TOKEN)) {
    const name = match[1] as string;
    const start = match.index ?? 0;
    text(value.slice(at, start));
    node.append(find(name) ? chip(name, find(name)) : document.createTextNode(match[0]));
    at = start + match[0].length;
  }
  text(value.slice(at));
  // A line break at the very end needs one more for the cursor to sit on the new line.
  if (value.endsWith('\n')) node.append(document.createElement('br'));
}

function chip(name: string, item: FileItem | undefined): HTMLElement {
  const element = document.createElement('span');
  element.setAttribute(CHIP, name);
  element.contentEditable = 'false';
  element.className =
    'mx-0.5 inline-flex max-w-72 cursor-pointer items-center gap-1.5 rounded-md border py-0.5 pr-0.5 pl-1 align-middle font-mono text-xs leading-5 select-none hover:border-accent-300';
  paint(element, item);
  return element;
}

/** A chip's look for its file's state; drawn again as the upload goes. */
function paint(element: HTMLElement, item: FileItem | undefined) {
  const name = element.getAttribute(CHIP) ?? '';
  const state = !item ? 'gone' : item.error ? 'failed' : item.saved ? size(item.saved.size) : 'uploading…';
  const key = `${state}|${item?.preview ?? ''}`;
  if (element.dataset.painted === key) return;
  element.dataset.painted = key;
  element.title = item?.error ?? (item ? `Open ${name}` : `${name} is no longer attached`);
  element.setAttribute('aria-label', `${name}, ${state}`);
  element.classList.toggle('border-accent-300', state === 'failed');
  element.classList.toggle('text-accent-700', state === 'failed');
  element.classList.toggle('border-line', state !== 'failed');
  element.classList.toggle('bg-bg', true);
  const thumb = item?.preview
    ? Object.assign(document.createElement('img'), {
        src: item.preview,
        alt: '',
        className: 'size-5 flex-none rounded-sm object-cover',
      })
    : clip();
  const label = Object.assign(document.createElement('span'), { className: 'min-w-0 truncate', textContent: name });
  const note = Object.assign(document.createElement('span'), {
    className: 'flex-none text-[11px] text-neutral-700',
    textContent: state,
  });
  const remove = Object.assign(document.createElement('span'), {
    className:
      'flex size-4.5 flex-none items-center justify-center rounded-sm text-neutral-700 hover:bg-neutral-200 hover:text-text',
    textContent: '×',
    title: `Remove ${name}`,
  });
  remove.setAttribute('data-remove', '');
  remove.setAttribute('role', 'button');
  remove.setAttribute('aria-label', `Remove ${name}`);
  element.replaceChildren(thumb, label, note, remove);
}

function clip(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'flex-none');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5l5.3-5.3a2.1 2.1 0 0 1 3 3L6.6 10.9a1 1 0 0 1-1.5-1.5L10 4.5',
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(path);
  return svg;
}

function endOf(node: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(node);
  // Before the `<br>` that only holds the cursor.
  if (node.lastChild?.nodeName === 'BR') range.setEndBefore(node.lastChild);
  range.collapse(false);
  return range;
}
