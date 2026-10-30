import type { Session } from '@ops-console/shared';
import { Dropdown } from '../components/ui/dropdown';
import { useUpdateSession } from '../lib/queries';
import { ACCESS_MODES, EFFORTS, MODELS } from './options';

/** The Session composer's Model, Effort and Access chips. A change applies from the Session's next run. */
export function SessionChips({ session }: { session: Session }) {
  const update = useUpdateSession(session.id);
  return (
    <div className="flex flex-wrap gap-2">
      <Dropdown
        label="Model"
        value={session.model}
        options={MODELS}
        onChange={(model) => update.mutate({ model })}
        className="w-44"
      />
      <Dropdown
        label="Effort"
        value={session.effort}
        options={EFFORTS}
        onChange={(effort) => update.mutate({ effort })}
        className="w-32"
      />
      <Dropdown
        label="Access"
        value={session.access_mode}
        options={ACCESS_MODES}
        onChange={(access_mode) => update.mutate({ access_mode })}
        className="w-44"
      />
    </div>
  );
}
