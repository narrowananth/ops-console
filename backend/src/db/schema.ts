import {
  type AccessLevel,
  type AccessMode,
  type ActionActor,
  type ActionKind,
  ActionOutcome,
  type ApprovalKind,
  ApprovalStatus,
  type ConnectionEnv,
  type ConnectionType,
  type ConnectorId,
  type Effort,
  type GitHost,
  type HealthStatus,
  type McpScope,
  type McpTransport,
  type Model,
  type SessionKind,
  SessionState,
} from '@ops-console/shared';
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** A row exists only once the operator changes a value; registered defaults fill the rest. */
export const settings = sqliteTable(
  'settings',
  {
    key: text().primaryKey().notNull(),
    value: text().notNull(),
    updatedAt: text('updated_at').notNull().default(nowIso),
  },
  (table) => [check('settings_value_json', sql`json_valid(${table.value})`)],
);

const bool = (name: string) => integer(name, { mode: 'boolean' });

export const claudeAccounts = sqliteTable(
  'claude_accounts',
  {
    id: text().primaryKey().notNull(),
    label: text().notNull(),
    /** `CLAUDE_CONFIG_DIR`: one folder per account under the data directory. Every row has one. */
    configDir: text('config_dir'),
    position: integer().notNull(),
    signedIn: bool('signed_in').notNull().default(false),
    email: text(),
    plan: text(),
    fiveHourPct: real('five_hour_pct'),
    fiveHourResetsAt: text('five_hour_resets_at'),
    weeklyPct: real('weekly_pct'),
    weeklyResetsAt: text('weekly_resets_at'),
    usageSeenAt: text('usage_seen_at'),
    lastCheckedAt: text('last_checked_at'),
    createdAt: text('created_at').notNull().default(nowIso),
  },
  (table) => [
    uniqueIndex('claude_accounts_config_dir_idx').on(sql`ifnull(${table.configDir}, '')`),
    check('claude_accounts_signed_in_bool', sql`${table.signedIn} IN (0, 1)`),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text().primaryKey().notNull(),
    kind: text().$type<SessionKind>().notNull(),
    title: text().notNull(),
    model: text().$type<Model>().notNull(),
    effort: text().$type<Effort>().notNull(),
    accessMode: text('access_mode').$type<AccessMode>().notNull(),
    /** Holds the transcript; null before the first run. */
    accountId: text('account_id').references(() => claudeAccounts.id, { onDelete: 'restrict' }),
    sdkSessionId: text('sdk_session_id'),
    state: text().$type<SessionState>().notNull().default(SessionState.Idle),
    lastMessagePreview: text('last_message_preview'),
    createdAt: text('created_at').notNull().default(nowIso),
    lastActiveAt: text('last_active_at').notNull().default(nowIso),
  },
  (table) => [index('sessions_active_idx').on(sql`${table.lastActiveAt} DESC`)],
);

export const actionLog = sqliteTable(
  'action_log',
  {
    id: text().primaryKey().notNull(),
    at: text().notNull().default(nowIso),
    actor: text().$type<ActionActor>().notNull(),
    kind: text().$type<ActionKind>().notNull(),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    target: text().notNull(),
    /** Redacted. */
    command: text().notNull(),
    isProd: bool('is_prod').notNull().default(false),
    outcome: text().$type<ActionOutcome>().notNull().default(ActionOutcome.Pending),
    errorMessage: text('error_message'),
    finishedAt: text('finished_at'),
    /** The Connection a database query was for. */
    connectionId: text('connection_id').references((): AnySQLiteColumn => connections.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('action_log_at_idx').on(sql`${table.at} DESC`),
    index('action_log_session_idx').on(table.sessionId, table.at),
    check('action_log_is_prod_bool', sql`${table.isProd} IN (0, 1)`),
  ],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text().primaryKey().notNull(),
    /** Null for an edit: the Action Log does not record edits. */
    actionLogId: text('action_log_id')
      .unique()
      .references(() => actionLog.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    kind: text().$type<ApprovalKind>().notNull(),
    summary: text().notNull(),
    status: text().$type<ApprovalStatus>().notNull().default(ApprovalStatus.Pending),
    requestedAt: text('requested_at').notNull().default(nowIso),
    decidedAt: text('decided_at'),
  },
  (table) => [index('approvals_pending_idx').on(table.requestedAt).where(sql`${table.status} = 'pending'`)],
);

/** Servers the operator removed. Their config is gone from every account; the row keeps them listed to sign in again. */
export const removedMcpServers = sqliteTable('removed_mcp_servers', {
  name: text().primaryKey().notNull(),
  scope: text().$type<McpScope>().notNull(),
  transport: text().$type<McpTransport>().notNull(),
  /** Command or URL. Env vars and headers are not kept. */
  target: text().notNull(),
  removedAt: text('removed_at').notNull().default(nowIso),
});

/** Servers left out of every session the console starts. */
export const disabledMcpServers = sqliteTable('disabled_mcp_servers', {
  name: text().primaryKey().notNull(),
  disabledAt: text('disabled_at').notNull().default(nowIso),
});

/** One row per Connector, seeded by the migration. `config` never holds a secret. */
export const connectors = sqliteTable(
  'connectors',
  {
    id: text().$type<ConnectorId>().primaryKey().notNull(),
    status: text()
      .$type<HealthStatus>()
      .notNull()
      .default('off' as HealthStatus),
    statusDetail: text('status_detail'),
    /** Site, workspace or org shown in the list. */
    accountLabel: text('account_label'),
    /** Signed-in user on a Git host. */
    login: text(),
    config: text().notNull().default('{}'),
    lastCheckedAt: text('last_checked_at'),
  },
  (table) => [check('connectors_config_json', sql`json_valid(${table.config})`)],
);

/** A database the agent can reach. The server is registered under the same name; `config` never holds a secret. */
export const connections = sqliteTable(
  'connections',
  {
    id: text().primaryKey().notNull(),
    name: text().notNull().unique(),
    type: text().$type<ConnectionType>().notNull(),
    env: text().$type<ConnectionEnv>().notNull(),
    access: text()
      .$type<AccessLevel>()
      .notNull()
      .default('read' as AccessLevel),
    config: text().notNull().default('{}'),
    status: text()
      .$type<HealthStatus>()
      .notNull()
      .default('off' as HealthStatus),
    statusDetail: text('status_detail'),
    latencyMs: integer('latency_ms'),
    lastCheckedAt: text('last_checked_at'),
    createdAt: text('created_at').notNull().default(nowIso),
  },
  (table) => [check('connections_config_json', sql`json_valid(${table.config})`)],
);

/** A local git repository, identified by its top folder. Branch and dirty state are read from git, never stored. */
export const repos = sqliteTable('repos', {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  path: text().notNull().unique(),
  host: text().$type<GitHost>().notNull(),
  /** `owner/name` on the host; null for local. */
  remoteSlug: text('remote_slug'),
  defaultBranch: text('default_branch').notNull(),
  createdAt: text('created_at').notNull().default(nowIso),
});
