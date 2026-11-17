import type { Session, SessionDefaults } from '@ops-console/shared';
import { Dropdown } from '../components/ui/dropdown';
import { useAgentSettings, useUpdateSession } from '../lib/queries';
import { ACCESS_MODES, EFFORTS, MODELS } from './options';

type Chip = 'model' | 'effort' | 'access';
type ChipsLook = {
  variant?: 'field' | 'chip';
  opens?: 'up' | 'down';
  /** Which chips to draw; all three by default. */
  show?: Chip[];
  /** Model and Effort as their bare values (`Sonnet 5.5 High`), without the captions. */
  bare?: boolean;
};

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
  show = ['model', 'effort', 'access'],
  bare = false,
}: {
  settings: SessionDefaults;
  onChange: (patch: Partial<SessionDefaults>) => void;
} & ChipsLook) {
  const defaults = useAgentSettings().data?.data.session_defaults;
  const chip = variant === 'chip';
  return (
    <div className={chip ? 'contents' : 'flex flex-wrap gap-2'}>
      {show.includes('model') && (
        <Dropdown
          label="Model"
          value={settings.model}
          options={MODELS}
          onChange={(model) => onChange({ model })}
          className={chip ? '' : 'w-44'}
          variant={variant}
          opens={opens}
          heading="Model for this session"
          title="The Claude model this Session uses. A change applies from its next run."
          defaultValue={defaults?.model}
          {...(bare ? { caption: '' } : {})}
        />
      )}
      {show.includes('effort') && (
        <Dropdown
          label="Effort"
          value={settings.effort}
          options={EFFORTS}
          onChange={(effort) => onChange({ effort })}
          className={chip ? '' : 'w-32'}
          variant={variant}
          opens={opens}
          heading="Effort"
          title="How long the agent thinks before it acts. More effort is slower."
          defaultValue={defaults?.effort}
          {...(bare ? { caption: '' } : {})}
        />
      )}
      {show.includes('access') && (
        <Dropdown
          label="Access"
          value={settings.access_mode}
          options={ACCESS_MODES}
          onChange={(access_mode) => onChange({ access_mode })}
          className={chip ? '' : 'w-44'}
          variant={variant}
          opens={opens}
          heading="Access"
          title="Access mode: what the agent may do without asking you. A PROD write asks in every mode; Full asks about nothing else."
          defaultValue={defaults?.access_mode}
        />
      )}
    </div>
  );
}
