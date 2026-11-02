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

/** The Firebase products a Firebase Connection reaches. */
export enum FirebaseService {
  RealtimeDatabase = 'realtime_database',
  Firestore = 'firestore',
  Auth = 'auth',
  Storage = 'storage',
}

/** Names the setup agent or the operator may write for each product. */
const FIREBASE_NAMES: Record<string, FirebaseService> = {
  realtime_database: FirebaseService.RealtimeDatabase,
  realtimedatabase: FirebaseService.RealtimeDatabase,
  rtdb: FirebaseService.RealtimeDatabase,
  database: FirebaseService.RealtimeDatabase,
  firestore: FirebaseService.Firestore,
  auth: FirebaseService.Auth,
  authentication: FirebaseService.Auth,
  storage: FirebaseService.Storage,
};

/** A product's name, read loosely (`realtime-database`, `Realtime Database`), as a `FirebaseService`. */
const firebaseService = z.string().transform((name, ctx) => {
  const service =
    FIREBASE_NAMES[
      name
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
    ];
  if (service) return service;
  ctx.addIssue({ code: 'custom', message: `one of ${Object.values(FirebaseService).join(', ')}` });
  return z.NEVER;
});

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
  [ConnectionType.Firebase]: z.strictObject({
    project_id: z.string().min(1),
    services: z.array(firebaseService).min(1),
  }),
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
  ConnectionType.Firebase,
];

/** Types whose server enforces read-only at launch (a flag, a read-only transaction, or only the read tools loaded). */
export const READ_ONLY_TYPES: ConnectionType[] = [
  ConnectionType.Postgres,
  ConnectionType.Mongodb,
  ConnectionType.Clickhouse,
  ConnectionType.Firebase,
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

/** `GET /terminals`: the running ones. A terminal runs until Close, its exit or the daemon's stop. */
export const terminalListSchema = z.object({
  data: z.array(z.object({ id: z.string(), kind: z.enum(TerminalKind) })),
});

/**
 * Whether the daemon has macOS Full Disk Access, so the Setup agent can read every folder on the machine.
 * `granted` is null off macOS. `app_path` is the `Ops Console.app` the daemon runs as, which the operator adds in
 * System Settings; null when it runs any other way, as under `pnpm dev`.
 */
export const diskAccessSchema = z.object({ granted: z.boolean().nullable(), app_path: z.string().nullable() });

export type DiskAccess = z.infer<typeof diskAccessSchema>;

/**
 * Why a setup terminal request may not reach Claude, or null when it may. Only plain requests go through: a symbol
 * first (`/login`, `!cmd`, `#`), an `@path` word or a control character would drive Claude Code itself. A line break
 * (`\n`) is the one control character allowed: a request of several lines reaches Claude as one paste. A request may be
 * any length. An empty one passes: Enter alone confirms a prompt.
 */
export function refuseSetupLine(text: string): string | null {
  if (/(?!\n)\p{Cc}/u.test(text)) return 'Type plain text: control keys do not reach Claude.';
  const first = text.trimStart()[0];
  if (first !== undefined && !/[\p{L}\p{N}]/u.test(first)) {
    return 'Start with a word. A line starting with / ! # or another symbol runs a Claude Code command.';
  }
  if (/(^|\s)@/.test(text)) return 'Write file paths without @: Claude Code would read the file into the chat.';
  return null;
}

/** Client to server on `/terminals/:id`. */
export const terminalClientMessageSchema = z.discriminatedUnion('type', [
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
  /** The line broke `refuseSetupLine` and was not written. */
  z.object({ type: z.literal('refused'), reason: z.string() }),
]);

export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;

export const TERMINALS_PATH = '/terminals';
