import { ErrorCode, LOG_SOURCES } from '@ops-console/shared';
import { useCallback, useMemo, useState } from 'react';
import { BrandIcon, CONNECTOR_BRAND } from '../components/ui/brand-icon';
import { Empty } from '../components/ui/empty';
import { ApiError } from '../lib/api';
import { useAlert, useConnectors, useServices } from '../lib/queries';
import { useAddress } from '../lib/remember';
import { AlertDrawer } from './alert-drawer';
import { AlertsTable } from './alerts-table';
import { CONNECT_A_SOURCE, connectedSources, downSources, useSourceFilter } from './log-source';
import { useMonitorData } from './monitor-data';
import { MonitorHeader } from './monitor-header';
import { useScanScope } from './scan-scope';
import { ServicesMenu, useTicked } from './services-menu';
import { SourceTabs } from './source-tabs';

export function MonitorView() {
  // The picked Service and Alert live in the address: Back steps through them and a reload keeps them.
  const [{ service, alert }, setAddress] = useAddress('service', 'alert');
  // An Alert that is gone leaves nothing picked. The picked one is read alone: it may be a closed one, which the list
  // holds only once asked for. The Alert's own view reads the same query.
  const picked = useAlert(alert ?? '', alert !== null);
  const alertId =
    alert !== null && picked.error instanceof ApiError && picked.error.code === ErrorCode.NotFound ? null : alert;
  const connectors = useConnectors();
  const services = useServices();
  const sources = connectedSources(connectors.data?.data ?? []);
  const down = downSources(connectors.data?.data ?? []);
  const [source, pickSource] = useSourceFilter();
  const scope = useScanScope();
  const data = useMonitorData(sources, source, scope);
  const [ticked, setTicked] = useTicked();
  // The error counts of each Route's last Scans, for the list's trend column.
  const trends = useMemo(() => {
    const byRoute = new Map<string, number[]>();
    for (const one of services.data ?? []) for (const route of one.routes) byRoute.set(route.id, route.trend);
    return byRoute;
  }, [services.data]);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const close = useCallback(() => setAddress({ alert: null }), [setAddress]);

  if (connectors.isPending || services.isPending) return <Empty>Reading the Monitor…</Empty>;
  if (sources.length === 0 && (services.data?.length ?? 0) === 0) {
    return (
      <Empty>
        <span className="flex items-center gap-2.5">
          {LOG_SOURCES.map((one) => (
            <BrandIcon key={one} brand={CONNECTOR_BRAND[one]} size="sm" />
          ))}
          {CONNECT_A_SOURCE}.
        </span>
      </Empty>
    );
  }
  return (
    <div ref={setBox} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <MonitorHeader data={data} source={source} scope={scope} selected={service} ticked={ticked} down={down} />
      <SourceTabs sources={sources} down={down} source={source} onSource={pickSource} codes={scope.codes} />
      <AlertsTable
        service={service}
        codes={scope.codes}
        range={scope.range}
        selected={alertId}
        onSelect={(id) => setAddress({ alert: id })}
        source={source}
        trends={trends}
        servicesMenu={
          <ServicesMenu
            data={data}
            range={scope.range}
            selected={service}
            onSelect={(name) => setAddress({ service: name, alert: null })}
            ticked={ticked}
            onTick={setTicked}
          />
        }
      />
      <AlertDrawer id={alertId} container={box} onClose={close} />
    </div>
  );
}
