import { AccessLevel, type Connection, type Session } from '@ops-console/shared';
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { DatabaseIcon } from '../components/ui/icons';
import { menu } from '../components/ui/item';
import { ConnectionRow } from '../devtools/connection-row';
import { useConnections, useUpdateSession } from '../lib/queries';
import { ascending } from '../lib/sort';
import { useAnchoredMenu } from './anchored-menu';

/** The Connections the Session's agent may reach, A to Z: the scope less what no longer exists or has Access Level none. */
export function useScopedConnections(session: Session): Connection[] {
  const connections = useConnections().data?.data ?? [];
  const ids = session.connection_ids ?? [];
  return ascending(
    connections.filter((connection) => ids.includes(connection.id) && connection.access !== AccessLevel.None),
    (connection) => connection.name,
  );
}

/**
 * The composer's Connections icon, beside Repos: the databases this Session's agent may query. None are ticked in a new
 * Session. The choice is the operator's, made here, and applies from the Session's next run.
 */
export function SessionConnections({ session }: { session: Session }) {
  const update = useUpdateSession(session.id);
  const connections = useConnections();
  const navigate = useNavigate();
  const { trigger, open, place, close, toggle } = useAnchoredMenu('data-session-connections');
  const picked = useScopedConnections(session);
  // Each click builds on the last list asked for while an earlier one is still being saved, so quick clicks all stick.
  const asked = useRef({ pending: 0, ids: [] as string[] });
  const scope = session.connection_ids;
  // A PR Session's Connections come from its Repo's `.env`; there is nothing to tick.
  if (scope === null || session.pr_action !== null) return null;
  const ids = picked.map((connection) => connection.id);
  const choice = picked.length === 0 ? 'none' : picked.map((connection) => connection.name).join(', ');
  const all = connections.data?.data ?? [];
  const flip = (id: string) => {
    const base = asked.current.pending > 0 ? asked.current.ids : scope;
    const next = base.includes(id) ? base.filter((one) => one !== id) : [...base, id];
    asked.current = { pending: asked.current.pending + 1, ids: next };
    update
      .mutateAsync({ connection_ids: next })
      .catch(() => {}) // `useUpdateSession` refetches on failure
      .finally(() => {
        asked.current.pending -= 1;
      });
  };

  return (
    <div className="relative flex-none">
      {open && (
        <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-50 cursor-default" onClick={close} />
      )}
      <button
        ref={trigger}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Connections: ${choice}`}
        title={`Connections: ${choice}. Databases this Session's agent may query, as each Connection's Access Level allows. None are reached unless ticked. Applies from its next run.`}
        onClick={() => toggle()}
        className={`relative flex size-9 cursor-pointer items-center justify-center rounded-full border text-neutral-700 hover:border-accent-300 hover:text-text ${
          open
            ? 'border-divider bg-neutral-200'
            : picked.length > 0
              ? 'border-accent-300 bg-accent-100'
              : 'border-line bg-card'
        }`}
      >
        <DatabaseIcon size={19} />
        {picked.length > 0 && (
          <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-semibold text-white">
            {picked.length}
          </span>
        )}
      </button>
      {place && (
        <div
          data-session-connections
          style={place}
          className={`fixed z-51 max-h-80 w-72 max-w-[calc(100vw-16px)] overflow-auto ${menu}`}
        >
          <div className="px-2.5 pt-1.5 pb-1 text-xs font-semibold tracking-[0.06em] text-neutral-600 uppercase">
            Connections for this session
          </div>
          <p className="px-2.5 pb-1.5 text-xs text-neutral-700">
            The agent can query the ticked Connections. It only reads unless you ask for a change.
          </p>
          {connections.isPending && <div className="px-2.5 py-2 text-xs text-neutral-700">Reading Connections…</div>}
          {connections.isError && (
            <div role="alert" className="px-2.5 py-2 text-xs text-accent-700">
              Could not read Connections: {connections.error.message}
            </div>
          )}
          {connections.isSuccess && all.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-neutral-700">
              No Connections yet.{' '}
              <button
                type="button"
                onClick={() => navigate('/connections')}
                className="cursor-pointer border-0 bg-transparent p-0 text-accent underline"
              >
                Add one in Connections
              </button>
              .
            </div>
          )}
          {ascending(all, (connection) => connection.name).map((connection) => {
            const none = connection.access === AccessLevel.None;
            return (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                on={ids.includes(connection.id)}
                disabled={none}
                title={
                  none
                    ? 'Its Access Level is none. Set it in Connections to tick it.'
                    : 'Tick it to let this Session query it.'
                }
                onToggle={() => flip(connection.id)}
              />
            );
          })}
          {all.some((connection) => connection.access === AccessLevel.None) && (
            <p className="m-0 px-2.5 pt-1.5 pb-1 text-xs text-neutral-700">
              Greyed Connections have Access Level none. Set it in Connections.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
