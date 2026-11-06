import { RunOutcome } from '@ops-console/shared';
import { PlayIcon } from '../agent-runs/run-look';
import { Button, Spinner } from '../components/ui/button';
import { useAgentRuns, useRunControls } from '../lib/queries';

/**
 * Carries on a Session's run that was paused or stopped, from the conversation so far. Shows nothing while the run
 * goes, or when the run ended some other way (that one takes Retry on the Agent runs page).
 */
export function PlayRun({ sessionId, className = 'px-4 py-1.5' }: { sessionId: string; className?: string }) {
  const runs = useAgentRuns();
  const controls = useRunControls(sessionId);
  const run = runs.data?.find((candidate) => candidate.session.id === sessionId);
  const play =
    run !== undefined &&
    !run.running &&
    run.can_retry &&
    (run.outcome === RunOutcome.Paused || run.outcome === RunOutcome.Stopped);
  if (!play) return null;
  return (
    <>
      {controls.resume.isError && (
        <span role="alert" className="text-xs text-accent-700">
          {controls.resume.error.message}
        </span>
      )}
      <Button
        title="Play: carry on from where it stopped"
        className={className}
        disabled={controls.resume.isPending}
        onClick={() => controls.resume.mutate()}
      >
        {controls.resume.isPending ? <Spinner /> : <PlayIcon />}
        Play
      </Button>
    </>
  );
}
