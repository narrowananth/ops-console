import { AccessLevel, type Connection, type Session } from '@ops-console/shared';
import { useUpdateSession } from '../lib/queries';

const ACCESS: Record<AccessLevel, string> = {
  [AccessLevel.None]: 'off',
  [AccessLevel.Read]: 'read-only',
  [AccessLevel.Write]: 'read / write',
};

/** The Connections a Dev tools Session may reach. None chosen means all of them. A change applies from the next run. */
export function ScopePicker({ session, connections }: { session: Session; connections: Connection[] }) {
  const update = useUpdateSession(session.id);
  const chosen = session.connection_ids ?? [];
  const toggle = (id: string) =>
    update.mutate({ connection_ids: chosen.includes(id) ? chosen.filter((other) => other !== id) : [...chosen, id] });
  return (
    <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
      <legend className="sr-only">Scope</legend>
      <span className="font-mono text-[11px] text-neutral-700">scope:</span>
      {chosen.length === 0 && <span className="font-mono text-[11px] font-bold">all</span>}
      {connections.map((connection) => {
        const off = connection.access === AccessLevel.None;
        const on = chosen.includes(connection.id);
        return (
          <button
            key={connection.id}
            type="button"
            aria-pressed={on}
            disabled={off || update.isPending}
            title={off ? 'Access Level none: set it in Settings › Dev tools' : ACCESS[connection.access]}
            onClick={() => toggle(connection.id)}
            className={`flex cursor-pointer items-center gap-1.5 border px-2 py-0.5 font-mono text-[11px] text-text disabled:cursor-not-allowed disabled:opacity-50 ${on ? 'border-text bg-neutral-300 font-bold' : 'border-divider bg-transparent'}`}
          >
            {connection.name}
            <span className="text-neutral-700">{connection.env}</span>
            {connection.is_prod && <span className="bg-accent px-1 text-[9px] font-bold text-bg">PROD</span>}
            <span className="text-neutral-700">{ACCESS[connection.access]}</span>
          </button>
        );
      })}
      {update.isError && (
        <span role="alert" className="text-xs text-accent-700">
          {update.error.message}
        </span>
      )}
    </fieldset>
  );
}
