import { ConnectorId, connectorConfigSchemas, type LogSource } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { connectors } from '../db/schema';
import type { Store } from '../db/store';
import { parseJson } from './mappers';

export type DatadogConfig = z.infer<(typeof connectorConfigSchemas)[ConnectorId.Datadog]>;
export type OtelLogsConfig = z.infer<(typeof connectorConfigSchemas)[ConnectorId.OtelLogs]>;
export type CloudWatchLogsConfig = z.infer<(typeof connectorConfigSchemas)[ConnectorId.CloudWatchLogs]>;

/** What every log source holds: when and how often to scan, the Severity thresholds, and what to ignore. */
export type LogSourceConfig = Omit<DatadogConfig, 'site'>;

const raw = (db: Store['db'], id: ConnectorId) =>
  parseJson(db.select().from(connectors).where(eq(connectors.id, id)).get()?.config ?? null, {});

/** The Datadog Connector's config, with defaults for what the operator has not set. */
export const datadogConfig = (db: Store['db']): DatadogConfig =>
  connectorConfigSchemas[ConnectorId.Datadog].parse(raw(db, ConnectorId.Datadog));

/** The OpenTelemetry logs Connector's config, with defaults for what the operator has not set. */
export const otelLogsConfig = (db: Store['db']): OtelLogsConfig =>
  connectorConfigSchemas[ConnectorId.OtelLogs].parse(raw(db, ConnectorId.OtelLogs));

/** The CloudWatch logs Connector's config, with defaults for what the operator has not set. */
export const cloudWatchLogsConfig = (db: Store['db']): CloudWatchLogsConfig =>
  connectorConfigSchemas[ConnectorId.CloudWatchLogs].parse(raw(db, ConnectorId.CloudWatchLogs));

/** The config of one log source's Connector. */
export function logSourceConfig(db: Store['db'], connector: LogSource): LogSourceConfig {
  if (connector === ConnectorId.OtelLogs) return otelLogsConfig(db);
  if (connector === ConnectorId.CloudWatchLogs) return cloudWatchLogsConfig(db);
  return datadogConfig(db);
}
