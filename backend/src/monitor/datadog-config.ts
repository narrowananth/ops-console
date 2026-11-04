import { ConnectorId, connectorConfigSchemas } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { connectors } from '../db/schema';
import type { Store } from '../db/store';
import { parseJson } from './mappers';

export type DatadogConfig = z.infer<(typeof connectorConfigSchemas)[ConnectorId.Datadog]>;

/** The Datadog Connector's config, with defaults for what the operator has not set. */
export function datadogConfig(db: Store['db']): DatadogConfig {
  const raw = db.select().from(connectors).where(eq(connectors.id, ConnectorId.Datadog)).get();
  return connectorConfigSchemas[ConnectorId.Datadog].parse(parseJson(raw?.config ?? null, {}));
}
