import { z } from 'zod';

/** How far back a Scan reads. A schedule uses its `CheckInterval`; the operator picks any of these. */
export enum ScanWindow {
  FifteenMinutes = '15m',
  Hour = '1h',
  FourHours = '4h',
  SixHours = '6h',
  HalfDay = '12h',
  Day = '24h',
  Week = '7d',
}

/** How often a Service is scanned on the schedule: the windows a schedule slot can have. */
export const CheckInterval = {
  Day: ScanWindow.Day,
  HalfDay: ScanWindow.HalfDay,
  SixHours: ScanWindow.SixHours,
} as const;

export type CheckInterval = (typeof CheckInterval)[keyof typeof CheckInterval];

/** The ranges the Monitor offers for a Scan on demand, shortest first. */
export const SCAN_RANGES: ScanWindow[] = [
  ScanWindow.FifteenMinutes,
  ScanWindow.Hour,
  ScanWindow.FourHours,
  ScanWindow.Day,
  ScanWindow.Week,
];

/** Hours each window covers. */
export const WINDOW_HOURS: Record<ScanWindow, number> = {
  [ScanWindow.FifteenMinutes]: 0.25,
  [ScanWindow.Hour]: 1,
  [ScanWindow.FourHours]: 4,
  [ScanWindow.SixHours]: 6,
  [ScanWindow.HalfDay]: 12,
  [ScanWindow.Day]: 24,
  [ScanWindow.Week]: 168,
};

export enum ScanTrigger {
  Schedule = 'schedule',
  Operator = 'operator',
}

export enum ScanStatus {
  Running = 'running',
  Ok = 'ok',
  Failed = 'failed',
  RateLimited = 'rate_limited',
}

export enum RouteState {
  Ok = 'ok',
  Failing = 'failing',
  Rapid = 'rapid',
}

export enum AlertSource {
  Scan = 'scan',
  Datadog = 'datadog',
  Sentry = 'sentry',
  Slack = 'slack',
}

/** An Alert's tier, from how fast its logs come in (Glossary: Severity). */
export enum Severity {
  High = 'high',
  Medium = 'medium',
  Low = 'low',
}

/** Highest first. */
export const SEVERITIES: Severity[] = [Severity.High, Severity.Medium, Severity.Low];

export enum AlertStatus {
  Open = 'open',
  Verifying = 'verifying',
  Verified = 'verified',
  Fixing = 'fixing',
  PrOpen = 'pr_open',
  Resolved = 'resolved',
  Dismissed = 'dismissed',
}

export enum AlertEventKind {
  Detected = 'detected',
  Regressed = 'regressed',
  VerificationStarted = 'verification_started',
  Verified = 'verified',
  VerificationFailed = 'verification_failed',
  Confirmed = 'confirmed',
  Dismissed = 'dismissed',
  Undone = 'undone',
  TicketCreated = 'ticket_created',
  FixAdvanced = 'fix_advanced',
  PrOpened = 'pr_opened',
  Resolved = 'resolved',
  Abandoned = 'abandoned',
}

export enum AlertActor {
  Scan = 'scan',
  Agent = 'agent',
  Operator = 'operator',
}

export enum RunStatus {
  Running = 'running',
  Ready = 'ready',
  Failed = 'failed',
}

export enum ReportKind {
  Bug = 'bug',
  Improvement = 'improvement',
}

export enum ReviewDecision {
  Confirmed = 'confirmed',
  Dismissed = 'dismissed',
}

export enum FixStage {
  Ticket = 'ticket',
  Branch = 'branch',
  Code = 'code',
  Tests = 'tests',
  Pr = 'pr',
}

export enum FixStatus {
  Running = 'running',
  Done = 'done',
  Failed = 'failed',
  Abandoned = 'abandoned',
}

/** The Fix's stages in the order they run. */
export const FIX_STAGES: FixStage[] = Object.values(FixStage);

/** At most this many Samples stay on an Alert, newest first. */
export const SAMPLE_LIMIT = 25;

export const sampleSchema = z.object({
  /** Datadog event id. */
  id: z.string(),
  timestamp: z.string(),
  status: z.string(),
  message: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
});

export type Sample = z.infer<typeof sampleSchema>;

export const stepSchema = z.object({
  kind: z.enum(['step', 'command', 'output', 'error', 'warning', 'result']),
  text: z.string(),
});

export type ReportStep = z.infer<typeof stepSchema>;

const replaySchema = z.object({ request: z.string(), response: z.string() });
const diffLineSchema = z.object({ sign: z.enum(['+', '-', ' ']), text: z.string() });

export const reportSchema = z.object({
  id: z.string(),
  alert_id: z.string(),
  version: z.number().int(),
  status: z.enum(RunStatus),
  kind: z.enum(ReportKind).nullable(),
  slug: z.string().nullable(),
  steps: z.array(stepSchema),
  replay: replaySchema.nullable(),
  root_cause: z.string().nullable(),
  proposed_fix: z.string().nullable(),
  diff: z.array(diffLineSchema).nullable(),
  markdown: z.string().nullable(),
  markdown_path: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});

export type Report = z.infer<typeof reportSchema>;

export const reviewSchema = z.object({
  id: z.string(),
  report_id: z.string(),
  decision: z.enum(ReviewDecision),
  kind: z.enum(ReportKind).nullable(),
  decided_at: z.string(),
  undone_at: z.string().nullable(),
});

export type Review = z.infer<typeof reviewSchema>;

export const fixSchema = z.object({
  id: z.string(),
  review_id: z.string(),
  session_id: z.string().nullable(),
  stage: z.enum(FixStage),
  status: z.enum(FixStatus),
  jira_key: z.string().nullable(),
  jira_url: z.string().nullable(),
  branch: z.string().nullable(),
  pr_number: z.number().int().nullable(),
  pr_url: z.string().nullable(),
  error_message: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

export type Fix = z.infer<typeof fixSchema>;

export const alertSchema = z.object({
  id: z.string(),
  /** The HTTP Route the logs name; null for logs with no request, such as a worker's. */
  route: z.object({ id: z.string(), method: z.string(), path: z.string() }).nullable(),
  service: z.object({
    id: z.string(),
    name: z.string(),
    env: z.string(),
    repo_id: z.string().nullable(),
    repo_url: z.string().nullable(),
  }),
  fingerprint: z.string(),
  /** The HTTP status code its logs answered with; null for an Alert from before Scans read status codes. */
  http_status: z.number().int().nullable(),
  source: z.enum(AlertSource),
  severity: z.enum(Severity),
  status: z.enum(AlertStatus),
  title: z.string(),
  log_line: z.string(),
  event_count: z.number().int(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  resolved_at: z.string().nullable(),
  regression_count: z.number().int(),
  /** When the Alert entered `verified`; null in any other status. */
  waiting_since: z.string().nullable(),
  datadog_query: z.string(),
  /** The Session the Verification and Fix run in, once there is one. */
  session_id: z.string().nullable(),
});

export type Alert = z.infer<typeof alertSchema>;

export const alertDetailSchema = alertSchema.extend({
  samples: z.array(sampleSchema),
  latest_report: reportSchema.nullable(),
  review: reviewSchema.nullable(),
  fix: fixSchema.nullable(),
});

export type AlertDetail = z.infer<typeof alertDetailSchema>;

export const alertEventSchema = z.object({
  id: z.string(),
  alert_id: z.string(),
  kind: z.enum(AlertEventKind),
  actor: z.enum(AlertActor),
  data: z.record(z.string(), z.unknown()),
  at: z.string(),
});

export type AlertEvent = z.infer<typeof alertEventSchema>;

export const routeViewSchema = z.object({
  id: z.string(),
  method: z.string(),
  path: z.string(),
  ignored: z.boolean(),
  note: z.string().nullable(),
  /** From the newest Scan that saw the Route; null before any. */
  state: z.enum(RouteState).nullable(),
  /** Error counts of the last Scans, oldest first. */
  trend: z.array(z.number().int()),
});

export type RouteView = z.infer<typeof routeViewSchema>;

export const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  env: z.string(),
  repo_id: z.string().nullable(),
  /** Where the code lives on its Git host, for a Service with no local Repo. */
  repo_url: z.string().nullable(),
  check_interval: z.enum(CheckInterval).nullable(),
  created_at: z.string(),
  routes: z.array(routeViewSchema),
  open_alert_count: z.number().int(),
  last_scan_at: z.string().nullable(),
});

export type Service = z.infer<typeof serviceSchema>;

export const scanSchema = z.object({
  id: z.string(),
  triggered_by: z.enum(ScanTrigger),
  service_id: z.string().nullable(),
  window_size: z.enum(ScanWindow),
  /** The Datadog environments read. */
  envs: z.array(z.string()),
  /** The Datadog Services read; null for every Service with failing requests. */
  services: z.array(z.string()).nullable(),
  /** The HTTP status codes read; empty for every code from 400 up. */
  status_codes: z.array(z.number().int()),
  status: z.enum(ScanStatus),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

export type Scan = z.infer<typeof scanSchema>;

export const scanDetailSchema = scanSchema.extend({
  results: z.array(z.object({ route_id: z.string(), error_count: z.number().int(), state: z.enum(RouteState) })),
});

export const servicesQuerySchema = z.object({ env: z.string().min(1).optional() });

/** `github.com/acme/orders`, with or without a scheme or `.git`; an SSH remote is kept as written. */
export const repoUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^(?:https?:\/\/|git@|ssh:\/\/)?[\w.-]+\.[a-z]{2,}[/:][\w.~-]+\/[\w.~/-]+$/i, 'not a Git URL');

export const patchServiceSchema = z.strictObject({
  repo_id: z.string().min(1).nullable().optional(),
  repo_url: repoUrlSchema.nullable().optional(),
  check_interval: z.enum(CheckInterval).nullable().optional(),
});

/** What `POST /services/:id/code` looked at, and the Service after it. */
export const findCodeResultSchema = z.object({
  service: serviceSchema,
  /** `repo`: a local Repo is linked; `url`: a Git URL is set; null: nothing found. */
  found: z.enum(['repo', 'url']).nullable(),
  /** Each place looked, in order; empty when the Service already had its code. */
  tried: z.array(z.string()),
});

export type FindCodeResult = z.infer<typeof findCodeResultSchema>;

export const patchRouteSchema = z.strictObject({
  ignored: z.boolean().optional(),
  note: z.string().trim().nullable().optional(),
});

export const scansQuerySchema = z.object({ service_id: z.string().min(1).optional() });

export const createScanSchema = z.strictObject({
  service_id: z.string().min(1).nullable(),
  /** Defaults to the Datadog Connector's `default_interval`. */
  window: z.enum(ScanWindow).optional(),
  /** Defaults to every env Datadog has logs for, and the logs with no env tag. */
  envs: z.array(z.string().trim().min(1)).min(1).optional(),
  /** Datadog Service names to read; every Service with failing requests when left out. */
  services: z.array(z.string().trim().min(1)).min(1).optional(),
  /** HTTP status codes to read, each 400 or more; every one from 400 up when left out or empty. */
  status_codes: z.array(z.number().int().min(400).max(999)).optional(),
});

export type CreateScan = z.infer<typeof createScanSchema>;

/**
 * The env a Monitor shows for logs that carry no `env` tag. Datadog tags hold no spaces, so no real env has this name.
 */
export const NO_ENV = 'no env';

/** A Service Datadog has failing requests for (HTTP status 400 or more) in the range and codes asked about. */
export const datadogServiceSchema = z.object({
  name: z.string(),
  /** The envs it logged them in, busiest first. */
  envs: z.array(z.string()),
  /** Failing requests in the range, every env together. */
  errors: z.number().int(),
});

export type DatadogService = z.infer<typeof datadogServiceSchema>;

const commaList = z.string().transform((value) => [
  ...new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ),
]);

/** HTTP status codes from 400 up, comma-separated. */
const codeList = commaList.transform((list) => list.map(Number)).pipe(z.array(z.number().int().min(400).max(999)));

export const datadogServicesQuerySchema = z.object({
  window: z.enum(ScanWindow),
  /** Comma-separated env names; every env when left out. */
  envs: commaList.pipe(z.array(z.string()).min(1)).optional(),
  /** Comma-separated HTTP status codes; every code from 400 up when left out. */
  codes: codeList.optional(),
});

export const statusCodesQuerySchema = z.object({ window: z.enum(ScanWindow) });

/** An HTTP status code from 400 up that Datadog has requests for in the range, every env together. */
export const statusCodeCountSchema = z.object({ code: z.number().int(), count: z.number().int() });

export type StatusCodeCount = z.infer<typeof statusCodeCountSchema>;

/** A Datadog `env` tag the Monitor can scan. */
export const monitorEnvSchema = z.object({
  name: z.string(),
  /** In the Datadog Connector's `environments`: ticked by default. */
  configured: z.boolean(),
});

export type MonitorEnv = z.infer<typeof monitorEnvSchema>;

export const alertsQuerySchema = z.object({
  status: z.enum(AlertStatus).optional(),
  service_id: z.string().min(1).optional(),
  severity: z.enum(Severity).optional(),
});

export const reviewAlertSchema = z
  .strictObject({
    decision: z.enum(ReviewDecision),
    kind: z.enum(ReportKind).nullable(),
  })
  .refine((body) => (body.decision === ReviewDecision.Confirmed) === (body.kind !== null), {
    message: 'kind is required to confirm and must be null to dismiss',
    path: ['kind'],
  });

export type ReviewAlert = z.infer<typeof reviewAlertSchema>;

/** The words that confirm a `verified` Alert from its Session (Behavior 20). */
export const CONFIRM_WORDS = ['go', 'yes', 'start', 'do it', 'ok'];
