import { type Connector, ConnectorId } from '@ops-console/shared';
import { Dropdown } from '../components/ui/dropdown';
import { usePickables } from '../lib/queries';
import { ascending } from '../lib/sort';
import { ChoiceCard } from './sign-in-step';

type PickId = ConnectorId.LokiLogs | ConnectorId.NewRelicLogs;

/** What a signed-in Connector asks the operator to pick. */
const KINDS: Record<PickId, { noun: string; prompt: string; ask: string }> = {
  [ConnectorId.LokiLogs]: {
    noun: 'Loki data source',
    prompt: 'Choose a data source…',
    ask: 'Choose a Loki data source',
  },
  [ConnectorId.NewRelicLogs]: {
    noun: 'New Relic account',
    prompt: 'Choose an account…',
    ask: 'Choose a New Relic account',
  },
};

/** The kind of pick each Connector asks for, as the daemon names it. */
const PICK_KIND: Record<PickId, NonNullable<Connector['pick']>> = {
  [ConnectorId.LokiLogs]: 'data_source',
  [ConnectorId.NewRelicLogs]: 'account',
};

/** Whether the sign-in finished and waits for the operator to pick a data source or an account. */
export function asksPick(connector: Connector, id: PickId): boolean {
  return connector.id === id && connector.sign_in === null && connector.pick === PICK_KIND[id];
}

/** The signed-in Connector's own list, as a picker under the sign-in step; picking one finishes Connect. */
export function PickStep({ id, pending, onPick }: { id: PickId; pending: boolean; onPick: (pick: string) => void }) {
  const { noun, prompt, ask } = KINDS[id];
  const found = usePickables(id);
  const options = [
    { value: '', label: prompt },
    ...ascending(found.data ?? [], (pick) => pick.name).map((pick) => ({ value: pick.id, label: pick.name })),
  ];
  return (
    <ChoiceCard label={ask}>
      <div className="flex flex-col gap-1 text-xs">
        <span className="font-semibold">{noun}</span>
        {found.isPending && (
          <p role="status" className="m-0 text-neutral-700">
            Reading the list…
          </p>
        )}
        {found.isError && (
          <p role="alert" className="m-0 text-accent-700">
            {found.error.message}
          </p>
        )}
        {found.isSuccess && found.data.length === 0 && <p className="m-0 text-neutral-700">Nothing to choose from.</p>}
        {found.isSuccess && found.data.length > 0 && (
          <Dropdown
            label={noun}
            value=""
            options={options}
            disabled={pending}
            onChange={(pick) => {
              if (pick !== '') onPick(pick);
            }}
          />
        )}
      </div>
    </ChoiceCard>
  );
}
