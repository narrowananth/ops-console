import {
  PLAYBOOK_LIMITS,
  type Playbook,
  type PlaybookTrigger,
  PR_DESCRIPTION_RULE,
  SKILL_LIMITS,
  StepBlock,
  TRIGGER_LABELS,
} from '@ops-console/shared';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Toggle } from '../components/ui/toggle';
import { useSkills } from '../lib/queries';
import { ascending } from '../lib/sort';
import { KindBadge } from '../skills/kind-badge';
import type { Draft, DraftStep } from './drafts';
import type { Sel } from './flow-canvas';
import { SCRATCH_TIP, ScratchTag } from './job-steps';
import { holderOf, TRIGGER_GROUPS, TRIGGER_TIPS, triggerOfBuiltin } from './labels';
import { RulesMeter, SkillsMeter } from './token-meter';

const field =
  'w-full rounded-md border border-divider bg-card px-2.5 py-1.5 text-text outline-none focus:border-accent-400 read-only:bg-transparent';
const small = 'px-2.5 py-1 text-xs';

function Head({
  title,
  meta,
  onClose,
  children,
}: {
  title: string;
  meta?: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="m-0 font-heading text-base">{title}</h2>
      {children}
      {meta && <span className="ml-auto font-mono text-xs text-neutral-700">{meta}</span>}
      <Button
        icon
        aria-label="Close"
        title="Close"
        className={`size-7.5! text-base ${meta ? '' : 'ml-auto'}`}
        onClick={onClose}
      >
        ×
      </Button>
    </div>
  );
}

const PANEL_LABEL: Record<Sel['kind'], string> = {
  trigger: 'Trigger panel',
  step: 'Step panel',
  rules: 'Rules panel',
  skills: 'Skills panel',
  settings: 'Settings panel',
};

const Note = ({ children }: { children: ReactNode }) => <p className="m-0 text-xs text-neutral-700">{children}</p>;

/** The panel for the node picked on the canvas. Everything reads only on a built-in. */
export function Inspector(props: {
  sel: Sel;
  playbook: Playbook;
  items: Playbook[];
  working: Draft;
  readOnly: boolean;
  onChange: (next: Draft) => void;
  onClose: () => void;
  onToggleTrigger: (trigger: PlaybookTrigger) => void;
}) {
  const { sel, working, readOnly, onChange, onClose } = props;
  return (
    <aside
      aria-label={PANEL_LABEL[sel.kind]}
      onKeyDown={(event) => event.key === 'Escape' && onClose()}
      className="flex w-84 flex-none flex-col gap-3 overflow-y-auto border-l border-line bg-card px-4 py-4"
    >
      {sel.kind === 'trigger' && <TriggerPanel {...props} />}
      {sel.kind === 'step' && working.steps[sel.index] && (
        <StepPanel
          index={sel.index}
          step={working.steps[sel.index] as DraftStep}
          readOnly={readOnly}
          onClose={onClose}
          onChange={(patch) =>
            onChange({
              ...working,
              steps: working.steps.map((step, at) => (at === sel.index ? { ...step, ...patch } : step)),
            })
          }
          onRemove={() => {
            onChange({ ...working, steps: working.steps.filter((_, at) => at !== sel.index) });
            onClose();
          }}
        />
      )}
      {sel.kind === 'rules' && (
        <>
          <Head
            title="Rules"
            meta={readOnly ? undefined : `${working.rules.length} / ${PLAYBOOK_LIMITS.rules}`}
            onClose={onClose}
          />
          {readOnly ? (
            <div className="whitespace-pre-wrap rounded-lg bg-neutral-200 px-3 py-2 text-[13px]">
              {working.rules || 'No rules.'}
            </div>
          ) : (
            <Note>What the agent must always or never do. Sent every turn, after the console's own instructions.</Note>
          )}
          <RulesMeter characters={working.rules.length} warn={!readOnly} />
          {!readOnly && (
            <textarea
              aria-label="Rules"
              value={working.rules}
              maxLength={PLAYBOOK_LIMITS.rules}
              rows={14}
              placeholder="Example: Run pnpm test:unit, never the whole suite. Say which file:line each claim comes from."
              onChange={(event) => onChange({ ...working, rules: event.target.value })}
              className={`${field} field-sizing-content max-h-[50vh] min-h-40 resize-y overflow-y-auto text-[13px] leading-relaxed`}
            />
          )}
          <details className="text-xs text-neutral-700">
            <summary className="cursor-pointer">
              Every run also gets the console's pull request description rule
            </summary>
            <p className="m-0 mt-1.5 whitespace-pre-wrap rounded-lg bg-neutral-200 px-3 py-2">{PR_DESCRIPTION_RULE}</p>
          </details>
        </>
      )}
      {sel.kind === 'skills' && <SkillsPanel {...props} />}
      {sel.kind === 'settings' && (
        <>
          <Head title="Settings" onClose={onClose} />
          {readOnly ? (
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
              <dt className="text-neutral-700">Branch</dt>
              <dd className="m-0">{working.branches || "The Repo's default branch"}</dd>
              <dt className="text-neutral-700">Jira ticket</dt>
              <dd className="m-0">{working.jira_ticket ? 'On' : 'Off'}</dd>
            </dl>
          ) : (
            <>
              <label htmlFor="playbook-branch" className="text-xs font-semibold text-neutral-700">
                Branch
              </label>
              <input
                id="playbook-branch"
                value={working.branches}
                maxLength={PLAYBOOK_LIMITS.branches}
                placeholder="production, master, main"
                onChange={(event) => onChange({ ...working, branches: event.target.value })}
                className={`${field} font-mono text-[13px]`}
              />
              <Note>
                Where Verify and Fix read the code: the first of these origin has, fetched first. Blank: the Repo's
                default branch.
              </Note>
              <div className="flex items-start gap-3">
                <Toggle
                  label="Jira ticket"
                  checked={working.jira_ticket}
                  onChange={(checked) => onChange({ ...working, jira_ticket: checked })}
                />
                <div className="flex flex-col gap-0.5">
                  <b className="text-[13px]">Jira ticket</b>
                  <Note>
                    Fix makes a Jira ticket first, when Jira is connected, and names the branch after it. Off: the
                    branch is fix/&lt;name&gt;.
                  </Note>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}

function TriggerPanel({
  playbook,
  items,
  readOnly,
  onClose,
  onToggleTrigger,
}: {
  playbook: Playbook;
  items: Playbook[];
  readOnly: boolean;
  onClose: () => void;
  onToggleTrigger: (trigger: PlaybookTrigger) => void;
}) {
  const builtinTrigger = triggerOfBuiltin(playbook);
  return (
    <>
      <Head title="Triggers" onClose={onClose} />
      <Note>
        {readOnly
          ? 'This built-in runs on its Trigger until you attach a Playbook of yours there.'
          : 'Pick the Triggers that start this Playbook. A Trigger runs one Playbook; one you leave off keeps its built-in.'}
      </Note>
      {TRIGGER_GROUPS.map((group) => {
        const list = readOnly ? group.triggers.filter((trigger) => trigger === builtinTrigger) : group.triggers;
        if (list.length === 0) return null;
        return (
          <div key={group.tab} className="flex flex-col gap-1.5">
            <div className="text-xs font-semibold text-neutral-700">{group.tab}</div>
            <div className="flex flex-wrap gap-1.5">
              {list.map((trigger) => {
                const label = TRIGGER_LABELS[trigger].label;
                const mine = playbook.triggers.includes(trigger);
                const other = holderOf(items, trigger);
                const taken = !mine && other !== undefined && other.id !== playbook.id;
                if (readOnly) {
                  return (
                    <span
                      key={trigger}
                      title={mine ? undefined : `Replaced by ${other?.name}`}
                      className={`rounded-full border px-2.5 py-1 text-xs ${mine ? 'border-accent bg-accent text-white' : 'border-divider text-neutral-700'}`}
                    >
                      {label}
                      {!mine && <small className="ml-1.5 text-neutral-600">replaced</small>}
                    </span>
                  );
                }
                return (
                  <button
                    key={trigger}
                    type="button"
                    aria-pressed={mine}
                    title={
                      mine
                        ? `Click to detach. ${label} runs its built-in again`
                        : taken
                          ? `Runs ${other?.name}. Click to replace`
                          : TRIGGER_TIPS[trigger]
                    }
                    onClick={() => onToggleTrigger(trigger)}
                    className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs ${
                      mine ? 'border-accent bg-accent text-white' : 'border-divider bg-card hover:border-accent-300'
                    }`}
                  >
                    {mine ? '✓ ' : ''}
                    {label}
                    {taken && <small className="ml-1.5 text-neutral-600">{other?.name}</small>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

function StepPanel(props: {
  index: number;
  step: DraftStep;
  readOnly: boolean;
  onClose: () => void;
  onChange: (patch: Partial<DraftStep>) => void;
  onRemove: () => void;
}) {
  const { step, readOnly } = props;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="flex size-5.5 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold">
          {props.index + 1}
        </span>
        <h2 className="m-0 font-heading text-base">Step</h2>
        {step.writes && <ScratchTag />}
        <Button icon aria-label="Close" title="Close" className="ml-auto size-7.5! text-base" onClick={props.onClose}>
          ×
        </Button>
      </div>
      <label htmlFor="step-title" className="text-xs font-semibold text-neutral-700">
        Title
      </label>
      <input
        id="step-title"
        aria-label="Step title"
        value={step.title}
        readOnly={readOnly}
        maxLength={PLAYBOOK_LIMITS.title}
        onChange={(event) => props.onChange({ title: event.target.value })}
        className={`${field} text-[13px] font-semibold`}
      />
      <label htmlFor="step-instructions" className="text-xs font-semibold text-neutral-700">
        Instructions
      </label>
      <textarea
        id="step-instructions"
        aria-label="Step instructions"
        value={step.instructions}
        readOnly={readOnly}
        rows={11}
        maxLength={PLAYBOOK_LIMITS.instructions}
        placeholder="Write what the agent does in this step."
        onChange={(event) => props.onChange({ instructions: event.target.value })}
        className={`${field} field-sizing-content max-h-[50vh] min-h-40 resize-y overflow-y-auto text-xs leading-relaxed`}
      />
      {!readOnly && step.block === StepBlock.Custom && (
        <label title={SCRATCH_TIP} className="flex items-center gap-2 text-xs text-neutral-700">
          <input
            type="checkbox"
            checked={step.writes}
            onChange={(event) => props.onChange({ writes: event.target.checked })}
          />
          scratch copy: writes files or runs commands
        </label>
      )}
      <Note>Runs as its own agent turn. Ends done, skipped or failed.</Note>
      {!readOnly && (
        <div className="flex">
          <Button
            className={`${small} ml-auto text-accent-700`}
            title="Remove this step from the Playbook. Save to keep the change."
            onClick={props.onRemove}
          >
            Remove
          </Button>
        </div>
      )}
    </>
  );
}

function SkillsPanel({
  playbook,
  working,
  readOnly,
  onChange,
  onClose,
}: {
  playbook: Playbook;
  working: Draft;
  readOnly: boolean;
  onChange: (next: Draft) => void;
  onClose: () => void;
}) {
  const skills = useSkills();
  const [listing, setListing] = useState(false);
  const ids = working.skill_ids;
  const known = [...(skills.data?.items ?? []), ...playbook.skills];
  const held = ascending(
    ids.map((id) => ({ id, ...known.find((skill) => skill.id === id) })),
    (skill) => skill.name ?? '',
  );
  const free = ascending(
    (skills.data?.items ?? []).filter((skill) => !ids.includes(skill.id)),
    (skill) => skill.name,
  );
  const full = ids.length >= SKILL_LIMITS.perPlaybook;
  const characters = held.reduce((sum, skill) => sum + (skill.name?.length ?? 0) + (skill.description?.length ?? 0), 0);

  if (readOnly) {
    return (
      <>
        <Head title="Skills" onClose={onClose} />
        <Note>A built-in Playbook holds no Skills.</Note>
      </>
    );
  }
  return (
    <>
      <Head title="Skills" meta={`${ids.length} / ${SKILL_LIMITS.perPlaybook}`} onClose={onClose} />
      <div className="flex flex-col gap-1.5 rounded-lg bg-neutral-200 px-3 py-2.5 text-[12.5px] text-neutral-800">
        <span>
          <b>What is a Skill?</b> A method you write once, such as "how to debug a failing route". The agent sees only
          its name and description, and loads the full text when a step needs it.
        </span>
        <Link to="/skills" className="text-[13px] font-semibold">
          Open the Skills page →
        </Link>
      </div>
      {held.length > 0 && <SkillsMeter characters={characters} />}
      {held.length === 0 ? (
        <Note>None held. The agent follows the rules and steps only.</Note>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {held.map((skill) => (
            <li
              key={skill.id}
              aria-label={skill.name ?? 'A deleted Skill'}
              className="flex items-start gap-2 rounded-lg border border-line bg-card px-3 py-2 shadow-sm"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {skill.name === undefined ? (
                  <span className="text-[13px] font-semibold text-neutral-700">A deleted Skill</span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Link
                      to={`/skills?skill=${encodeURIComponent(skill.id)}`}
                      title="Open this Skill on the Skills page"
                      className="font-mono text-[13px] font-semibold"
                    >
                      {skill.name}
                    </Link>
                    {skill.kind && <KindBadge kind={skill.kind} name={skill.name} />}
                  </span>
                )}
                <span className="text-xs text-neutral-700">{skill.description}</span>
              </div>
              <Button
                icon
                aria-label={`Remove ${skill.name ?? 'the deleted Skill'}`}
                title="Take this Skill off the Playbook. Save to keep the change. The Skill is not deleted."
                className="size-7.5! text-base"
                onClick={() => onChange({ ...working, skill_ids: ids.filter((id) => id !== skill.id) })}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}
      {skills.data && skills.data.items.length === 0 ? (
        <Note>No Skills exist yet. Write one on the Skills page, or install a Skill pack under Discover.</Note>
      ) : free.length === 0 ? (
        skills.data && <Note>Every Skill is held already.</Note>
      ) : (
        <>
          <Button
            className={`${small} self-start`}
            disabled={full}
            title={full ? `A Playbook holds ${SKILL_LIMITS.perPlaybook} Skills at most. Remove one first.` : undefined}
            aria-expanded={listing}
            onClick={() => setListing(!listing)}
          >
            {listing ? 'Hide list' : '+ Add a Skill'}
          </Button>
          {listing &&
            free.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => {
                  onChange({ ...working, skill_ids: [...ids, skill.id] });
                  setListing(false);
                }}
                className="flex cursor-pointer flex-col gap-0.5 rounded-lg border border-line bg-card px-3 py-2 text-left hover:border-accent-300"
              >
                <span className="flex items-center gap-1.5">
                  <b className="font-mono text-[13px]">{skill.name}</b>
                  <KindBadge kind={skill.kind} name={skill.name} />
                </span>
                <span className="text-xs text-neutral-700">{skill.description}</span>
              </button>
            ))}
        </>
      )}
      {skills.isError && (
        <p role="alert" className="m-0 text-xs text-accent-700">
          Could not read Skills: {skills.error.message}
        </p>
      )}
    </>
  );
}
