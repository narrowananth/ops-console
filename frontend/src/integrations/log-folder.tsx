import { type Connector, HealthStatus } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { usePickLogFolder } from '../lib/queries';
import { ChoiceCard, type ConnectPane, SignInStep } from './sign-in-step';

/** The Log folder the Connector reads, kept across a Disconnect; empty until one is chosen. */
export function savedFolder(connector: Connector): string {
  return typeof connector.config.folder === 'string' ? connector.config.folder : '';
}

/** The folder comes from the macOS folder dialog, and Connect starts reading it: the daemon says why when it cannot. */
export function LogFolderStep({ connector, pending, cancelling, onConnect, onCancel }: ConnectPane) {
  const [folder, setFolder] = useState(savedFolder(connector));
  const pick = usePickLogFolder();
  const connected = connector.status === HealthStatus.Ok;
  return (
    <>
      <ChoiceCard label="Log folder">
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            <span className="font-semibold" title="The folder on this Mac that Monitor reads OpenTelemetry logs from.">
              Log folder
            </span>
            <span className={`truncate font-mono text-[13px] ${folder === '' ? 'text-neutral-700' : ''}`}>
              {folder === '' ? 'No folder chosen' : folder}
            </span>
          </div>
          <Button
            className="shrink-0"
            title="Pick the folder your Collector's file exporter writes OTLP JSON logs to"
            disabled={pick.isPending || connector.sign_in !== null}
            onClick={() =>
              pick.mutate(undefined, {
                onSuccess: (path) => {
                  if (path !== null) setFolder(path);
                },
              })
            }
          >
            Choose folder…
          </Button>
        </div>
        {pick.error && (
          <div role="alert" className="text-xs text-accent-700">
            {pick.error.message}
          </div>
        )}
      </ChoiceCard>
      <SignInStep
        connector={connector}
        pending={pending}
        cancelling={cancelling}
        label="Start reading"
        title="Read the Log folder"
        detail={
          connected
            ? 'The console reads the .json and .jsonl files in it, and never writes there.'
            : "Reads the OTLP JSON logs your Collector's file exporter writes to the folder. The console only reads it."
        }
        blocked={folder === '' ? 'Choose the Log folder first' : undefined}
        onConnect={() => onConnect({ folder })}
        onCancel={onCancel}
      />
    </>
  );
}
