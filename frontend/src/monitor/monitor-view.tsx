import { ConnectorId, HealthStatus } from '@ops-console/shared';
import { BrandIcon } from '../components/ui/brand-icon';
import { Empty } from '../components/ui/empty';
import { useAlerts, useConnectors, useServices } from '../lib/queries';
import { useAddress } from '../lib/remember';
import { AlertView } from './alert-view';
import { LogsPane } from './logs-pane';
import { useScanScope } from './scan-scope';
import { ServicesPane } from './services-pane';

export function MonitorView() {
  // The picked Service and Alert live in the address: Back steps through them and a reload keeps them.
  const [{ service, alert }, setAddress] = useAddress('service', 'alert');
  const alerts = useAlerts();
  // An Alert that is gone leaves nothing picked.
  const alertId = alert !== null && alerts.data && !alerts.data.some((row) => row.id === alert) ? null : alert;
  const connectors = useConnectors();
  const services = useServices();
  const datadog = connectors.data?.data.find((connector) => connector.id === ConnectorId.Datadog);
  const connected = datadog?.status === HealthStatus.Ok;
  const scope = useScanScope();

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
      <aside className="flex w-68 flex-none flex-col border-r border-line">
        <ServicesPane
          connected={connected}
          scope={scope}
          selected={service}
          onSelect={(name) => setAddress({ service: name, alert: null })}
        />
      </aside>
      <aside className="flex w-100 flex-none flex-col border-r border-line">
        <LogsPane
          service={service}
          codes={scope.codes}
          range={scope.range}
          selected={alertId}
          onSelect={(id) => setAddress({ alert: id })}
        />
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        {alertId ? <AlertView key={alertId} id={alertId} /> : <Empty>Pick a log to see it and verify it.</Empty>}
      </section>
    </>
  );
}
