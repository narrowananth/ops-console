import { Button, Spinner } from '../components/ui/button';
import { useStopSession } from '../lib/queries';

export function StopIcon() {
  return <span aria-hidden className="inline-block size-2.5 flex-none rounded-[2px] bg-current" />;
}

/**
 * Stops the agent run going in a Session, wherever that run shows: a chat, a Report, a Fix, an Agent Review. A job
 * whose run is stopped fails as stopped by the operator, and can be retried.
 */
export function StopRun({
  sessionId,
  title = 'Stop the agent where it is',
  className = 'px-2.5 py-1 text-xs',
  onStopped,
}: {
  sessionId: string;
  title?: string;
  className?: string;
  /** Called once the run has stopped. */
  onStopped?: () => void;
}) {
  const stop = useStopSession(sessionId);
  return (
    <>
      {stop.isError && (
        <span role="alert" className="text-xs text-accent-700">
          {stop.error.message}
        </span>
      )}
      <Button
        title={title}
        className={className}
        disabled={stop.isPending}
        onClick={() => stop.mutate(undefined, { onSuccess: onStopped })}
      >
        {stop.isPending ? <Spinner /> : <StopIcon />}
        Stop
      </Button>
    </>
  );
}
