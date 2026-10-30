import { z } from 'zod';
import { HealthStatus } from './mcp';

export enum ConnectionType {
  Postgres = 'postgres',
  Mongodb = 'mongodb',
  Redis = 'redis',
  Clickhouse = 'clickhouse',
  Firebase = 'firebase',
  Kafka = 'kafka',
}

export enum ConnectionEnv {
  Local = 'local',
  Dev = 'dev',
  Staging = 'staging',
  Prod = 'prod',
}

export enum AccessLevel {
  None = 'none',
  Read = 'read',
  Write = 'write',
}

export enum TerminalKind {
  Setup = 'setup',
}

const port = z.number().int().min(1).max(65535);

/** Non-secret fields by type; the secret goes to the Keychain. */
export const connectionConfigSchemas = {
  [ConnectionType.Postgres]: z.strictObject({
    host: z.string().min(1),
    port,
    database: z.string().min(1),
    user: z.string().min(1),
  }),
  [ConnectionType.Mongodb]: z.strictObject({ database: z.string() }),
  [ConnectionType.Redis]: z.strictObject({ host: z.string().min(1), port, db_index: z.number().int().min(0) }),
  [ConnectionType.Clickhouse]: z.strictObject({
    host: z.string().min(1),
    http_port: port,
    database: z.string().min(1),
    user: z.string().min(1),
  }),
  [ConnectionType.Firebase]: z.strictObject({ project_id: z.string().min(1), services: z.array(z.string().min(1)) }),
  [ConnectionType.Kafka]: z.strictObject({
    bootstrap_servers: z.string().min(1),
    sasl_mechanism: z.string(),
    schema_registry_url: z.string(),
    kafbat_url: z.string(),
  }),
} satisfies Record<ConnectionType, z.ZodType>;

/** Types with an MCP Server picked for them. The others can be saved with Access Level `none` only. */
export const SERVER_TYPES: ConnectionType[] = [
  ConnectionType.Postgres,
  ConnectionType.Mongodb,
  ConnectionType.Redis,
  ConnectionType.Clickhouse,
];

/** Types whose server enforces read-only at launch (a flag or a read-only transaction). */
export const READ_ONLY_TYPES: ConnectionType[] = [
  ConnectionType.Postgres,
  ConnectionType.Mongodb,
  ConnectionType.Clickhouse,
];

/** Types whose secret is required. */
export const SECRET_REQUIRED: ConnectionType[] = [
  ConnectionType.Postgres,
  ConnectionType.Mongodb,
  ConnectionType.Firebase,
];

export const connectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(ConnectionType),
  env: z.enum(ConnectionEnv),
  access: z.enum(AccessLevel),
  config: z.record(z.string(), z.unknown()),
  status: z.enum(HealthStatus),
  status_detail: z.string().nullable(),
  latency_ms: z.number().nullable(),
  last_checked_at: z.string().nullable(),
  created_at: z.string(),
  is_prod: z.boolean(),
  secret_stored: z.boolean(),
});

export type Connection = z.infer<typeof connectionSchema>;

export const connectionListSchema = z.object({
  data: z.array(connectionSchema),
  meta: z.object({ next_cursor: z.null() }),
});

const nameSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'letters, digits, dot, dash and underscore only');

export const createConnectionSchema = z.object({
  name: nameSchema,
  type: z.enum(ConnectionType),
  env: z.enum(ConnectionEnv),
  access: z.enum(AccessLevel).optional(),
  config: z.record(z.string(), z.unknown()),
  secret: z.string().min(1).optional(),
});

export type CreateConnection = z.infer<typeof createConnectionSchema>;

export const updateConnectionSchema = z.object({
  name: nameSchema.optional(),
  env: z.enum(ConnectionEnv).optional(),
  access: z.enum(AccessLevel).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().min(1).optional(),
});

export type UpdateConnection = z.infer<typeof updateConnectionSchema>;

export const testConnectionSchema = z.object({
  type: z.enum(ConnectionType),
  config: z.record(z.string(), z.unknown()),
  secret: z.string().min(1).optional(),
});

export const connectionTestResultSchema = z.object({
  status: z.enum(HealthStatus),
  latency_ms: z.number().nullable(),
  detail: z.string().nullable(),
});

export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;

export const connectionCheckSchema = z.object({
  status: z.enum(HealthStatus),
  status_detail: z.string().nullable(),
  latency_ms: z.number().nullable(),
  last_checked_at: z.string(),
});

export const createTerminalSchema = z.object({ kind: z.enum(TerminalKind) });

export const terminalSecretSchema = z.object({ request_id: z.string().min(1), value: z.string().min(1) });

/** Client to server on `/terminals/:id`. */
export const terminalClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({ type: z.literal('line'), text: z.string() }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(200),
  }),
]);

export const terminalServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('secret_requested'), request_id: z.string(), label: z.string() }),
  z.object({
    type: z.literal('saved'),
    target: z.enum(['connection', 'connector', 'mcp_server']),
    id: z.string(),
  }),
  z.object({ type: z.literal('exit'), code: z.number().nullable() }),
]);

export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;

export const TERMINALS_PATH = '/terminals';
