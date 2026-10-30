import { AccessLevel, ConnectionType, READ_ONLY_TYPES, SERVER_TYPES } from '@ops-console/shared';

/** How a Connection's MCP Server starts: a command line, and the env vars the launcher reads from the Keychain. */
export type Launch = { target: string; env: Record<string, string> };

export type LaunchInput = {
  type: ConnectionType;
  config: Record<string, unknown>;
  secret: string | null;
  access: AccessLevel;
};

type Recipe = {
  build(input: LaunchInput): Launch;
  /** One read that proves the server reaches the database: a tool and its arguments. */
  ping: { tool: string; args: Record<string, unknown> };
};

const str = (config: Record<string, unknown>, key: string): string => String(config[key] ?? '');

/**
 * One MCP Server per type, picked for how it enforces read-only. Firebase and Kafka have none yet, so they can be
 * saved with Access Level `none` and cannot be registered.
 */
const RECIPES: Partial<Record<ConnectionType, Recipe>> = {
  [ConnectionType.Postgres]: {
    ping: { tool: 'execute_sql', args: { sql: 'select 1' } },
    build({ config, secret, access }) {
      const dsn = `postgres://${encodeURIComponent(str(config, 'user'))}:${encodeURIComponent(secret ?? '')}@${str(config, 'host')}:${str(config, 'port')}/${encodeURIComponent(str(config, 'database'))}?sslmode=disable`;
      return {
        target: `npx -y @bytebase/dbhub@latest --transport stdio${access === AccessLevel.Write ? '' : ' --readonly'}`,
        env: { DSN: dsn },
      };
    },
  },
  [ConnectionType.Mongodb]: {
    ping: { tool: 'list-databases', args: {} },
    build({ secret, access }) {
      return {
        target: `npx -y mongodb-mcp-server@latest${access === AccessLevel.Write ? '' : ' --readOnly'}`,
        env: { MDB_MCP_CONNECTION_STRING: secret ?? '', MDB_MCP_TELEMETRY: 'disabled' },
      };
    },
  },
  [ConnectionType.Redis]: {
    ping: { tool: 'dbsize', args: {} },
    build({ config, secret }) {
      return {
        target: 'uvx --from redis-mcp-server@latest redis-mcp-server',
        env: {
          REDIS_HOST: str(config, 'host'),
          REDIS_PORT: str(config, 'port'),
          REDIS_DB: str(config, 'db_index'),
          ...(secret ? { REDIS_PWD: secret } : {}),
        },
      };
    },
  },
  [ConnectionType.Clickhouse]: {
    ping: { tool: 'list_databases', args: {} },
    build({ config, secret, access }) {
      return {
        target: 'uvx mcp-clickhouse',
        env: {
          CLICKHOUSE_HOST: str(config, 'host'),
          CLICKHOUSE_PORT: str(config, 'http_port'),
          CLICKHOUSE_USER: str(config, 'user'),
          CLICKHOUSE_DATABASE: str(config, 'database'),
          CLICKHOUSE_SECURE: 'false',
          CLICKHOUSE_VERIFY: 'false',
          CLICKHOUSE_ALLOW_WRITE_ACCESS: access === AccessLevel.Write ? 'true' : 'false',
          ...(secret ? { CLICKHOUSE_PASSWORD: secret } : {}),
        },
      };
    },
  },
};

/** Whether a server exists for the type; without one the Connection can only be saved with Access Level `none`. */
export const hasServer = (type: ConnectionType): boolean => SERVER_TYPES.includes(type);

/** The Access Level is never only a label: `read` needs a server that enforces it at launch. */
export const supportsReadOnly = (type: ConnectionType): boolean => READ_ONLY_TYPES.includes(type);

export function launchFor(input: LaunchInput): Launch | null {
  return RECIPES[input.type]?.build(input) ?? null;
}

export function pingFor(type: ConnectionType): { tool: string; args: Record<string, unknown> } | null {
  return RECIPES[type]?.ping ?? null;
}
