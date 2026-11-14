import path from 'node:path';
import { AccessLevel, ConnectionType, FirebaseService, READ_ONLY_TYPES, SERVER_TYPES } from '@ops-console/shared';
import { FILE_PREFIX, FILES_DIR } from '../mcp/launcher';

/** How a Connection's MCP Server starts: a command line, and the env vars the launcher reads from the Keychain. */
export type Launch = {
  target: string;
  env: Record<string, string>;
  /** A read that fits this Connection better than the type's own, when the config says what it reaches. */
  ping?: { tool: string; args: Record<string, unknown> };
};

export type LaunchInput = {
  type: ConnectionType;
  config: Record<string, unknown>;
  secret: string | null;
  access: AccessLevel;
  /** The folder of config files shipped with the app (`backend/launch`). */
  launchDir: string;
};

type Recipe = {
  build(input: LaunchInput): Launch;
  /** One read that proves the server reaches the database: a tool and its arguments. */
  ping: { tool: string; args: Record<string, unknown> };
};

const str = (config: Record<string, unknown>, key: string): string => String(config[key] ?? '');

/**
 * A Firebase Connection's secret: a service-account key, as its JSON or that JSON in base64 (as an `.env` keeps it).
 * Null when it is neither, or lacks the project, client email or private key.
 */
export function parseServiceAccount(secret: string): { json: string; project_id: string } | null {
  const trimmed = secret.trim();
  const readings = trimmed.startsWith('{') ? [trimmed] : [Buffer.from(trimmed, 'base64').toString('utf8')];
  for (const text of readings) {
    try {
      const key = JSON.parse(text) as Record<string, unknown>;
      if (
        typeof key.project_id === 'string' &&
        typeof key.client_email === 'string' &&
        typeof key.private_key === 'string'
      )
        return { json: text, project_id: key.project_id };
    } catch {
      // Not a key.
    }
  }
  return null;
}

/** The `firebase mcp` feature for each product. */
const FIREBASE_FEATURES: Record<FirebaseService, string> = {
  [FirebaseService.RealtimeDatabase]: 'database',
  [FirebaseService.Firestore]: 'firestore',
  [FirebaseService.Auth]: 'auth',
  [FirebaseService.Storage]: 'storage',
};

/** The tools of `firebase mcp` that only read: the project's own, then each product's. */
const FIREBASE_READ_TOOLS: { core: string[] } & Record<FirebaseService, string[]> = {
  core: [
    'firebase_get_project',
    'firebase_get_environment',
    'firebase_list_apps',
    'firebase_get_sdk_config',
    'firebase_get_security_rules',
    'firebase_validate_security_rules',
    'firebase_read_resources',
  ],
  [FirebaseService.RealtimeDatabase]: ['realtimedatabase_get_data'],
  [FirebaseService.Firestore]: [
    'firestore_query_collection',
    'firestore_get_document',
    'firestore_list_documents',
    'firestore_list_collections',
    'firestore_get_database',
    'firestore_list_databases',
    'firestore_get_index',
    'firestore_list_indexes',
  ],
  [FirebaseService.Auth]: ['auth_get_users'],
  [FirebaseService.Storage]: ['storage_get_object_download_url'],
};

/**
 * The read that proves a Firebase Connection reaches what it was made for. The project lookup (`firebase_get_project`)
 * needs a Google Cloud permission a key with only product roles lacks, so a Connection that names a product is tested
 * with a read of that product. Auth and Storage have no cheap read of their own and keep the project lookup.
 */
function firebasePing(config: Record<string, unknown>, services: FirebaseService[]): Launch['ping'] {
  const project = str(config, 'project_id');
  if (services.includes(FirebaseService.RealtimeDatabase)) {
    // Without `databaseUrl`, `firebase mcp` builds the address with a path import it never resolves and throws
    // "Cannot read properties of undefined (reading 'join')". This is the default address it would have used.
    return {
      tool: 'realtimedatabase_get_data',
      args: {
        path: '/ops-console-ping',
        databaseUrl: `https://${project}-default-rtdb.us-central1.firebasedatabase.app`,
      },
    };
  }
  if (services.includes(FirebaseService.Firestore)) {
    return {
      tool: 'firestore_list_collections',
      args: { parent: `projects/${project}/databases/(default)/documents` },
    };
  }
  return undefined;
}

/** Every read tool of `firebase mcp`; a Dev tools write check lets these through. */
export const FIREBASE_READS: ReadonlySet<string> = new Set(Object.values(FIREBASE_READ_TOOLS).flat());

/**
 * One MCP Server per type, picked for how it enforces read-only. Kafka has none yet, so it can be saved with Access
 * Level `none` and cannot be registered.
 */
const RECIPES: Partial<Record<ConnectionType, Recipe>> = {
  [ConnectionType.Postgres]: {
    ping: { tool: 'execute_sql', args: { sql: 'select 1' } },
    // dbhub dropped its `--readonly` flag; read-only now lives in a TOML file, which fills its DSN from the env.
    build({ config, secret, access, launchDir }) {
      const dsn = `postgres://${encodeURIComponent(str(config, 'user'))}:${encodeURIComponent(secret ?? '')}@${str(config, 'host')}:${str(config, 'port')}/${encodeURIComponent(str(config, 'database'))}?sslmode=disable`;
      const readOnly = access === AccessLevel.Write ? '' : ` --config ${path.join(launchDir, 'dbhub-readonly.toml')}`;
      return { target: `npx -y @bytebase/dbhub@latest --transport stdio${readOnly}`, env: { DSN: dsn } };
    },
  },
  [ConnectionType.Mongodb]: {
    // Each tool names its connection; the one from MDB_MCP_CONNECTION_STRING is `preconfigured`.
    ping: { tool: 'list-databases', args: { connectionId: 'preconfigured' } },
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
  [ConnectionType.Firebase]: {
    ping: { tool: 'firebase_get_project', args: {} },
    // `firebase mcp` reads its key from a file and its project from `.firebaserc`; both go in the launcher's private
    // folder. Read-only loads the read tools alone, so a write tool does not exist for the agent.
    build({ config, secret, access }) {
      const services = (config.services ?? []) as FirebaseService[];
      const pick =
        access === AccessLevel.Write
          ? `--only core,${services.map((service) => FIREBASE_FEATURES[service]).join(',')}`
          : `--tools ${[...FIREBASE_READ_TOOLS.core, ...services.flatMap((service) => FIREBASE_READ_TOOLS[service])].join(',')}`;
      return {
        ping: firebasePing(config, services),
        target: `npx -y firebase-tools@latest mcp --dir ${FILES_DIR} ${pick}`,
        env: {
          [`${FILE_PREFIX}key.json`]: (secret && parseServiceAccount(secret)?.json) ?? '',
          [`${FILE_PREFIX}.firebaserc`]: JSON.stringify({ projects: { default: str(config, 'project_id') } }),
          GOOGLE_APPLICATION_CREDENTIALS: `${FILES_DIR}/key.json`,
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
