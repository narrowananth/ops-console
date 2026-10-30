import { type Alert, AlertStatus, RouteState, ScanStatus, type Severity } from '@ops-console/shared';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { useAlerts, usePatchRoute, useScans, useServices, useStartScan } from '../lib/queries';

const STATE: Record<RouteState, string> = {
  [RouteState.Ok]: 'ok',
  [RouteState.Failing]: 'failing',
  [RouteState.Rapid]: 'rapid',
};

const SEVERITY: Record<Severity, string> = { sev2: 'SEV2', sev3: 'SEV3', warn: 'WARN' };

/** Error counts of the last Scans as bars; the tallest is the Route's own worst. */
function Trend({ counts }: { counts: number[] }) {
  const top = Math.max(1, ...counts);
  return (
    <span aria-hidden className="inline-flex h-4 items-end gap-px">
      {counts.map((count, index) => (
        // The index is the Scan's place in the series; the values repeat.
        // biome-ignore lint/suspicious/noArrayIndexKey: bars have no identity of their own
        <span key={index} className="w-1 bg-accent" style={{ height: `${Math.max(2, (count / top) * 16)}px` }} />
      ))}
    </span>
  );
}

export function ServicesPane({
  connected,
  selected,
  onSelect,
}: {
  connected: boolean;
  selected: string | null;
  onSelect: (alertId: string) => void;
}) {
  const services = useServices();
  const alerts = useAlerts();
  const scans = useScans();
  const scan = useStartScan();
  const patchRoute = usePatchRoute();
  const last = scans.data?.[0];
  const lastGood = scans.data?.find((row) => row.status === ScanStatus.Ok);
  const open = (alerts.data ?? []).filter(
    (alert) => alert.status !== AlertStatus.Resolved && alert.status !== AlertStatus.Dismissed,
  );
  const alertOf = (routeId: string): Alert | undefined => open.find((alert) => alert.route.id === routeId);

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-divider px-5 py-3">
        <strong className="text-[13px]">Services</strong>
        <Button
          className="ml-auto px-2.5 py-1 text-xs"
          disabled={!connected || scan.isPending}
          title={connected ? undefined : 'Connect Datadog in Settings › Connectors'}
          onClick={() => scan.mutate(null)}
        >
          Scan now
        </Button>
      </div>
      {scan.isError && (
        <div role="alert" className="border-b border-divider px-5 py-2 text-xs text-accent-700">
          {scan.error.message}
        </div>
      )}
      {last && (last.status === ScanStatus.Failed || last.status === ScanStatus.RateLimited) && (
        <div role="status" className="border-b border-divider bg-accent-100 px-5 py-2 text-xs text-accent-700">
          The last Scan {last.status === ScanStatus.RateLimited ? 'hit a Datadog rate limit' : 'could not read Datadog'}{' '}
          ({last.error_code}).{' '}
          {lastGood?.finished_at
            ? `Last good Scan: ${new Date(lastGood.finished_at).toLocaleString()}.`
            : 'No good Scan yet.'}
        </div>
      )}
      {last?.status === ScanStatus.Running && (
        <div role="status" className="border-b border-divider px-5 py-2 text-xs text-neutral-700">
          Scanning…
        </div>
      )}
      {services.isError ? (
        <Empty>Could not read Services: {services.error.message}</Empty>
      ) : (services.data ?? []).length === 0 ? (
        <Empty>No Services yet. Run a Scan.</Empty>
      ) : (
        (services.data ?? []).map((service) => (
          <section key={service.id} aria-label={service.name} className="border-b border-divider">
            <header className="flex items-baseline gap-2 px-5 py-2">
              <strong className="text-[13px]">{service.name}</strong>
              <span className="font-mono text-[11px] text-neutral-700">{service.env}</span>
              <span className="ml-auto text-[11px] text-neutral-700">
                {service.open_alert_count} open
                {service.last_scan_at ? ` · ${new Date(service.last_scan_at).toLocaleTimeString()}` : ''}
              </span>
            </header>
            <ul className="m-0 list-none p-0">
              {service.routes.map((route) => {
                const alert = alertOf(route.id);
                return (
                  <li key={route.id} className="flex items-center gap-2 px-5 py-1 text-xs">
                    <button
                      type="button"
                      disabled={!alert}
                      aria-current={alert !== undefined && selected === alert.id}
                      onClick={() => alert && onSelect(alert.id)}
                      className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 border-l-3 bg-transparent py-1 pl-2 text-left text-text disabled:cursor-default ${alert && selected === alert.id ? 'border-l-accent bg-neutral-200' : 'border-l-transparent'}`}
                    >
                      <span className="w-12 flex-none font-mono text-[11px]">{route.method}</span>
                      <span className={`truncate font-mono ${route.ignored ? 'line-through' : ''}`}>{route.path}</span>
                      <Trend counts={route.trend} />
                      <span
                        className={route.state === RouteState.Ok ? 'text-neutral-700' : 'font-bold text-accent-700'}
                      >
                        {route.state ? STATE[route.state] : '–'}
                      </span>
                      {alert && <span className="font-bold">{SEVERITY[alert.severity]}</span>}
                    </button>
                    <button
                      type="button"
                      className="cursor-pointer border-0 bg-transparent px-1 text-[11px] text-accent hover:underline"
                      onClick={() => patchRoute.mutate({ id: route.id, ignored: !route.ignored })}
                    >
                      {route.ignored ? 'Watch' : 'Ignore'}
                    </button>
                  </li>
                );
              })}
              {service.routes
                .filter((route) => route.ignored && route.note)
                .map((route) => (
                  <li key={`${route.id}-note`} className="px-7 pb-1 text-[11px] text-neutral-700">
                    {route.method} {route.path}: {route.note}
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
