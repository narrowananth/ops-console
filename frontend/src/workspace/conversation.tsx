import type { Message } from '@ops-console/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

/** How close to the end, in pixels, still counts as reading the newest message. */
const AT_END_PX = 48;

/**
 * Keeps a conversation at its newest message: when it opens, and as messages arrive or stream while the operator is
 * at the end. Scrolled up to read, it stays put until they scroll back down. The nodes live in state, so the observer
 * is made in an effect and outlives React's development double mount.
 */
export function useFollowLatest() {
  const following = useRef(true);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);
  // False once the operator has scrolled up to read; the "Scroll to end" button shows then.
  const [atEnd, setAtEnd] = useState(true);
  useEffect(() => {
    if (!scroller || !content) return;
    const toEnd = () => {
      if (following.current) scroller.scrollTop = scroller.scrollHeight;
      else setAtEnd(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_END_PX);
    };
    const observer = new ResizeObserver(toEnd);
    observer.observe(scroller);
    observer.observe(content);
    toEnd();
    return () => observer.disconnect();
  }, [scroller, content]);
  const onScroll = useCallback(() => {
    if (!scroller) return;
    following.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_END_PX;
    setAtEnd(following.current);
  }, [scroller]);
  const scrollToEnd = useCallback(() => {
    if (!scroller) return;
    following.current = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  }, [scroller]);
  return { scroller, content, setScroller, setContent, onScroll, atEnd, scrollToEnd };
}

/** A button over the conversation's bottom edge while the operator is scrolled up; it jumps back to the newest message. */
export function ScrollToEnd({ show, onClick }: { show: boolean; onClick: () => void }) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-divider bg-card px-3.5 py-1.5 text-xs font-medium text-text shadow-md hover:bg-neutral-200"
    >
      <span aria-hidden="true">↓</span> Scroll to end
    </button>
  );
}

/** The first line of what a message says, for the map's label. */
function gist(message: Message): string {
  const said = message.parts.find((part) => 'text' in part && part.text.trim() !== '');
  const text = said && 'text' in said ? (said.text.trim().split('\n')[0] ?? '') : '';
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/**
 * A rail beside the conversation with a mark per message, the operator's longer and darker; the marks of the messages
 * in view are tinted. A mark scrolls to its message and names it on hover.
 */
export function ConversationMap({
  messages,
  scroller,
  content,
}: {
  messages: Message[];
  scroller: HTMLElement | null;
  content: HTMLElement | null;
}) {
  const [inView, setInView] = useState<[number, number]>([-1, -1]);
  const items = useCallback(
    () => (content ? Array.from(content.querySelectorAll<HTMLElement>(':scope > ul > li')) : []),
    [content],
  );

  useEffect(() => {
    if (!scroller || !content) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = scroller.scrollTop;
        const bottom = top + scroller.clientHeight;
        const seen = items()
          .map((item, index) => ({ index, from: item.offsetTop, to: item.offsetTop + item.offsetHeight }))
          .filter((item) => item.to > top && item.from < bottom)
          .map((item) => item.index);
        setInView(seen.length === 0 ? [-1, -1] : [seen[0] ?? -1, seen.at(-1) ?? -1]);
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(content);
    scroller.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener('scroll', measure);
    };
  }, [scroller, content, items]);

  if (messages.length < 2) return null;
  const go = (index: number) => {
    const item = items()[index];
    if (scroller && item) scroller.scrollTo({ top: Math.max(0, item.offsetTop - 8), behavior: 'smooth' });
  };
  return (
    <nav aria-label="Conversation map" className="absolute top-3 bottom-3 left-1 flex w-3.5 flex-col">
      {messages.map((message, index) => {
        const yours = message.role === 'user';
        const seen = index >= inView[0] && index <= inView[1];
        const label = `${yours ? 'You' : 'Agent'}: ${gist(message) || 'no text'}`;
        return (
          <button
            key={message.id}
            type="button"
            aria-label={label}
            aria-current={seen ? 'location' : undefined}
            title={label}
            onClick={() => go(index)}
            className="group flex max-h-2.5 min-h-px flex-1 cursor-pointer items-center border-0 bg-transparent p-0"
          >
            <span
              className={`block h-0.5 rounded-full transition-colors group-hover:bg-accent ${yours ? 'w-3.5' : 'w-2'} ${
                seen ? 'bg-accent-400' : yours ? 'bg-text/55' : 'bg-text/20'
              }`}
            />
          </button>
        );
      })}
    </nav>
  );
}
