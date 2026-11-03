import { ConnectorId, HealthStatus } from '@ops-console/shared';
import { z } from 'zod';
import { BrandIcon } from '../components/ui/brand-icon';
import { Empty } from '../components/ui/empty';
import { PanelRail, PanelToggle, RAIL_BUTTON } from '../components/ui/side-panel';
import { useAlerts, useConnectors, useServices } from '../lib/queries';
import { useAddress, useStored } from '../lib/remember';
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
  const [collapsed, setCollapsed] = useStored('monitor.services-collapsed', z.boolean(), false);

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
      {collapsed ? (
        <PanelRail label="Services panel">
          <PanelToggle open={false} panel="Services panel" onToggle={() => setCollapsed(false)} />
          <span aria-hidden className="my-1 h-px w-6 bg-line" />
          <button
            type="button"
            aria-label={service ? `Services, ${service} picked` : 'Services'}
            title={service ? `Services: ${service} picked. Open the panel.` : 'Services. Open the panel.'}
            onClick={() => setCollapsed(false)}
            className={`relative ${RAIL_BUTTON} ${service ? 'bg-card text-text shadow-sm' : ''}`}
          >
            <ServicesIcon />
          </button>
        </PanelRail>
      ) : (
        <aside className="flex w-68 flex-none flex-col border-r border-line">
          <ServicesPane
            connected={connected}
            scope={scope}
            selected={service}
            onSelect={(name) => setAddress({ service: name, alert: null })}
            onCollapse={() => setCollapsed(true)}
          />
        </aside>
      )}
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

function ServicesIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.5" y="2.5" width="11" height="4" rx="1" />
      <rect x="2.5" y="9.5" width="11" height="4" rx="1" />
      <path d="M5 4.5h.01M5 11.5h.01" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}
