import { AccessMode, type Session } from '@ops-console/shared';
import { type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from 'react';
import { ACCESS_MODES, EFFORTS, MODELS } from '../agents/options';
import { BRANDS } from '../components/ui/brands';
import { LockIcon, PencilIcon, ShieldOffIcon, SparkleIcon } from '../components/ui/icons';
import { item } from '../components/ui/item';
import { useAgentSettings, useUpdateSession } from '../lib/queries';

/** Access modes in order of trust: what each one's button shows. */
const MODE_ICON: Record<AccessMode, () => ReactElement> = {
  [AccessMode.Supervised]: LockIcon,
  [AccessMode.AcceptEdits]: PencilIcon,
  [AccessMode.Auto]: SparkleIcon,
  [AccessMode.Full]: ShieldOffIcon,
};

/** A model's name without its maker: `Sonnet 5.5`. */
const short = (label: string) => label.replace(/^Claude /, '');

function ClaudeMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill={BRANDS.claude.hex} aria-hidden className="flex-none">
      <path d={BRANDS.claude.path} />
    </svg>
  );
}

/** Arrow keys move the focus between a group's buttons; the first one's Up goes to `before`. */
function walk(event: KeyboardEvent<HTMLElement>, group: HTMLElement | null, before?: HTMLElement | null) {
  const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
  if (!keys.includes(event.key) || !group) return;
  const buttons = [...group.querySelectorAll<HTMLElement>('button')];
  const at = buttons.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
  if (event.key === 'ArrowUp' && at === 0 && before) return before.focus();
  const to =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (at + (forward ? 1 : -1) + buttons.length) % buttons.length;
  buttons[to]?.focus();
}

const DefaultTag = () => (
  <span className="rounded-full bg-neutral-200 px-1.5 text-xs whitespace-nowrap text-neutral-700">default</span>
);

/**
 * The composer's one settings pill, `Sonnet 5.5 High`, and the popover it opens: a search over the models, the effort
 * as Reasoning, and the Access mode behind a footer chip. A change applies from the Session's next run. The popover
 * sits over the composer box, the nearest positioned ancestor, so it never runs wider than the Session column.
 */
export function ComposerSettings({ session }: { session: Session }) {
  const update = useUpdateSession(session.id);
  const defaults = useAgentSettings().data?.data.session_defaults;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [accessOpen, setAccessOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const models = useRef<HTMLDivElement>(null);
  const reasoning = useRef<HTMLDivElement>(null);
  const modes = useRef<HTMLDivElement>(null);

  const model = MODELS.find((one) => one.value === session.model);
  const effort = EFFORTS.find((one) => one.value === session.effort);
  const mode = ACCESS_MODES.find((one) => one.value === session.access_mode);
  const needle = query.trim().toLowerCase();
  const matching = needle ? MODELS.filter((one) => one.label.toLowerCase().includes(needle)) : MODELS;
  const ModeIcon = MODE_ICON[session.access_mode];

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const pickModel = (value: (typeof MODELS)[number]['value']) => {
    if (value !== session.model) update.mutate({ model: value });
  };
  // Typing from anywhere in the list goes to the search box.
  const typeToSearch = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey)
      search.current?.focus();
  };

  return (
    <>
      {open && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="fixed inset-0 z-50 cursor-default"
          onClick={() => setOpen(false)}
        />
      )}
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Model, effort and access"
        title={`${model?.label ?? session.model}, ${effort?.label ?? session.effort} effort. Access: ${mode?.label ?? session.access_mode}. A change applies from the Session's next run.`}
        onClick={() => {
          setQuery('');
          setOpen((now) => !now);
        }}
        className={`flex h-9 max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm text-text transition-colors hover:bg-neutral-200 ${
          open ? 'border-divider bg-neutral-200' : 'border-transparent bg-transparent'
        }`}
      >
        <ClaudeMark />
        <span className="min-w-0 truncate">
          {model ? short(model.label) : session.model} {effort?.label ?? session.effort}
        </span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Model, effort and access"
          className="absolute right-0 bottom-[calc(100%+6px)] z-51 flex max-h-[min(30rem,70vh)] w-[min(34rem,100%)] max-w-[calc(100vw-1rem)] min-w-72 flex-col overflow-hidden rounded-xl border border-line bg-card shadow-lg"
        >
          <div className="flex min-h-0 flex-1 flex-wrap content-start overflow-y-auto">
            <div className="flex min-w-0 flex-[2_1_13rem] flex-col gap-1 p-2">
              <input
                ref={search}
                type="search"
                aria-label="Search models"
                placeholder="Search models..."
                value={query}
                // biome-ignore lint/a11y/noAutofocus: the popover opens to be searched
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    models.current?.querySelector<HTMLElement>('button')?.focus();
                  } else if (event.key === 'Enter' && matching[0]) {
                    event.preventDefault();
                    pickModel(matching[0].value);
                  }
                }}
                className="block w-full rounded-md border border-divider bg-bg px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-accent-400"
              />
              <div
                ref={models}
                role="listbox"
                aria-label="Model"
                tabIndex={-1}
                onKeyDown={(event) => {
                  walk(event, models.current, search.current);
                  typeToSearch(event);
                }}
                className="flex flex-col gap-0.5"
              >
                {matching.length === 0 && <p className="m-0 px-2.5 py-2 text-xs text-neutral-700">No match</p>}
                {matching.map((one) => {
                  const selected = one.value === session.model;
                  return (
                    <button
                      key={one.value}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      title={one.description}
                      onClick={() => pickModel(one.value)}
                      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] outline-none focus-visible:bg-neutral-200 ${item(selected)} ${selected ? 'focus-visible:bg-accent-200' : ''}`}
                    >
                      <ClaudeMark />
                      <span className={`min-w-0 flex-1 truncate ${selected ? 'font-semibold' : ''}`}>
                        {short(one.label)}
                      </span>
                      {one.value === defaults?.model && <DefaultTag />}
                      <span aria-hidden className={`w-3 flex-none text-xs ${selected ? 'text-accent' : 'invisible'}`}>
                        ✓
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex min-w-0 flex-[1_1_11rem] flex-col gap-1 p-2">
              <div className="flex items-baseline justify-between gap-2 px-2.5 py-1.5 text-[13px]">
                <span className="font-semibold text-neutral-700">Reasoning</span>
                <span className="min-w-0 truncate text-xs text-neutral-700">{model ? short(model.label) : ''}</span>
              </div>
              <div
                ref={reasoning}
                role="radiogroup"
                aria-label="Reasoning"
                onKeyDown={(event) => walk(event, reasoning.current)}
                className="flex flex-col gap-0.5"
              >
                {EFFORTS.map((one) => {
                  const selected = one.value === session.effort;
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: the radio is a styled button, as the segmented rows are
                    <button
                      key={one.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      title={one.description}
                      onClick={() => {
                        if (!selected) update.mutate({ effort: one.value });
                      }}
                      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] outline-none focus-visible:bg-neutral-200 ${item(selected)} ${selected ? 'font-semibold focus-visible:bg-accent-200' : ''}`}
                    >
                      <span className="min-w-0 flex-1 truncate">{one.label}</span>
                      {one.value === defaults?.effort && <DefaultTag />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex flex-none flex-col gap-2 border-t border-line p-2">
            {accessOpen && (
              <div id={`access-${session.id}`} className="flex flex-col gap-1.5 px-1 pt-0.5 pb-1">
                <div className="text-xs font-semibold text-neutral-700">Access</div>
                <div
                  ref={modes}
                  role="radiogroup"
                  aria-label="Access"
                  onKeyDown={(event) => walk(event, modes.current)}
                  className="grid grid-cols-4 gap-0.5 rounded-lg bg-neutral-200 p-0.5"
                >
                  {ACCESS_MODES.map((one) => {
                    const Icon = MODE_ICON[one.value];
                    const selected = one.value === session.access_mode;
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: the radio is a styled button, as the segmented rows are
                      <button
                        key={one.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={one.label}
                        title={one.label}
                        onClick={() => {
                          if (!selected) update.mutate({ access_mode: one.value });
                        }}
                        className={`flex cursor-pointer items-center justify-center rounded-md border-0 py-1.5 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                          selected ? 'bg-card text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'
                        }`}
                      >
                        <Icon />
                      </button>
                    );
                  })}
                </div>
                <div className="text-[13px] font-semibold text-text">{mode?.label}</div>
                <p className="m-0 text-xs text-neutral-700">{mode?.description}</p>
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                aria-expanded={accessOpen}
                aria-controls={`access-${session.id}`}
                title="Access mode: what the agent may do without asking you. A PROD write asks in every mode; Full asks about nothing else."
                onClick={() => setAccessOpen((now) => !now)}
                className="flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-neutral-200 px-2.5 py-1.5 text-xs text-text transition-colors hover:bg-neutral-300"
              >
                <ModeIcon />
                <span className="sr-only">Access: </span>
                <span className="min-w-0 truncate">{mode?.label}</span>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  aria-hidden
                  className={`flex-none text-neutral-600 transition-transform ${accessOpen ? '' : 'rotate-180'}`}
                >
                  <path
                    d="M2 3.5 5 6.5 8 3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
