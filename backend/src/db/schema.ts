import {
  type AccessLevel,
  type AccessMode,
  type ActionActor,
  type ActionKind,
  ActionOutcome,
  type AgentReviewStatus,
  type AlertActor,
  type AlertEventKind,
  type AlertSource,
  type AlertStatus,
  type ApprovalKind,
  ApprovalStatus,
  type CheckInterval,
  type CommentPassKind,
  type ConnectionEnv,
  type ConnectionType,
  type ConnectorId,
  type Effort,
  type FixStage,
  type FixStatus,
  type GitHost,
  type HealthStatus,
  type McpScope,
  type McpTransport,
  type Model,
  type PlaybookStepStatus,
  type PlaybookTrigger,
  type ReplyVerdict,
  type ReportKind,
  type ReviewDecision,
  type ReviewVerdict,
  type RouteState,
  type RunOutcome,
  type RunPhase,
  type RunStatus,
  type ScanStatus,
  type ScanTrigger,
  type ScanWindow,
  type SessionKind,
  SessionState,
  type Severity,
  type SubagentStatus,
} from '@ops-console/shared';
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** The Playbook a job ran, as copied at start. `playbook_id` is null for a built-in and once the Playbook is deleted. */
function jobPlaybookColumns() {
  return {
    playbookId: text('playbook_id').references((): AnySQLiteColumn => playbooks.id, { onDelete: 'set null' }),
    playbookName: text('playbook_name'),
    playbookRules: text('playbook_rules'),
    /** JSON array of the Skills offered, each `{ id, name, description, instructions }`; null for none. */
    playbookSkills: text('playbook_skills'),
  };
}

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
    /** A disabled account stays signed in, but no run starts or moves onto it. */
    enabled: bool('enabled').notNull().default(true),
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
    /** `repo` and `pr_review` Sessions run in a Repo; the service enforces which kind has which column. */
    repoId: text('repo_id').references((): AnySQLiteColumn => repos.id, { onDelete: 'restrict' }),
    branch: text(),
    prNumber: integer('pr_number'),
    /** The Alert a Verification or Fix runs for. */
    alertId: text('alert_id').references((): AnySQLiteColumn => alerts.id, { onDelete: 'set null' }),
    state: text().$type<SessionState>().notNull().default(SessionState.Idle),
    lastMessagePreview: text('last_message_preview'),
    /** The last run's start, end and outcome; null outcome while the first run goes or once the operator dismissed it. */
    runStartedAt: text('run_started_at'),
    runFinishedAt: text('run_finished_at'),
    runOutcome: text('run_outcome').$type<RunOutcome>(),
    /** JSON array of the last run's `Subagent`s. */
    runSubagents: text('run_subagents'),
    /** When the last run began to wait on the account's usage limit, and when the window resets (ISO). */
    runLimitSince: text('run_limit_since'),
    runLimitResetsAt: text('run_limit_resets_at'),
    /** The message the operator queued behind the run; the daemon sends it when the run ends, unless the operator stopped it. */
    queuedText: text('queued_text'),
    createdAt: text('created_at').notNull().default(nowIso),
    lastActiveAt: text('last_active_at').notNull().default(nowIso),
  },
  (table) => [
    index('sessions_active_idx').on(sql`${table.lastActiveAt} DESC`),
    index('sessions_repo_idx').on(table.repoId, sql`${table.lastActiveAt} DESC`),
    uniqueIndex('sessions_one_pr_review_idx').on(table.repoId, table.prNumber).where(sql`${table.kind} = 'pr_review'`),
  ],
);

/** One check of a Connection, Connector or MCP server, kept for the history stripe and to tell a break from a recovery. */
export const healthChecks = sqliteTable(
  'health_checks',
  {
    id: text().primaryKey().notNull(),
    /** `CheckTarget`. */
    target: text().notNull(),
    targetId: text('target_id').notNull(),
    /** `HealthStatus`: `ok`, `fail` or `auth`. */
    status: text().notNull(),
    detail: text(),
    latencyMs: integer('latency_ms'),
    checkedAt: text('checked_at').notNull(),
  },
  (table) => [
    index('health_checks_target_idx').on(table.target, table.targetId, table.checkedAt),
    // Retention deletes the oldest rows first.
    index('health_checks_checked_idx').on(table.checkedAt),
  ],
);

/** One tool call of a run, kept so the Agent runs page can say where the time went and what was slow. */
export const runSteps = sqliteTable(
  'run_steps',
  {
    /** The SDK's tool call id. */
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The run's start (`sessions.run_started_at`), which ties the step to its run. */
    runStartedAt: text('run_started_at').notNull(),
    /** The subagent that made the call; null for the main agent. */
    agentId: text('agent_id'),
    tool: text().notNull(),
    /** Redacted. */
    summary: text().notNull(),
    phase: text().$type<RunPhase>().notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    /** Time the call spent waiting for an Approval or an answer. */
    waitedMs: integer('waited_ms').notNull().default(0),
    ok: bool('ok'),
    /** Redacted. */
    error: text(),
  },
  (table) => [
    index('run_steps_session_idx').on(table.sessionId, table.startedAt),
    // Retention deletes the oldest steps first, in small batches.
    index('run_steps_started_idx').on(table.startedAt),
  ],
);

/** One subagent a run started, kept after the run so account usage can say what each subagent did and how it ended. */
export const runAgents = sqliteTable(
  'run_agents',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The run's start (`sessions.run_started_at`), which ties the subagent to its run. */
    runStartedAt: text('run_started_at').notNull(),
    /** The SDK's task id; the `agent_id` of this subagent's steps and usage lines. */
    taskId: text('task_id').notNull(),
    /** The subagent that started this one; null when the main agent did. */
    parentId: text('parent_id'),
    type: text(),
    /** Redacted, cut to 200 characters. */
    description: text().notNull(),
    status: text().$type<SubagentStatus>().notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (table) => [
    unique('run_agents_task').on(table.sessionId, table.runStartedAt, table.taskId),
    index('run_agents_started_idx').on(table.startedAt),
  ],
);

/** What each run used: raw token counts per agent and model, and the cost the SDK reported. */
export const runUsage = sqliteTable(
  'run_usage',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    runStartedAt: text('run_started_at').notNull(),
    finishedAt: text('finished_at').notNull(),
    /** The account the run ended on; null for CLIProxy and for runs kept before this column. No key: a removed account's runs stay. */
    accountId: text('account_id'),
    /** What the run was for (`RunPurpose`); null for a run kept before purposes were recorded. */
    purpose: text(),
    /** What the SDK reported; the page prices the raw tokens in `breakdown` itself. */
    costUsd: real('cost_usd').notNull(),
    /** Every token of the run: input, output, cache read and cache write. */
    tokens: integer().notNull(),
    /** JSON array of `UsageLine`: raw token counts per agent and model. Null for a run kept before they were. */
    breakdown: text(),
  },
  (table) => [
    index('run_usage_finished_idx').on(table.finishedAt),
    index('run_usage_account_idx').on(table.accountId, table.finishedAt),
    unique('run_usage_run').on(table.sessionId, table.runStartedAt),
  ],
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
    alertId: text('alert_id').references((): AnySQLiteColumn => alerts.id, { onDelete: 'set null' }),
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
  /** Set when the operator removed it and kept its Sessions; importing the folder again clears it. */
  removedAt: text('removed_at'),
});

/** Hosts the operator added to the Network allowlist: a hostname, or `*.` and a hostname, lowercase. */
export const networkDomains = sqliteTable('network_domains', {
  domain: text().primaryKey().notNull(),
  createdAt: text('created_at').notNull().default(nowIso),
});

/** The agent's written review of a pull request, tied to the commit it read. */
export const prAgentReviews = sqliteTable(
  'pr_agent_reviews',
  {
    id: text().primaryKey().notNull(),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    status: text()
      .$type<AgentReviewStatus>()
      .notNull()
      .default('running' as AgentReviewStatus),
    decision: text().$type<ReviewVerdict>(),
    verdict: text(),
    /** The production branch the change was compared with, and its commit then. */
    baseBranch: text('base_branch'),
    baseSha: text('base_sha'),
    /** What the operator told the agent when starting the review; null when empty. */
    note: text(),
    /** The full review as Markdown. */
    report: text(),
    /** Why a failed review stopped, for the operator. */
    error: text(),
    findings: text().notNull().default('[]'),
    checklist: text().notNull().default('[]'),
    tools: text().notNull().default('[]'),
    createdAt: text('created_at').notNull().default(nowIso),
    /** When the latest attempt began: a retry starts the clock again. Null until the first retry: then `created_at`. */
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    ...jobPlaybookColumns(),
  },
  (table) => [
    index('pr_agent_reviews_pr_idx').on(table.repoId, table.prNumber, sql`${table.createdAt} DESC`),
    check('pr_agent_reviews_findings_json', sql`json_valid(${table.findings})`),
    check('pr_agent_reviews_checklist_json', sql`json_valid(${table.checklist})`),
    check('pr_agent_reviews_tools_json', sql`json_valid(${table.tools})`),
  ],
);

/** One Reply check: the agent's verdict on one pull request thread. */
export const prReplyChecks = sqliteTable(
  'pr_reply_checks',
  {
    id: text().primaryKey().notNull(),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    /** The thread's root comment on the Git host. */
    commentId: text('comment_id').notNull(),
    headSha: text('head_sha').notNull(),
    status: text()
      .$type<AgentReviewStatus>()
      .notNull()
      .default('running' as AgentReviewStatus),
    verdict: text().$type<ReplyVerdict>(),
    reply: text(),
    /** Set once the reply is on the host; a retry does not post it again. */
    replyCommentId: text('reply_comment_id'),
    resolved: bool('resolved').notNull().default(false),
    error: text(),
    canRetry: bool('can_retry').notNull().default(false),
    /** The scratch copy's folder; null once removed. */
    scratchPath: text('scratch_path'),
    createdAt: text('created_at').notNull().default(nowIso),
    /** When the latest attempt began: a retry starts the clock again. Null until the first retry: then `created_at`. */
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    ...jobPlaybookColumns(),
  },
  (table) => [
    index('pr_reply_checks_thread_idx').on(table.repoId, table.prNumber, table.commentId, sql`${table.createdAt} DESC`),
    check('pr_reply_checks_status', sql`${table.status} IN ('running', 'ready', 'failed')`),
    check('pr_reply_checks_verdict', sql`${table.verdict} IN ('fixed', 'partly_fixed', 'not_fixed')`),
  ],
);

/** One Comment pass over the threads the operator ticked on a pull request. */
export const prCommentPasses = sqliteTable(
  'pr_comment_passes',
  {
    id: text().primaryKey().notNull(),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    branch: text().notNull(),
    /** Address comments changes code and pushes; Check replies only gives each replied thread a verdict. */
    kind: text()
      .$type<CommentPassKind>()
      .notNull()
      .default('address' as CommentPassKind),
    status: text()
      .$type<AgentReviewStatus>()
      .notNull()
      .default('running' as AgentReviewStatus),
    /** Where a retry picks up: the steps and closing turn, the commit and push, or the replies and resolves. */
    stage: text().$type<'steps' | 'push' | 'post'>().notNull().default('steps'),
    /** Null until pushed, and when there was nothing to commit. */
    commitSha: text('commit_sha'),
    /** `PassThread[]` without `posted`, plus the reply's comment id once on the host. */
    threads: text().notNull(),
    error: text(),
    canRetry: bool('can_retry').notNull().default(false),
    scratchPath: text('scratch_path'),
    createdAt: text('created_at').notNull().default(nowIso),
    /** When the latest attempt began: a retry starts the clock again. Null until the first retry: then `created_at`. */
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    ...jobPlaybookColumns(),
  },
  (table) => [
    index('pr_comment_passes_pr_idx').on(table.repoId, table.prNumber, sql`${table.createdAt} DESC`),
    check('pr_comment_passes_status', sql`${table.status} IN ('running', 'ready', 'failed')`),
    check('pr_comment_passes_stage', sql`${table.stage} IN ('steps', 'push', 'post')`),
    check('pr_comment_passes_threads_json', sql`json_valid(${table.threads})`),
  ],
);

/** Comments the agent posted on the Git host. Everything else about a pull request's comments comes from the host. */
export const agentComments = sqliteTable(
  'agent_comments',
  {
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    /** The host's comment id. */
    commentId: text('comment_id').notNull(),
    /** Null for a thread reply. */
    agentReviewId: text('agent_review_id').references(() => prAgentReviews.id, { onDelete: 'set null' }),
    postedAt: text('posted_at').notNull().default(nowIso),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.prNumber, table.commentId] })],
);

/** A Datadog service in one env. Found by a Scan; the operator links it to a Repo. */
export const services = sqliteTable(
  'services',
  {
    id: text().primaryKey().notNull(),
    /** Datadog service name. */
    name: text().notNull(),
    /** Datadog env tag. */
    env: text().notNull(),
    repoId: text('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    /** The Git host URL of the code: from the logs' `git.repository_url` tag, or set by the operator. */
    repoUrl: text('repo_url'),
    /** Null: the Datadog Connector's default. */
    checkInterval: text('check_interval').$type<CheckInterval>(),
    createdAt: text('created_at').notNull().default(nowIso),
  },
  (table) => [unique('services_name_env').on(table.name, table.env)],
);

export const routes = sqliteTable(
  'routes',
  {
    id: text().primaryKey().notNull(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    method: text().notNull(),
    path: text().notNull(),
    ignored: bool('ignored').notNull().default(false),
    /** Why it is ignored or expected to fail. */
    note: text(),
  },
  (table) => [
    unique('routes_service_method_path').on(table.serviceId, table.method, table.path),
    check('routes_ignored_bool', sql`${table.ignored} IN (0, 1)`),
  ],
);

export const scans = sqliteTable(
  'scans',
  {
    id: text().primaryKey().notNull(),
    triggeredBy: text('triggered_by').$type<ScanTrigger>().notNull(),
    /** Null: every Service. */
    serviceId: text('service_id').references(() => services.id, { onDelete: 'cascade' }),
    windowSize: text('window_size').$type<ScanWindow>().notNull(),
    /** JSON array of the Datadog environments read. */
    envs: text().notNull().default('[]'),
    /** JSON array of the Datadog Service names read; null for every Service with failing requests. */
    services: text(),
    /** JSON array of the HTTP status codes read; empty for every code from 400 up. */
    statusCodes: text('status_codes').notNull().default('[]'),
    status: text()
      .$type<ScanStatus>()
      .notNull()
      .default('running' as ScanStatus),
    /** `interrupted` when the daemon stopped mid-Scan. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: text('started_at').notNull().default(nowIso),
    finishedAt: text('finished_at'),
  },
  (table) => [
    index('scans_started_idx').on(sql`${table.startedAt} DESC`),
    index('scans_service_idx').on(table.serviceId, sql`${table.startedAt} DESC`),
  ],
);

export const scanRouteResults = sqliteTable(
  'scan_route_results',
  {
    scanId: text('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    routeId: text('route_id')
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    scannedAt: text('scanned_at').notNull(),
    errorCount: integer('error_count').notNull(),
    state: text().$type<RouteState>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scanId, table.routeId] }),
    index('scan_route_results_route_idx').on(table.routeId, sql`${table.scannedAt} DESC`),
  ],
);

/** One per Fingerprint. Its status moves only through the Verification, Review and Fix flows. */
export const alerts = sqliteTable(
  'alerts',
  {
    id: text().primaryKey().notNull(),
    routeId: text('route_id')
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    fingerprint: text().notNull().unique(),
    /** The HTTP status code its logs answered with; null for Alerts from before Scans read codes. */
    httpStatus: integer('http_status'),
    source: text()
      .$type<AlertSource>()
      .notNull()
      .default('scan' as AlertSource),
    severity: text().$type<Severity>().notNull(),
    status: text()
      .$type<AlertStatus>()
      .notNull()
      .default('open' as AlertStatus),
    title: text().notNull(),
    /** Message of the newest Sample. */
    logLine: text('log_line').notNull(),
    eventCount: integer('event_count').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    resolvedAt: text('resolved_at'),
    /** The latest Scan that covered the Alert's Service and did not see it: a healthy sighting. */
    clearedAt: text('cleared_at'),
    regressionCount: integer('regression_count').notNull().default(0),
    samples: text().notNull().default('[]'),
    datadogQuery: text('datadog_query').notNull(),
    createdAt: text('created_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso),
  },
  (table) => [
    index('alerts_status_idx').on(table.status, sql`${table.lastSeenAt} DESC`),
    index('alerts_route_idx').on(table.routeId),
    check(
      'alerts_samples_json',
      sql`json_valid(${table.samples}) AND json_type(${table.samples}) = 'array' AND json_array_length(${table.samples}) <= 25`,
    ),
  ],
);

export const alertEvents = sqliteTable(
  'alert_events',
  {
    id: text().primaryKey().notNull(),
    alertId: text('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    kind: text().$type<AlertEventKind>().notNull(),
    actor: text().$type<AlertActor>().notNull(),
    data: text().notNull().default('{}'),
    at: text().notNull().default(nowIso),
  },
  (table) => [
    index('alert_events_alert_idx').on(table.alertId, table.at),
    check('alert_events_data_json', sql`json_valid(${table.data})`),
  ],
);

export const reports = sqliteTable(
  'reports',
  {
    id: text().primaryKey().notNull(),
    alertId: text('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    status: text()
      .$type<RunStatus>()
      .notNull()
      .default('running' as RunStatus),
    /** The agent's recommendation. */
    kind: text().$type<ReportKind>(),
    /** Short name; ends the fix branch. */
    slug: text(),
    /** The Verification's agent run. */
    sdkSessionId: text('sdk_session_id'),
    steps: text().notNull().default('[]'),
    replay: text(),
    rootCause: text('root_cause'),
    proposedFix: text('proposed_fix'),
    diff: text(),
    markdown: text(),
    /** Set once the Report file is written. */
    markdownPath: text('markdown_path'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull().default(nowIso),
    /** When the latest attempt began: a retry starts the clock again. Null until the first retry: then `created_at`. */
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    ...jobPlaybookColumns(),
    /** The Playbook's Branch field as copied at start: where the code is read from. Null before Branch. */
    playbookBranches: text('playbook_branches'),
    /** The scratch copy's folder; null once removed. */
    scratchPath: text('scratch_path'),
  },
  (table) => [
    unique('reports_alert_version').on(table.alertId, table.version),
    uniqueIndex('reports_one_running_idx').on(table.alertId).where(sql`${table.status} = 'running'`),
    check('reports_steps_json', sql`json_valid(${table.steps})`),
    check('reports_replay_json', sql`${table.replay} IS NULL OR json_valid(${table.replay})`),
    check('reports_diff_json', sql`${table.diff} IS NULL OR json_valid(${table.diff})`),
  ],
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: text().primaryKey().notNull(),
    reportId: text('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    decision: text().$type<ReviewDecision>().notNull(),
    /** Set when confirmed. */
    kind: text().$type<ReportKind>(),
    decidedAt: text('decided_at').notNull().default(nowIso),
    undoneAt: text('undone_at'),
  },
  (table) => [
    uniqueIndex('reviews_one_active_idx').on(table.reportId).where(sql`${table.undoneAt} IS NULL`),
    check('reviews_kind_with_decision', sql`(${table.decision} = 'confirmed') = (${table.kind} IS NOT NULL)`),
  ],
);

export const fixes = sqliteTable('fixes', {
  id: text().primaryKey().notNull(),
  reviewId: text('review_id')
    .notNull()
    .unique()
    .references(() => reviews.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  stage: text()
    .$type<FixStage>()
    .notNull()
    .default('ticket' as FixStage),
  status: text()
    .$type<FixStatus>()
    .notNull()
    .default('running' as FixStatus),
  jiraKey: text('jira_key'),
  jiraUrl: text('jira_url'),
  /** Why the ticket stage went on without a ticket while Jira was connected; null otherwise. */
  ticketSkipped: text('ticket_skipped'),
  /** `<jira_key>-<slug>`, set with the key; `fix/<slug>` without a ticket. */
  branch: text(),
  prNumber: integer('pr_number'),
  prUrl: text('pr_url'),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull().default(nowIso),
  finishedAt: text('finished_at'),
  ...jobPlaybookColumns(),
  /** The Playbook's Branch field as copied at start: where the code is read from. Null before Branch. */
  playbookBranches: text('playbook_branches'),
  /** The Playbook's Jira ticket switch as copied at start. */
  playbookJiraTicket: bool('playbook_jira_ticket').notNull().default(false),
});

/** The Connections a `devtools` Session may reach. No rows: every Connection with access. */
export const sessionConnections = sqliteTable(
  'session_connections',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.connectionId] })],
);

export const playbooks = sqliteTable(
  'playbooks',
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    rules: text().notNull().default(''),
    /** Comma-separated branches Verify and Fix read the code from, first one origin has; blank: the default. */
    branches: text().notNull().default(''),
    /** Fix makes a Jira ticket first, when Jira is connected. */
    jiraTicket: bool('jira_ticket').notNull().default(false),
    /** `[{ block, title, instructions, writes }]`. */
    steps: text().notNull().default('[]'),
    createdAt: text('created_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso),
  },
  (table) => [
    uniqueIndex('playbooks_name_idx').on(sql`${table.name} COLLATE NOCASE`),
    check('playbooks_steps_json', sql`json_valid(${table.steps})`),
  ],
);

/** A named instruction document the operator attaches to Playbooks; the agent loads it when a step needs it. */
export const skills = sqliteTable(
  'skills',
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    instructions: text().notNull(),
    createdAt: text('created_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso),
  },
  (table) => [uniqueIndex('skills_name_idx').on(sql`${table.name} COLLATE NOCASE`)],
);

/** The Skills each Playbook holds. */
export const playbookSkills = sqliteTable(
  'playbook_skills',
  {
    playbookId: text('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.playbookId, table.skillId] }),
    index('playbook_skills_skill_idx').on(table.skillId),
  ],
);

/** The Skill packs the operator installed. The catalog of packs lives in code. */
export const installedSkillPacks = sqliteTable('installed_skill_packs', {
  packId: text('pack_id').primaryKey().notNull(),
  installedAt: text('installed_at').notNull().default(nowIso),
});

/** The Built-in skills each Playbook holds; the skill's text is in the catalog. */
export const playbookBuiltinSkills = sqliteTable(
  'playbook_builtin_skills',
  {
    playbookId: text('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),
    packId: text('pack_id').notNull(),
    skillName: text('skill_name').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.playbookId, table.packId, table.skillName] }),
    index('playbook_builtin_skills_pack_idx').on(table.packId),
  ],
);

/**
 * The skill a Session message was sent with. The transcript keeps only the prompt the agent got, so a row holds that
 * prompt to find its message again, and the text the operator typed to show in its place.
 */
export const messageSkills = sqliteTable(
  'message_skills',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    prompt: text().notNull(),
    typed: text().notNull(),
    kind: text().$type<'builtin' | 'custom' | 'project'>().notNull(),
    name: text().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('message_skills_session_idx').on(table.sessionId, table.createdAt),
    check('message_skills_kind', sql`${table.kind} IN ('builtin', 'custom', 'project')`),
  ],
);

/** Which Playbook each Trigger holds. No row: the built-in. */
export const playbookTriggers = sqliteTable(
  'playbook_triggers',
  {
    trigger: text().$type<PlaybookTrigger>().primaryKey().notNull(),
    playbookId: text('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('playbook_triggers_playbook_idx').on(table.playbookId),
    check(
      'playbook_triggers_trigger',
      sql`${table.trigger} IN ('verify', 'fix', 'review_pr', 'check_reply', 'address_comments', 'thread_reply', 'session_message')`,
    ),
  ],
);

/** A job's copy of its Playbook's steps and how each went. Exactly one job column is set. */
export const playbookSteps = sqliteTable(
  'playbook_steps',
  {
    id: text().primaryKey().notNull(),
    reportId: text('report_id').references(() => reports.id, { onDelete: 'cascade' }),
    fixId: text('fix_id').references(() => fixes.id, { onDelete: 'cascade' }),
    agentReviewId: text('agent_review_id').references(() => prAgentReviews.id, { onDelete: 'cascade' }),
    replyCheckId: text('reply_check_id').references(() => prReplyChecks.id, { onDelete: 'cascade' }),
    commentPassId: text('comment_pass_id').references(() => prCommentPasses.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    title: text().notNull(),
    instructions: text().notNull(),
    writes: bool('writes').notNull().default(false),
    status: text()
      .$type<PlaybookStepStatus>()
      .notNull()
      .default('pending' as PlaybookStepStatus),
    summary: text(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (table) => [
    uniqueIndex('playbook_steps_report_idx')
      .on(table.reportId, table.position)
      .where(sql`${table.reportId} IS NOT NULL`),
    uniqueIndex('playbook_steps_fix_idx').on(table.fixId, table.position).where(sql`${table.fixId} IS NOT NULL`),
    uniqueIndex('playbook_steps_review_idx')
      .on(table.agentReviewId, table.position)
      .where(sql`${table.agentReviewId} IS NOT NULL`),
    uniqueIndex('playbook_steps_reply_check_idx')
      .on(table.replyCheckId, table.position)
      .where(sql`${table.replyCheckId} IS NOT NULL`),
    uniqueIndex('playbook_steps_comment_pass_idx')
      .on(table.commentPassId, table.position)
      .where(sql`${table.commentPassId} IS NOT NULL`),
    check('playbook_steps_status', sql`${table.status} IN ('pending', 'running', 'done', 'skipped', 'failed')`),
    check(
      'playbook_steps_one_job',
      sql`(${table.reportId} IS NOT NULL) + (${table.fixId} IS NOT NULL) + (${table.agentReviewId} IS NOT NULL) + (${table.replyCheckId} IS NOT NULL) + (${table.commentPassId} IS NOT NULL) = 1`,
    ),
    check('playbook_steps_writes_bool', sql`${table.writes} IN (0, 1)`),
  ],
);
