import { type Connector, HealthStatus } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';

/** The Log folder the Connector reads, kept across a Disconnect; empty until one is chosen. */
export function savedFolder(connector: Connector): string {
  return typeof connector.config.folder === 'string' ? connector.config.folder : '';
}

/** Choosing a Log folder connects the Connector: the daemon reads it and says why when it cannot. */
export function LogFolderStep({
  connector,
  pending,
  onConnect,
}: {
  connector: Connector;
  pending: boolean;
  onConnect: (folder: string) => void;
}) {
  const saved = savedFolder(connector);
  const [folder, setFolder] = useState(saved);
  const connected = connector.status === HealthStatus.Ok;
  const checking = connector.status === HealthStatus.Checking;
  const detail = connected
    ? 'The console reads the .json and .jsonl files in it, and never writes there.'
    : "The folder your Collector's file exporter writes OTLP JSON logs to. The console only reads it.";
  return (
    <section
      aria-label="Log folder"
      className="flex flex-col gap-3 rounded-lg border border-line bg-card px-4 py-3.5 shadow-sm"
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (folder.trim() !== '' && !pending && !checking) onConnect(folder.trim());
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-semibold" title="The folder on this Mac that Monitor reads OpenTelemetry logs from.">
            Log folder
          </span>
          <input
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            placeholder="/Users/you/otel-logs"
            spellCheck={false}
            className="w-full border border-divider bg-card px-2 py-1.5 font-mono text-[13px] text-text"
          />
        </label>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 text-xs text-neutral-700">{detail}</div>
          <Button
            type="submit"
            variant={connected ? 'secondary' : 'primary'}
            className="shrink-0"
            title={
              connected
                ? 'Read the folder again, or switch to the one typed here'
                : 'Check the folder and start reading it'
            }
            disabled={pending || checking || folder.trim() === ''}
          >
            {connector.status === HealthStatus.Off ? 'Connect' : 'Reconnect'}
          </Button>
        </div>
      </form>
      {connector.status_detail && connector.status !== HealthStatus.Off && (
        <div role="alert" className="text-xs text-accent-700">
          {connector.status_detail}
        </div>
      )}
    </section>
  );
}
