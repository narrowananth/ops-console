import { ConnectorId } from '@ops-console/shared';
import type { Store } from '../db/store';
import type { Keychain } from '../keychain/keychain';
import { type NewRelicLogsConfig, newRelicLogsConfig } from './log-source-config';

/** The New Relic API key's Keychain item (ADR 0004): the Connector's own, apart from any MCP server's env vars. */
export const NEW_RELIC_KEY = `connection:${ConnectorId.NewRelicLogs}`;

/** The Connector's config, and the environment `newrelic` gets from it and the Keychain. */
export type NewRelicAccess = { config: NewRelicLogsConfig; childEnv: Record<string, string> };

/**
 * Which account `newrelic` reaches and as whom. The key goes into the child's environment, never its arguments, and the
 * ambient `NEW_RELIC_*` of the daemon's own is not passed on, so only these values apply. Read at the moment of use.
 */
export async function newRelicAccess(db: Store['db'], keychain: Keychain): Promise<NewRelicAccess> {
  const config = newRelicLogsConfig(db);
  const key = await keychain.get(NEW_RELIC_KEY);
  const childEnv: Record<string, string> = {
    NEW_RELIC_ACCOUNT_ID: config.account_id,
    NEW_RELIC_REGION: config.region,
  };
  if (key !== null) childEnv.NEW_RELIC_API_KEY = key;
  return { config, childEnv };
}

/** The values of `access` that must not appear in anything the daemon says or the agent reads. */
export const newRelicSecrets = ({ childEnv }: Pick<NewRelicAccess, 'childEnv'>): string[] =>
  childEnv.NEW_RELIC_API_KEY ? [childEnv.NEW_RELIC_API_KEY] : [];
