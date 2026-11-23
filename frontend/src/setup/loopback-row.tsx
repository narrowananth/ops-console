import { useState } from 'react';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Toggle } from '../components/ui/toggle';
import { useAgentSettings, usePatchSettings } from '../lib/queries';
import { Checking, ReadFailed } from './row-states';

/**
 * Whether a chat run's commands may start servers and reach every service on this Mac's localhost. Off until the
 * operator turns it on, and turning it on asks first.
 */
export function LoopbackRow() {
  const read = useAgentSettings();
  const patch = usePatchSettings();
  const [asking, setAsking] = useState(false);
  const on = read.data?.data.run_sandbox_loopback === true;
  const save = (value: boolean) => patch.mutate({ run_sandbox_loopback: value }, { onSettled: () => setAsking(false) });
  return (
    <li aria-label="Loopback" className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-2.5">
      <div className="flex items-center gap-2">
        <strong className="flex-1">Loopback</strong>
        {!read.data && !read.error && <Checking />}
        {!read.error && (
          <Toggle
            label="Loopback"
            checked={on}
            disabled={!read.data || patch.isPending}
            onChange={(next) => (next ? setAsking(true) : save(false))}
          />
        )}
      </div>
      <span className="text-neutral-700">
        Lets an agent run's commands start servers and reach every service on this Mac's localhost. Off by default.
      </span>
      {read.error && <ReadFailed message="Could not read the setting" onRetry={() => read.refetch()} />}
      {patch.error && (
        <span role="alert" className="text-accent-700">
          {patch.error.message}
        </span>
      )}
      {asking && (
        <ConfirmDialog
          title="Turn on Loopback?"
          action="Turn on"
          pending={patch.isPending}
          onConfirm={() => save(true)}
          onCancel={() => setAsking(false)}
        >
          Commands the agent runs can start servers and reach every service on this Mac's localhost, such as databases.
          Turn on?
        </ConfirmDialog>
      )}
    </li>
  );
}
