import { PLAYBOOK_LIMITS, PLAYBOOK_TRIGGERS, type Playbook, TRIGGER_LABELS } from '@ops-console/shared';
import { type ReactNode, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Dropdown } from '../components/ui/dropdown';
import { useCreatePlaybook, usePlaybooks } from '../lib/queries';
import { useAddress } from '../lib/remember';
import { builtinFor, freeName, stepCount } from './labels';

/** In the page header: the New Playbook dialog (Behaviors 10 to 12). */
export function NewPlaybookButton() {
  const list = usePlaybooks();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button disabled={!list.data} onClick={() => setOpen(true)}>
        + New Playbook
      </Button>
      {open && list.data && <NewPlaybookDialog items={list.data.items} onClose={() => setOpen(false)} />}
    </>
  );
}

function NewPlaybookDialog({ items, onClose }: { items: Playbook[]; onClose: () => void }) {
  const create = useCreatePlaybook();
  const [, setAddress] = useAddress('playbook', 'trigger', 'view');
  const name = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => freeName('New Playbook', items));
  const [from, setFrom] = useState<'blank' | 'copy'>('blank');
  const [copyId, setCopyId] = useState(`builtin:${PLAYBOOK_TRIGGERS[0]}`);
  const source = items.find((playbook) => playbook.id === copyId);

  const submit = () => {
    const body =
      from === 'copy' && source
        ? {
            name: text,
            rules: source.rules,
            branches: source.branches,
            jira_ticket: source.jira_ticket,
            steps: source.steps,
          }
        : { name: text, rules: '', branches: '', jira_ticket: false, steps: [] };
    create.mutate(body, {
      onSuccess: (made) => {
        onClose();
        setAddress({ playbook: made.id, view: null });
      },
    });
  };

  const option = (label: string, hint: string, value: 'blank' | 'copy', extra?: ReactNode) => (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 has-checked:border-accent-300 has-checked:bg-accent-100/40">
      <input type="radio" name="from" className="mt-1" checked={from === value} onChange={() => setFrom(value)} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <b className="text-[13px]">{label}</b>
        <span className="text-xs text-neutral-700">{hint}</span>
        {extra}
      </span>
    </label>
  );

  return (
    <ConfirmDialog
      title="New Playbook"
      action="Create"
      pending={create.isPending}
      disabled={text.trim() === ''}
      error={create.error?.message}
      initialFocus={name}
      onConfirm={submit}
      onCancel={onClose}
    >
      <div className="mt-1 flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="new-playbook-name" className="text-xs font-semibold text-neutral-700">
            Name
          </label>
          <input
            id="new-playbook-name"
            ref={name}
            value={text}
            maxLength={PLAYBOOK_LIMITS.name}
            onChange={(event) => setText(event.target.value)}
            className="w-full rounded-md border border-divider bg-card px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-accent-400"
          />
        </div>
        {option('Blank', 'An empty flow. Add steps from the blocks.', 'blank')}
        {option(
          'Copy of a built-in',
          'Starts with its rules and steps. It runs on no Trigger until you attach it.',
          'copy',
          <Dropdown
            label="Built-in to copy"
            value={copyId}
            onChange={(id) => {
              setCopyId(id);
              setFrom('copy');
            }}
            options={PLAYBOOK_TRIGGERS.flatMap((trigger) => {
              const playbook = builtinFor(items, trigger);
              return playbook
                ? [
                    {
                      value: playbook.id,
                      label: `${TRIGGER_LABELS[trigger].label} (built-in)`,
                      description: stepCount(playbook),
                    },
                  ]
                : [];
            })}
            className="mt-1 w-full"
            listClassName="w-72"
          />,
        )}
      </div>
    </ConfirmDialog>
  );
}
