import type { Message } from '@ops-console/shared';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

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
  /** The operator jumps elsewhere: a message that changes size on the way must not pull the view back to the end. */
  const release = useCallback(() => {
    following.current = false;
    setAtEnd(false);
  }, []);
  return { scroller, content, setScroller, setContent, onScroll, atEnd, scrollToEnd, release };
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

const gists = new WeakMap<Message, string>();

/** The first line of what a message says, for the map's label; read once per message object. */
function gist(message: Message): string {
  const known = gists.get(message);
  if (known !== undefined) return known;
  const said = message.parts.find((part) => 'text' in part && part.text.trim() !== '');
  const text = said && 'text' in said ? (said.text.trim().split('\n')[0] ?? '') : '';
  const line = text.length > 120 ? `${text.slice(0, 119)}…` : text;
  gists.set(message, line);
  return line;
}

/** One message's mark on the rail: memoized, so a streaming message redraws only its own. */
const Mark = memo(function Mark({
  id,
  yours,
  label,
  seen,
  onGo,
}: {
  id: string;
  yours: boolean;
  label: string;
  seen: boolean;
  onGo: (id: string) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={seen ? 'location' : undefined}
      title={label}
      onClick={() => onGo(id)}
      className="group flex max-h-2.5 min-h-px flex-1 cursor-pointer items-center border-0 bg-transparent p-0"
    >
      <span
        className={`block h-0.5 rounded-full transition-colors group-hover:bg-accent ${yours ? 'w-3.5' : 'w-2'} ${
          seen ? 'bg-accent-400' : yours ? 'bg-text/55' : 'bg-text/20'
        }`}
      />
    </button>
  );
});

/**
 * A rail beside the conversation with a mark per message, the operator's longer and darker; the marks of the messages
 * in view are tinted. A mark scrolls to its message and names it on hover. An IntersectionObserver tells which messages
 * are in view, so a resize or a streamed token measures nothing; only a message that enters or leaves the screen does.
 */
export function ConversationMap({
  messages,
  scroller,
  content,
  onJump,
}: {
  messages: Message[];
  scroller: HTMLElement | null;
  content: HTMLElement | null;
  /** Called before the view scrolls to a message. */
  onJump: () => void;
}) {
  const [inView, setInView] = useState<ReadonlySet<string>>(new Set());
  const ids = messages.map((message) => message.id).join('\n');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `ids` says when the list of messages changed; the items are read from the page
  useEffect(() => {
    if (!scroller || !content) return;
    const seen = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageId;
          if (id === undefined) continue;
          if (entry.isIntersecting) seen.add(id);
          else seen.delete(id);
        }
        setInView(new Set(seen));
      },
      { root: scroller },
    );
    const items = content.querySelectorAll<HTMLElement>(':scope > ul > li[data-message-id]');
    for (const item of items) observer.observe(item);
    return () => observer.disconnect();
  }, [scroller, content, ids]);

  const go = useCallback(
    (id: string) => {
      const item = content?.querySelector<HTMLElement>(`:scope > ul > li[data-message-id="${CSS.escape(id)}"]`);
      if (!scroller || !item) return;
      onJump();
      // At once, not smooth: a smooth scroll starts near the end, where the view would still read as following.
      scroller.scrollTo({ top: Math.max(0, item.offsetTop - 8) });
    },
    [scroller, content, onJump],
  );

  if (messages.length < 2) return null;
  return (
    <nav aria-label="Conversation map" className="absolute top-3 bottom-3 left-1 flex w-3.5 flex-col">
      {messages.map((message) => (
        <Mark
          key={message.id}
          id={message.id}
          yours={message.role === 'user'}
          label={`${message.role === 'user' ? 'You' : 'Agent'}: ${gist(message) || 'no text'}`}
          seen={inView.has(message.id)}
          onGo={go}
        />
      ))}
    </nav>
  );
}
