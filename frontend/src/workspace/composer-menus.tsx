import type { FileMenuItem, SkillMenuItem } from '@ops-console/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFileMenu, useSkillMenu } from '../lib/queries';
import { KindBadge } from '../skills/kind-badge';

/** `$` and the name so far: the skills menu is open while the message is one word that starts with a dollar sign. */
const SKILL = /^\$[^\s]*$/;
/** `/` and the name so far: the commands menu is open while the message is one word that starts with a slash. */
const COMMAND = /^\/[^\s]*$/;
/** The `@` and the text after it at the end of the message, which starts the message or follows a space. */
const FILE = /(?:^|\s)@([^\s]*)$/;

/** A Session action the `/` menu runs; the message is cleared when it runs. */
export type ComposerCommand = { name: string; description: string; run: () => void };

type Mode = 'skills' | 'commands' | 'files';

/** `value` after it has held still for `ms`: a menu asks the daemon once the typing pauses, not at each key. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** A row of whichever menu is open: how it looks and what picking it does. */
type Entry = { key: string; row: ReactNode; pick: () => void };

/** A row's key: two skills of one name differ by kind (a Project `pr` and an Ops Console `pr`). */
const keyOf = (item: SkillMenuItem) => `${item.kind}:${item.name}`;

const modeOf = (text: string): Mode | null =>
  SKILL.test(text) ? 'skills' : COMMAND.test(text) ? 'commands' : FILE.test(text) ? 'files' : null;

const HINT: Record<Mode, string> = {
  skills: 'Enter picks, Esc closes. What you type after the name is the task.',
  commands: 'Enter runs it, Esc closes.',
  files: 'Enter inserts the path, Esc closes.',
};

const TITLE: Record<Mode, string> = { skills: 'Skills', commands: 'Commands', files: 'Files' };

/** A path as the agent reads it after an `@`: quoted when it holds a space. */
const mention = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`);

/**
 * The menus above a Session's composer: `$` skills (Ops Console, Custom and, in a Repo, Project), `/` commands for the
 * Session, and `@` files of the Session's Repo, or of every imported Repo when it has none. Each reads when it opens.
 * Arrows move, Enter or Tab picks, Escape closes until the text changes.
 */
export function useComposerMenus({
  sessionId,
  text,
  enabled,
  commands,
  setText,
  onSkill,
  focusEnd,
}: {
  sessionId: string;
  text: string;
  enabled: boolean;
  commands: ComposerCommand[];
  setText: (text: string) => void;
  onSkill: (item: SkillMenuItem) => void;
  /** The editor keeps its focus while a row is clicked and moves the cursor after the new text itself. */
  focusEnd: () => void;
}): { onKey: (event: KeyboardEvent) => boolean; menu: ReactNode } {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const mode = enabled && dismissed !== text ? modeOf(text) : null;
  const q = mode === 'files' ? (FILE.exec(text)?.[1] ?? '') : text.slice(1);
  const asked = useSettled(q, 120);
  const skills = useSkillMenu(sessionId, asked, mode === 'skills');
  const files = useFileMenu(sessionId, asked, mode === 'files');

  const entries: Entry[] =
    mode === 'skills'
      ? (skills.data?.items ?? []).map((item) => ({
          key: keyOf(item),
          pick: () => onSkill(item),
          row: (
            <>
              <span className="flex-none font-mono font-semibold">${item.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-700">{item.description}</span>
              <KindBadge kind={item.kind} name={item.name} pack={item.pack} />
            </>
          ),
        }))
      : mode === 'commands'
        ? matching(commands, q).map((command) => ({
            key: command.name,
            pick: () => {
              setText('');
              command.run();
            },
            row: (
              <>
                <span className="flex-none font-mono font-semibold">/{command.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-700">{command.description}</span>
              </>
            ),
          }))
        : mode === 'files'
          ? (files.data?.items ?? []).map((item: FileMenuItem) => ({
              key: item.path,
              pick: () => {
                setText(
                  text.replace(FILE, (found) => `${found.startsWith('@') ? '' : found[0]}${mention(item.path)} `),
                );
                focusEnd();
              },
              row: (
                <>
                  <span className="max-w-[55%] flex-none truncate font-mono font-semibold">{item.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-700">{item.dir}</span>
                  {item.repo && (
                    <span className="flex-none rounded-full bg-neutral-200 px-1.5 text-xs text-neutral-700">
                      {item.repo}
                    </span>
                  )}
                </>
              ),
            }))
          : [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: the pick goes back to the first row whenever the text changes
  useEffect(() => setActive(0), [text]);

  const onKey = (event: KeyboardEvent): boolean => {
    if (mode === null || event.isComposing) return false;
    if (event.key === 'Escape') {
      setDismissed(text);
      return true;
    }
    if (entries.length === 0) return false;
    if (event.key === 'ArrowDown') setActive((now) => (now + 1) % entries.length);
    else if (event.key === 'ArrowUp') setActive((now) => (now - 1 + entries.length) % entries.length);
    else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      entries[Math.min(active, entries.length - 1)]?.pick();
    } else return false;
    return true;
  };

  if (mode === null) return { onKey, menu: null };
  const query = mode === 'skills' ? skills : mode === 'files' ? files : null;
  return {
    onKey,
    menu: (
      <div
        role="listbox"
        aria-label={TITLE[mode]}
        className="absolute right-0 bottom-[calc(100%+6px)] left-0 z-20 flex max-h-72 flex-col overflow-y-auto rounded-lg border border-line bg-card p-1.5 shadow-lg"
      >
        <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-neutral-700 uppercase">
          {TITLE[mode]}
        </div>
        {query?.isError ? (
          <p role="alert" className="m-0 px-2.5 py-2 text-xs text-accent-700">
            Could not read {TITLE[mode].toLowerCase()}: {query.error.message}
          </p>
        ) : query && query.data === undefined ? (
          <p className="m-0 px-2.5 py-2 text-xs text-neutral-700">Reading {TITLE[mode].toLowerCase()}…</p>
        ) : entries.length === 0 ? (
          <p className="m-0 px-2.5 py-2 text-xs text-neutral-700">
            {mode === 'skills' && q === '' ? (
              <>
                No skills yet. Install some from <Link to="/skills?tab=discover">Discover</Link>.
              </>
            ) : (
              `No ${TITLE[mode].toLowerCase()} match`
            )}
          </p>
        ) : (
          entries.map((entry, index) => (
            <div
              key={entry.key}
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              // Keeps the focus in the message while a row is clicked.
              onMouseDown={(event) => event.preventDefault()}
              onClick={entry.pick}
              onKeyDown={() => undefined}
              onMouseEnter={() => setActive(index)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] ${index === active ? 'bg-accent-100 text-accent-900' : 'hover:bg-neutral-200'}`}
            >
              {entry.row}
            </div>
          ))
        )}
        <p className="m-0 mt-1 border-t border-line px-2.5 pt-1.5 text-[11px] text-neutral-700">{HINT[mode]}</p>
      </div>
    ),
  };
}

/** Commands whose name starts with the text, then those that hold it, then those whose description does. */
function matching(commands: ComposerCommand[], q: string): ComposerCommand[] {
  const needle = q.trim().toLowerCase();
  if (needle === '') return commands;
  const starts = commands.filter((command) => command.name.startsWith(needle));
  const holds = commands.filter((command) => !command.name.startsWith(needle) && command.name.includes(needle));
  const described = commands.filter(
    (command) => !command.name.includes(needle) && command.description.toLowerCase().includes(needle),
  );
  return [...starts, ...holds, ...described];
}
