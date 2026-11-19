import { ConnectorId } from '@ops-console/shared';
import type { Store } from '../db/store';
import type { Keychain } from '../keychain/keychain';
import { type LokiLogsConfig, lokiLogsConfig } from './log-source-config';

/** The Loki secret's Keychain item (ADR 0004): the Connector's own, apart from any MCP server's env vars. */
export const LOKI_SECRET_KEY = `connection:${ConnectorId.LokiLogs}`;

/** The Connector's config, and the environment `logcli` gets from it and the Keychain. */
export type LokiAccess = { config: LokiLogsConfig; childEnv: Record<string, string> };

/**
 * Where `logcli` reaches Loki and as whom. The secret goes into the child's environment, never its arguments, and the
 * ambient `LOKI_*` of the daemon's own is not passed on, so only these values apply. Read at the moment of use.
 */
export async function lokiAccess(db: Store['db'], keychain: Keychain): Promise<LokiAccess> {
  const config = lokiLogsConfig(db);
  const secret = config.auth === 'none' ? null : await keychain.get(LOKI_SECRET_KEY);
  const childEnv: Record<string, string> = { LOKI_ADDR: config.url };
  if (config.org_id !== '') childEnv.LOKI_ORG_ID = config.org_id;
  if (secret !== null && config.auth === 'bearer') childEnv.LOKI_BEARER_TOKEN = secret;
  if (secret !== null && config.auth === 'basic') {
    childEnv.LOKI_USERNAME = config.username;
    childEnv.LOKI_PASSWORD = secret;
  }
  return { config, childEnv };
}

/** The values of `access` that must not appear in anything the daemon says or the agent reads. */
export const secretsOf = ({ childEnv }: Pick<LokiAccess, 'childEnv'>): string[] =>
  [childEnv.LOKI_PASSWORD, childEnv.LOKI_BEARER_TOKEN].filter(
    (value): value is string => value !== undefined && value !== '',
  );
