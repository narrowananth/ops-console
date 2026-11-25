import { type CSSProperties, useEffect, useRef, useState } from 'react';

/**
 * A menu opened above its button in the composer's toolbar: where it sits, and the keys and scrolls that close it.
 * `marker` is the data attribute the menu's box carries, so a scroll inside it does not close it.
 */
export function useAnchoredMenu(marker: string) {
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = place !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPlace(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      trigger.current?.focus();
    };
    // A scroll anywhere but inside the list would leave it floating away from its button.
    const scroll = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest(`[${marker}]`))) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, marker]);

  return {
    trigger,
    open,
    place,
    close: () => setPlace(null),
    /** Opens the menu, or closes it when open; `onOpen` runs only when it opens. */
    toggle: (onOpen?: () => void) => {
      const box = trigger.current?.getBoundingClientRect();
      if (open || !box) return setPlace(null);
      onOpen?.();
      // The list is 18rem wide; the button sits at the toolbar's left edge, so the list only needs a nudge in a narrow window.
      setPlace({
        bottom: window.innerHeight - box.top + 6,
        left: Math.max(8, Math.min(box.left, window.innerWidth - 296)),
      });
    },
  };
}
