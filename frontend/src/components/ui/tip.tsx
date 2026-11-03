import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** How long the pointer rests on an element before its tip shows. Keyboard focus shows it at once. */
const HOVER_DELAY_MS = 300;
const GAP = 6;
const EDGE = 8;
const TIP_ID = 'hover-tip';

type Shown = { text: string; target: HTMLElement };

/**
 * Turns the `title` of any element into a styled tip that shows on hover and on keyboard focus, so a tip is just a
 * `title`. While its tip shows, an element's `title` moves aside: the browser's own tooltip would show twice, and the
 * tip names itself to screen readers through `aria-describedby` instead.
 */
export function TipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let current: HTMLElement | null = null;

    const restore = () => {
      window.clearTimeout(timer.current);
      if (current) {
        const text = current.dataset.tipText;
        if (text !== undefined && !current.hasAttribute('title')) current.setAttribute('title', text);
        delete current.dataset.tipText;
        if (current.getAttribute('aria-describedby') === TIP_ID) current.removeAttribute('aria-describedby');
      }
      current = null;
      setShown(null);
    };

    const open = (target: HTMLElement, delay: number) => {
      if (target === current) return;
      restore();
      const text = target.getAttribute('title')?.trim();
      if (!text) return;
      current = target;
      target.dataset.tipText = text;
      target.removeAttribute('title');
      timer.current = window.setTimeout(() => {
        if (current !== target || !target.isConnected) return;
        if (!target.hasAttribute('aria-describedby')) target.setAttribute('aria-describedby', TIP_ID);
        setShown({ text, target });
      }, delay);
    };

    const titled = (node: EventTarget | null) =>
      node instanceof Element ? (node.closest('[title], [data-tip-text]') as HTMLElement | null) : null;

    const onOver = (event: PointerEvent) => {
      const target = titled(event.target);
      if (target === current) return;
      if (target) open(target, HOVER_DELAY_MS);
      else restore();
    };
    const onFocus = (event: FocusEvent) => {
      const target = titled(event.target);
      if (target && event.target instanceof Element && event.target.matches(':focus-visible')) open(target, 0);
    };
    const onLeave = (event: PointerEvent | FocusEvent) => {
      if (!current) return;
      const next = event.relatedTarget;
      if (next instanceof Node && current.contains(next)) return;
      restore();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') restore();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onLeave);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onLeave);
    document.addEventListener('pointerdown', restore, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', restore, true);
    window.addEventListener('blur', restore);
    return () => {
      restore();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onLeave);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onLeave);
      document.removeEventListener('pointerdown', restore, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', restore, true);
      window.removeEventListener('blur', restore);
    };
  }, []);

  return shown ? createPortal(<Bubble {...shown} />, document.body) : null;
}

function Bubble({ text, target }: Shown) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const bubble = ref.current;
    if (!bubble) return;
    const anchor = target.getBoundingClientRect();
    const size = bubble.getBoundingClientRect();
    const below = anchor.bottom + GAP + size.height <= window.innerHeight - EDGE;
    const top = below ? anchor.bottom + GAP : Math.max(EDGE, anchor.top - GAP - size.height);
    const centre = anchor.left + anchor.width / 2 - size.width / 2;
    const left = Math.min(Math.max(EDGE, centre), window.innerWidth - EDGE - size.width);
    setPlace({ left, top });
  }, [target]);

  return (
    <div
      ref={ref}
      id={TIP_ID}
      role="tooltip"
      style={place ?? { left: 0, top: 0, visibility: 'hidden' }}
      className="pointer-events-none fixed z-[1000] max-w-72 rounded-md bg-text px-2.5 py-1.5 text-left font-body text-xs leading-snug font-normal whitespace-pre-line text-bg shadow-lg"
    >
      {text}
    </div>
  );
}

/**
 * A small "?" beside a label whose meaning is not plain from its words: hover or focus it to read what it means.
 * The text is its `title`, so the tip layer shows it. It is no button, as it does nothing.
 */
export function Hint({ text, label = 'What is this?' }: { text: string; label?: string }) {
  return (
    <span
      role="note"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard user tabs to the hint to read it; it does nothing.
      tabIndex={0}
      aria-label={label}
      title={text}
      className="inline-flex size-3.5 flex-none cursor-help items-center justify-center rounded-full border border-neutral-500 align-middle font-body text-xs leading-none font-semibold text-neutral-600 select-none hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent focus-visible:outline-none"
    >
      ?
    </span>
  );
}
