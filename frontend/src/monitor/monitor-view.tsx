import { ConnectorId, HealthStatus } from '@ops-console/shared';
import { useState } from 'react';
import { BrandIcon } from '../components/ui/brand-icon';
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
    return (
      <Empty>
        <span className="flex items-center gap-2.5">
          <BrandIcon brand="datadog" size="sm" />
          Connect Datadog in Integrations.
        </span>
      </Empty>
    );
  }
  return (
    <>
      <aside className="flex w-96 flex-none flex-col overflow-y-auto border-r border-line">
        <ServicesPane connected={connected} selected={alertId} onSelect={setAlertId} />
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        {alertId ? <AlertView key={alertId} id={alertId} /> : <Empty>Pick an Alert.</Empty>}
      </section>
    </>
  );
}
