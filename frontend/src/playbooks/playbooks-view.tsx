import { PLAYBOOK_TRIGGERS, type Playbook, type PlaybookTrigger, TRIGGER_LABELS } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Empty } from '../components/ui/empty';
import { usePlaybooks, useSetTrigger } from '../lib/queries';
import { useAddress } from '../lib/remember';
import { type Draft, draftOf, useDrafts } from './drafts';
import { builtinFor, holderOf } from './labels';
import { BUILT_IN, Overview } from './overview';
import { PlaybookEditor } from './playbook-editor';

export { NewPlaybookButton } from './new-playbook';

/**
 * The Playbooks page: the overview of Triggers, or one Playbook as a flow. `?playbook=<id>` opens a Playbook,
 * `?trigger=<id>&view=flow` a Trigger's built-in, and `?trigger=<id>` picks the Trigger the overview shows.
 */
export function PlaybooksView() {
  const list = usePlaybooks();
  const [address, setAddress] = useAddress('playbook', 'trigger', 'view');
  const { drafts, edit, drop } = useDrafts();
  const setTrigger = useSetTrigger();
  const [replacing, setReplacing] = useState<{ trigger: PlaybookTrigger; from: Playbook; to: Playbook } | null>(null);

  if (list.isPending) return <Empty>Reading Playbooks…</Empty>;
  if (list.isError) {
    return (
      <Empty>
        <span role="alert">Could not read Playbooks: {list.error.message}</span>
        <Button className="mt-3" onClick={() => void list.refetch()}>
          Retry
        </Button>
      </Empty>
    );
  }
  const { items, blocks } = list.data;
  const selected = PLAYBOOK_TRIGGERS.find((trigger) => trigger === address.trigger) ?? PLAYBOOK_TRIGGERS[0];
  const flowOf = address.view === 'flow' && selected ? builtinFor(items, selected) : undefined;
  const open = items.find((playbook) => playbook.id === address.playbook) ?? flowOf;
  if (!selected) return <Empty>Could not read Playbooks: the daemon sent none.</Empty>;

  const detach = (trigger: PlaybookTrigger) => setTrigger.mutate({ trigger, playbookId: null });
  /** Attaching over another Playbook asks first (Behavior 6). */
  const attach = (trigger: PlaybookTrigger, playbook: Playbook) => {
    const current = holderOf(items, trigger);
    if (current?.id === playbook.id) return;
    if (current) setReplacing({ trigger, from: current, to: playbook });
    else setTrigger.mutate({ trigger, playbookId: playbook.id });
  };
  const back = () => setAddress({ playbook: null, view: null });

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {open ? (
        <PlaybookEditor
          key={open.id}
          playbook={open}
          items={items}
          blocks={blocks}
          working={drafts[open.id] ?? draftOf(open)}
          dirty={drafts[open.id] !== undefined}
          onChange={(next: Draft) => edit(open, next)}
          onDiscard={() => drop(open.id)}
          onSaved={() => drop(open.id)}
          onBack={back}
          onDeleted={() => {
            drop(open.id);
            setAddress({ playbook: null, view: null }, { replace: true });
          }}
          onToggleTrigger={(trigger) => (open.triggers.includes(trigger) ? detach(trigger) : attach(trigger, open))}
        />
      ) : (
        <Overview
          items={items}
          drafts={drafts}
          selected={selected}
          onSelect={(trigger) => setAddress({ trigger }, { replace: true })}
          onOpen={(id) => setAddress({ playbook: id, view: null })}
          onOpenBuiltin={(trigger) => setAddress({ trigger, view: 'flow', playbook: null })}
          onPick={(trigger, id) => {
            if (id === BUILT_IN) return holderOf(items, trigger) ? detach(trigger) : undefined;
            const playbook = items.find((candidate) => candidate.id === id && !candidate.builtin);
            if (playbook) attach(trigger, playbook);
          }}
          error={setTrigger.error?.message ?? null}
        />
      )}
      {replacing && (
        <ConfirmDialog
          title={`Replace ${replacing.from.name}?`}
          action="Replace"
          onConfirm={() => {
            setTrigger.mutate({ trigger: replacing.trigger, playbookId: replacing.to.id });
            setReplacing(null);
          }}
          onCancel={() => setReplacing(null)}
        >
          {TRIGGER_LABELS[replacing.trigger].label} runs {replacing.from.name}. Replace it with {replacing.to.name}?
        </ConfirmDialog>
      )}
    </div>
  );
}
