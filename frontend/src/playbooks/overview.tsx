import { JOB_TRIGGERS, type Playbook, type PlaybookTrigger, TRIGGER_LABELS } from '@ops-console/shared';
import type { ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { Dropdown, type DropdownOption } from '../components/ui/dropdown';
import { item } from '../components/ui/item';
import { ascending } from '../lib/sort';
import type { Draft } from './drafts';
import { builtinFor, CLOSING_TURN, holderOf, stepCount, TRIGGER_GROUPS, TRIGGER_TIPS } from './labels';
import { Lock } from './lock';

/** How many steps the small flow shows before "+N more". */
const PREVIEW_STEPS = 5;

/** The Dropdown value for a Trigger running its built-in. */
export const BUILT_IN = '';

/**
 * The page's first screen: each Trigger on the left with the Playbook it runs, and on the right the selected
 * Trigger's Playbook as a small flow.
 */
export function Overview(props: {
  items: Playbook[];
  drafts: Record<string, Draft>;
  selected: PlaybookTrigger;
  onSelect: (trigger: PlaybookTrigger) => void;
  onOpen: (id: string) => void;
  onOpenBuiltin: (trigger: PlaybookTrigger) => void;
  onPick: (trigger: PlaybookTrigger, id: string) => void;
  error: string | null;
}) {
  const { items, drafts, selected } = props;
  const own = ascending(
    items.filter((playbook) => !playbook.builtin),
    (playbook) => playbook.name,
  );
  const builtin = builtinFor(items, selected);
  const holder = holderOf(items, selected);
  const running = holder ?? builtin;
  const label = TRIGGER_LABELS[selected].label;
  const chat = !JOB_TRIGGERS.includes(selected);
  const closing = CLOSING_TURN[selected];
  const options: DropdownOption<string>[] = [
    { value: BUILT_IN, label: 'Built-in', description: builtin ? stepCount(builtin) : undefined },
    ...own.map((playbook) => ({ value: playbook.id, label: playbook.name, description: stepCount(playbook) })),
  ];
  const skills = running?.skills ?? [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside
        aria-label="Triggers"
        className="flex w-80 flex-none flex-col gap-1 overflow-y-auto border-r border-line px-3 py-4"
      >
        {TRIGGER_GROUPS.map((group) => (
          <section key={group.tab} aria-label={group.tab} className="flex flex-col gap-0.5">
            <div className="mt-2 mb-1 px-2 text-xs font-semibold tracking-[0.08em] text-neutral-600 uppercase first:mt-0">
              {group.tab}
            </div>
            {group.triggers.map((trigger) => {
              const held = holderOf(items, trigger);
              return (
                <button
                  key={trigger}
                  type="button"
                  aria-current={trigger === selected ? 'true' : undefined}
                  title={TRIGGER_TIPS[trigger]}
                  onClick={() => props.onSelect(trigger)}
                  className={`flex items-center gap-2.5 px-3 py-2.5 text-[13px] ${item(trigger === selected)}`}
                >
                  <span className={`size-2 flex-none rounded-full ${held ? 'bg-accent' : 'bg-neutral-400'}`} />
                  <b className="min-w-0 flex-1 truncate">{TRIGGER_LABELS[trigger].label}</b>
                  {held && drafts[held.id] && (
                    <span
                      role="img"
                      aria-label="Unsaved edits"
                      title="Unsaved edits"
                      className="size-1.75 flex-none rounded-full bg-accent"
                    />
                  )}
                  <span
                    className={`max-w-32 truncate text-xs ${held ? 'font-semibold text-accent-700' : 'text-neutral-700'}`}
                  >
                    {held ? held.name : 'Built-in'}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
        {own.length > 0 && (
          <section aria-label="Your Playbooks" className="mt-5 flex flex-col gap-1">
            <div className="mb-1 px-2 text-xs font-semibold tracking-[0.08em] text-neutral-600 uppercase">
              Your Playbooks
            </div>
            {own.map((playbook) => (
              <button
                key={playbook.id}
                type="button"
                onClick={() => props.onOpen(playbook.id)}
                className="flex cursor-pointer flex-col gap-1 rounded-lg border border-line bg-card px-3 py-2 text-left hover:border-accent-300"
              >
                <span className="flex items-center gap-2">
                  <b className="min-w-0 flex-1 truncate text-[13px]">{playbook.name}</b>
                  {drafts[playbook.id] && (
                    <span className="rounded-full bg-accent-100 px-2 py-px text-[11px] font-semibold text-accent-700">
                      unsaved
                    </span>
                  )}
                </span>
                <span className="flex flex-wrap gap-1">
                  {playbook.triggers.length === 0 ? (
                    <span className="rounded-full bg-neutral-200 px-2 py-px text-[11px]">on no Trigger</span>
                  ) : (
                    playbook.triggers.map((trigger) => (
                      <span
                        key={trigger}
                        className="rounded-full bg-accent-100 px-2 py-px text-[11px] font-semibold text-accent-700"
                      >
                        {TRIGGER_LABELS[trigger].label}
                      </span>
                    ))
                  )}
                </span>
              </button>
            ))}
          </section>
        )}
      </aside>

      <section aria-label={label} className="min-w-0 flex-1 overflow-y-auto">
        {running && (
          <div className="flex w-full flex-col gap-6 px-10 py-7">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="m-0 font-heading text-xl">{label}</h2>
                <p className="m-0 mt-1 text-[13px] text-neutral-700">{TRIGGER_TIPS[selected]}</p>
              </div>
              <span className="rounded-full bg-neutral-200 px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.04em]">
                {chat ? 'CHAT' : 'JOB'}
              </span>
            </div>

            <div
              className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${holder ? 'border-accent-300 bg-accent-100/40' : 'border-line bg-card'}`}
            >
              <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-neutral-200 text-neutral-700">
                {holder ? '✎' : <Lock />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs text-neutral-700">{label} runs</div>
                <div className="flex items-center gap-2">
                  <b className="truncate text-[15px]">{running.name}</b>
                  <span
                    className={`rounded-full px-2 py-px text-[10px] font-semibold tracking-[0.04em] uppercase ${holder ? 'bg-accent text-white' : 'bg-neutral-200'}`}
                  >
                    {holder ? 'Yours' : 'Built-in · read only'}
                  </span>
                </div>
                <div className="text-xs text-neutral-700">{stepCount(running)}</div>
              </div>
              {holder && <Button onClick={() => props.onOpen(holder.id)}>Edit</Button>}
              <Dropdown
                label={`Playbook for ${label}`}
                value={holder?.id ?? BUILT_IN}
                options={options}
                onChange={(id) => props.onPick(selected, id)}
                className="w-44 flex-none"
                listClassName="w-72"
                heading={`${label} runs`}
              />
            </div>
            {props.error && (
              <p role="alert" className="m-0 text-xs text-accent-700">
                {props.error}
              </p>
            )}

            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="text-xs font-semibold tracking-[0.08em] text-neutral-600 uppercase">
                  What the agent does
                </div>
                <span className="flex-1" />
                <Button onClick={() => (holder ? props.onOpen(holder.id) : props.onOpenBuiltin(selected))}>
                  {holder ? 'Edit flow' : 'View full flow'} →
                </Button>
              </div>
              <ol
                aria-label="Flow"
                className="m-0 flex list-none flex-wrap items-stretch gap-2 rounded-xl border border-line bg-[radial-gradient(circle,var(--color-neutral-400)_1px,transparent_1px)] bg-size-[18px_18px] p-4"
              >
                <li className="flex items-center gap-2">
                  <span className="rounded-lg border border-accent-300 bg-accent-100 px-3 py-2 text-xs font-semibold">
                    {label}
                  </span>
                  {(running.steps.length > 0 || closing) && (
                    <span aria-hidden className="text-neutral-500">
                      →
                    </span>
                  )}
                </li>
                {running.steps.slice(0, PREVIEW_STEPS).map((step, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list
                  <li key={index} className="flex items-center gap-2">
                    <span className="max-w-60 truncate rounded-lg border border-line bg-card px-3 py-2 text-xs">
                      <b className="mr-1.5 text-neutral-600">{index + 1}</b>
                      {step.title}
                    </span>
                    {(index < Math.min(running.steps.length, PREVIEW_STEPS) - 1 ||
                      running.steps.length > PREVIEW_STEPS ||
                      closing) && (
                      <span aria-hidden className="text-neutral-500">
                        →
                      </span>
                    )}
                  </li>
                ))}
                {running.steps.length > PREVIEW_STEPS && (
                  <li className="flex items-center gap-2">
                    <span className="rounded-lg border border-line bg-card px-3 py-2 text-xs">
                      +{running.steps.length - PREVIEW_STEPS} more
                    </span>
                    {closing && (
                      <span aria-hidden className="text-neutral-500">
                        →
                      </span>
                    )}
                  </li>
                )}
                {closing && (
                  <li className="flex items-center">
                    <span className="rounded-lg border border-dashed border-divider px-3 py-2 text-xs text-neutral-700">
                      Console's own turn: {closing}
                    </span>
                  </li>
                )}
              </ol>
              {running.steps.length === 0 && (
                <p className="m-0 text-xs text-neutral-700">
                  {chat
                    ? 'Steps never run on a chat: the agent answers with the rules alone.'
                    : 'No steps: the agent works from the rules alone.'}
                </p>
              )}
            </div>

            <dl className="m-0 grid grid-cols-3 gap-3">
              <Fact title="Rules">
                {running.rules ? <span className="line-clamp-4">{running.rules}</span> : 'None'}
              </Fact>
              <Fact title="Skills">
                {skills.length > 0
                  ? ascending(skills, (skill) => skill.name)
                      .map((skill) => skill.name)
                      .join(', ')
                  : 'None'}
              </Fact>
              <Fact title="Branch · Jira">
                {running.branches || "The Repo's default branch"} · Jira ticket {running.jira_ticket ? 'on' : 'off'}
              </Fact>
            </dl>

            {!holder && (
              <p className="m-0 flex items-start gap-2.5 rounded-lg bg-neutral-200 px-3.5 py-2.5 text-[13px]">
                <span className="flex size-5.5 flex-none items-center justify-center rounded-full bg-card text-[11px] font-semibold">
                  i
                </span>
                <span>
                  The built-in is read only and the console keeps it up to date. To use your own rules and steps, press{' '}
                  <b>+ New Playbook</b> (blank, or a copy of this built-in), then pick it in the dropdown above.
                </span>
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Fact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-card px-3 py-2.5">
      <dt className="text-[10px] font-semibold tracking-[0.08em] text-neutral-600 uppercase">{title}</dt>
      <dd className="m-0 text-xs break-words text-neutral-800">{children}</dd>
    </div>
  );
}
