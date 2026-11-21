import { ConnectorId, HealthStatus } from '@ops-console/shared';
import { asksPick, PickStep } from './pick-step';
import { type ConnectPane, SignInStep } from './sign-in-step';

/** Loki reads Grafana Cloud only. Connect signs in there; a stack with several Loki data sources asks for one after. */
export function LokiStep({ connector, pending, cancelling, onConnect, onCancel }: ConnectPane) {
  const choosing = asksPick(connector, ConnectorId.LokiLogs);
  const connected = connector.status === HealthStatus.Ok;
  return (
    <>
      <SignInStep
        // The question has its own picker below: the step does not show it as a failure.
        connector={choosing ? { ...connector, status_detail: null } : connector}
        pending={pending}
        cancelling={cancelling}
        onConnect={() => onConnect({})}
        onCancel={onCancel}
        detail={
          connected && connector.account_label
            ? `Reading the Loki data source ${connector.account_label}.`
            : "Grafana Cloud only: a self-hosted Loki is not read. Opens Grafana Cloud's sign-in page in your browser."
        }
      />
      {choosing && (
        <PickStep
          id={ConnectorId.LokiLogs}
          pending={pending}
          onPick={(datasource_uid) => onConnect({ datasource_uid })}
        />
      )}
    </>
  );
}
