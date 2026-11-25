import { PrState, type Repo, type Session } from '@ops-console/shared';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { MODEL_NAME } from '../agent-runs/run-look';
import { BranchIcon, FolderIcon, PullRequestIcon } from '../components/ui/icons';
import { useRepoPullRequests } from '../lib/queries';

/** A pull request of a Session with what the Git host says of it; `state` and `title` are null until it answers. */
export type SessionPull = { number: number; url: string; branch: string; title: string | null; state: PrState | null };

/** The icon colour of each pull request state; a pull request the host has not answered for stays grey. */
export const PULL_COLOUR: Record<PrState | 'unknown', string> = {
  [PrState.Open]: 'text-ok',
  [PrState.Merged]: 'text-skill',
  [PrState.Closed]: 'text-accent-700',
  unknown: 'text-neutral-600',
};

/**
 * The pull requests the console opened for a Session, each with its title and state from the daemon's cache of the Git
 * host. The merged and closed lists are read only once the open one answered and left one out.
 */
export function useSessionPulls(session: Session, enabled = true): SessionPull[] {
  const wanted = session.pull_requests;
  const on = enabled && wanted.length > 0;
  const open = useRepoPullRequests(session.repo_id, PrState.Open, on);
  const missingOpen =
    open.isSuccess && wanted.some((one) => !open.data.data.some((candidate) => candidate.number === one.number));
  const merged = useRepoPullRequests(session.repo_id, PrState.Merged, on && missingOpen);
  const missingMerged =
    missingOpen &&
    merged.isSuccess &&
    wanted.some((one) => ![open, merged].some((list) => list.data?.data.some((p) => p.number === one.number)));
  const closed = useRepoPullRequests(session.repo_id, PrState.Closed, on && missingMerged);
  return wanted.map((one) => {
    const found = [open, merged, closed]
      .flatMap((list) => list.data?.data ?? [])
      .find((candidate) => candidate.number === one.number);
    return { ...one, title: found?.title ?? null, state: found?.state ?? null };
  });
}

const GAP = 8;
const EDGE = 8;
/** How long the pointer rests on a row before its card shows. */
const SHOW_MS = 400;

/** What a card inside another card's target tells it: the pointer is on me, so stay closed; it left, so go on. */
const Nested = createContext<{ hold: () => void; release: () => void } | null>(null);

/**
 * Shows `card` beside the element it wraps after the pointer rests on it, or at once on keyboard focus. A HoverCard
 * inside another one is its own target: while the pointer is on it, the outer card stays closed.
 */
export function HoverCard({ card, children }: { card: (anchor: HTMLElement) => ReactNode; children: ReactNode }) {
  const outer = useContext(Nested);
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const pointerOn = useRef(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const show = (delay: number) => {
    window.clearTimeout(timer.current);
    if (held.current) return;
    timer.current = window.setTimeout(() => setAnchor(ref.current), delay);
  };
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setAnchor(null);
  }, []);
  const inner = useMemo(
    () => ({
      hold: () => {
        held.current = true;
        hide();
      },
      release: () => {
        held.current = false;
        timer.current = window.setTimeout(() => setAnchor(ref.current), SHOW_MS);
      },
    }),
    [hide],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // Unmounted under the pointer (a refetch emptied the list): no leave event comes, so the outer card is let go here.
  useEffect(
    () => () => {
      if (pointerOn.current) outer?.release();
    },
    [outer],
  );
  useEffect(() => {
    if (!anchor) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && hide();
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [anchor, hide]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the card is a hover extra; the row inside stays the control
    <span
      ref={ref}
      className="contents"
      onPointerEnter={() => {
        pointerOn.current = true;
        outer?.hold();
        show(SHOW_MS);
      }}
      onPointerLeave={() => {
        pointerOn.current = false;
        hide();
        outer?.release();
      }}
      onPointerDown={hide}
      onFocus={(event) => event.target.matches(':focus-visible') && show(0)}
      onBlur={hide}
    >
      <Nested.Provider value={inner}>{children}</Nested.Provider>
      {anchor && createPortal(<Placed anchor={anchor}>{card(anchor)}</Placed>, document.body)}
    </span>
  );
}

/** The card to the right of `anchor`, or to its left when the window has no room, kept inside the window's height. */
function Placed({ anchor, children }: { anchor: HTMLElement; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const card = box.current;
    const row = anchor.firstElementChild?.getBoundingClientRect();
    if (!card || !row) return;
    const size = card.getBoundingClientRect();
    const right = row.right + GAP;
    const left = right + size.width + EDGE <= window.innerWidth ? right : Math.max(EDGE, row.left - GAP - size.width);
    const top = Math.min(Math.max(EDGE, row.top), Math.max(EDGE, window.innerHeight - EDGE - size.height));
    setPlace({ left, top });
  }, [anchor]);
  return (
    <div
      ref={box}
      role="tooltip"
      style={place ?? { left: 0, top: 0, visibility: 'hidden' }}
      className="pointer-events-none fixed z-[1000] flex max-h-[calc(100vh-16px)] w-80 flex-col gap-1.5 overflow-hidden rounded-lg border border-line bg-card px-3 py-2.5 text-left text-xs text-text shadow-lg"
    >
      {children}
    </div>
  );
}

const Line = ({ icon, children }: { icon: ReactNode; children: ReactNode }) => (
  <div className="flex min-w-0 items-center gap-2 text-neutral-800">
    <span aria-hidden className="size-3.5 flex-none text-neutral-600 [&>svg]:size-3.5">
      {icon}
    </span>
    <span className="min-w-0 truncate">{children}</span>
  </div>
);

/** What the row's hover card says: title, Repo, branch, state, the agent's settings, then each pull request. */
export function SessionCard({
  session,
  repo,
  stateTip,
  badge,
}: {
  session: Session;
  repo: Repo | null;
  stateTip: string;
  badge: ReactNode;
}) {
  const pulls = useSessionPulls(session);
  return (
    <>
      <div className="text-[13px] leading-snug font-medium break-words">{session.title}</div>
      <div className="flex min-w-0 items-center gap-2 text-neutral-800">
        {badge}
        <span className="min-w-0 truncate">
          {repo ? `${repo.name} on ${repo.host}` : 'No Repo: a folder of its own'}
        </span>
      </div>
      {repo && <Line icon={<FolderIcon />}>{repo.path}</Line>}
      {session.branch && <Line icon={<BranchIcon />}>{session.branch}</Line>}
      {repo?.branch && session.branch && repo.branch !== session.branch && (
        <div className="text-accent-700">You're currently checked out on another branch.</div>
      )}
      <div className="text-neutral-700">{stateTip}</div>
      <div className="text-neutral-700">
        {MODEL_NAME[session.model]} · {session.effort} effort · {session.access_mode.replace('_', ' ')} access
      </div>
      <div className="text-neutral-600">
        Started {new Date(session.created_at).toLocaleString()} · active{' '}
        {new Date(session.last_active_at).toLocaleString()}
      </div>
      {pulls.length > 0 && <PullLines pulls={pulls} className="mt-1 border-t border-line pt-2" />}
    </>
  );
}

/** One line per pull request: its state icon, number and title. */
export function PullLines({ pulls, className = '' }: { pulls: SessionPull[]; className?: string }) {
  return (
    <ul className={`m-0 flex list-none flex-col gap-1 p-0 ${className}`}>
      {pulls.map((pull) => (
        <li key={pull.number} className="flex min-w-0 items-center gap-2">
          <span aria-hidden className={`size-3.5 flex-none [&>svg]:size-3.5 ${PULL_COLOUR[pull.state ?? 'unknown']}`}>
            <PullRequestIcon />
          </span>
          <span className="flex-none font-mono">#{pull.number}</span>
          <span className="min-w-0 truncate text-neutral-800">{pull.title ?? pull.branch}</span>
        </li>
      ))}
    </ul>
  );
}
