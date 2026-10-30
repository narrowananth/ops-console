import { ConnectorId, HealthStatus } from '@ops-console/shared';
import { useState } from 'react';
import { Empty } from '../components/ui/empty';
import { useConnectors, useServices } from '../lib/queries';
import { AlertView } from './alert-view';
import { ServicesPane } from './services-pane';

export function MonitorView() {
  const [alertId, setAlertId] = useState<string | null>(null);
  const connectors = useConnectors();
  const services = useServices();
  const datadog = connectors.data?.data.find((connector) => connector.id === ConnectorId.Datadog);
  const connected = datadog?.status === HealthStatus.Ok;

  if (connectors.isPending || services.isPending) return <Empty>Reading the Monitor…</Empty>;
  if (!connected && (services.data?.length ?? 0) === 0) {
    return <Empty>Connect Datadog in Settings › Connectors.</Empty>;
  }
  return (
    <>
      <aside className="flex w-96 flex-none flex-col overflow-y-auto border-r-2 border-divider">
        <ServicesPane connected={connected} selected={alertId} onSelect={setAlertId} />
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        {alertId ? <AlertView key={alertId} id={alertId} /> : <Empty>Pick an Alert.</Empty>}
      </section>
    </>
  );
}
