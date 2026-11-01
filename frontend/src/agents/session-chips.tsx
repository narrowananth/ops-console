import type { Session, SessionDefaults } from '@ops-console/shared';
import { Dropdown } from '../components/ui/dropdown';
import { useAgentSettings, useUpdateSession } from '../lib/queries';
import { ACCESS_MODES, EFFORTS, MODELS } from './options';

type ChipsLook = { variant?: 'field' | 'chip'; opens?: 'up' | 'down' };

/** The Session composer's Model, Effort and Access chips. A change applies from the Session's next run. */
export function SessionChips({ session, ...look }: { session: Session } & ChipsLook) {
  const update = useUpdateSession(session.id);
  return <SettingsChips settings={session} onChange={(patch) => update.mutate(patch)} {...look} />;
}

/** The same chips over settings no Session holds yet, such as a terminal before its first question. */
export function SettingsChips({
  settings,
  onChange,
  variant = 'field',
  opens,
}: {
  settings: SessionDefaults;
  onChange: (patch: Partial<SessionDefaults>) => void;
} & ChipsLook) {
  const defaults = useAgentSettings().data?.data.session_defaults;
  const chip = variant === 'chip';
  return (
    <div className={chip ? 'contents' : 'flex flex-wrap gap-2'}>
      <Dropdown
        label="Model"
        value={settings.model}
        options={MODELS}
        onChange={(model) => onChange({ model })}
        className={chip ? '' : 'w-44'}
        variant={variant}
        opens={opens}
        heading="Model for this session"
        title="Model for this session"
        defaultValue={defaults?.model}
      />
      <Dropdown
        label="Effort"
        value={settings.effort}
        options={EFFORTS}
        onChange={(effort) => onChange({ effort })}
        className={chip ? '' : 'w-32'}
        variant={variant}
        opens={opens}
        heading="Effort"
        title="How much the agent thinks"
        defaultValue={defaults?.effort}
      />
      <Dropdown
        label="Access"
        value={settings.access_mode}
        options={ACCESS_MODES}
        onChange={(access_mode) => onChange({ access_mode })}
        className={chip ? '' : 'w-44'}
        variant={variant}
        opens={opens}
        heading="Access"
        title="What the agent may do without asking"
        defaultValue={defaults?.access_mode}
      />
    </div>
  );
}
