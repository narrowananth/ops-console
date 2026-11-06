import { z } from 'zod';
import { CheckTarget, HealthStatus } from './mcp';

/** The two pages whose checks run on their own: Connections, and Integrations (Connectors and MCP servers). */
export enum HealthArea {
  Connections = 'connections',
  Integrations = 'integrations',
}

/** How often an area checks itself. */
export enum HealthInterval {
  HalfHour = '30m',
  Hour = '1h',
  SixHours = '6h',
  TwelveHours = '12h',
  Day = '24h',
  Off = 'off',
}

/** An interval kept before the list was 30 minutes and up reads as the shortest one now offered. */
const interval = z.preprocess(
  (value) => (value === '5m' || value === '15m' ? HealthInterval.HalfHour : value),
  z.enum(HealthInterval),
);

/** The `health_checks` setting: one interval per area. */
export const healthChecksSettingSchema = z.object({
  connections: interval,
  integrations: interval,
});

export type HealthChecksSetting = z.infer<typeof healthChecksSettingSchema>;

export const HEALTH_CHECKS_DEFAULT: HealthChecksSetting = {
  connections: HealthInterval.HalfHour,
  integrations: HealthInterval.Hour,
};

/** One check as the history stripe keeps it. `ok` is healthy; `fail` and `auth` count as failing. */
export const healthPointSchema = z.object({ status: z.enum(HealthStatus), at: z.string() });

export const healthItemSchema = z.object({
  area: z.enum(HealthArea),
  target: z.enum(CheckTarget),
  id: z.string(),
  name: z.string(),
  /** A Connection's type, a Connector's tool, or `mcp` for an MCP server. */
  kind: z.string(),
  is_prod: z.boolean(),
  status: z.enum(HealthStatus),
  detail: z.string().nullable(),
  latency_ms: z.number().nullable(),
  last_checked_at: z.string().nullable(),
  /** When the run of failing checks it is in began; null while it is not failing. */
  failing_since: z.string().nullable(),
  /** When it answered again after failing, kept for an hour; null otherwise. */
  recovered_at: z.string().nullable(),
  /** The last 24 checks, oldest first. */
  history: z.array(healthPointSchema),
});

export type HealthItem = z.infer<typeof healthItemSchema>;

export const healthAreaStateSchema = z.object({
  interval: z.enum(HealthInterval),
  last_checked_at: z.string().nullable(),
  /** Null when the interval is `off`. */
  next_check_at: z.string().nullable(),
  /** Set while a run goes: the items done and the items it will read. */
  checking: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
});

export type HealthAreaState = z.infer<typeof healthAreaStateSchema>;

/** `GET /health-watch` */
export const healthOverviewSchema = z.object({
  areas: z.object({ connections: healthAreaStateSchema, integrations: healthAreaStateSchema }),
  items: z.array(healthItemSchema),
});

export type HealthOverview = z.infer<typeof healthOverviewSchema>;

/** Whether a status counts as something to fix. */
export const isFailing = (status: HealthStatus): boolean =>
  status === HealthStatus.Fail || status === HealthStatus.Auth;
