import { z } from 'zod';
import {
  ActionKind,
  ActionOutcome,
  ApprovalKind,
  ApprovalStatus,
  partSchema,
  SessionState,
  SwitchReason,
} from './agents';
import { CheckTarget, HealthStatus } from './mcp';

/** First WebSocket subprotocol; the session token is the second. */
export const WS_PROTOCOL = 'ops-console';
export const WS_PATH = '/ws';

const event = <E extends string, D extends z.ZodType>(name: E, data: D) =>
  z.object({ event: z.literal(name), at: z.string(), data });

export const wsEventSchema = z.discriminatedUnion('event', [
  event('settings.updated', z.object({ keys: z.array(z.string()) })),
  event(
    'session.output',
    z.object({ session_id: z.string(), message_id: z.string(), part_index: z.number().int(), part: partSchema }),
  ),
  event(
    'session.finished',
    z.object({
      session_id: z.string(),
      message_id: z.string(),
      status: z.enum(['done', 'failed']),
      state: z.enum([SessionState.Idle, SessionState.Failed]),
      error_code: z.string().nullable(),
    }),
  ),
  event(
    'session.updated',
    z.object({
      session_id: z.string(),
      title: z.string(),
      state: z.enum(SessionState),
      account_id: z.string().nullable(),
    }),
  ),
  event(
    'approval.requested',
    z.object({
      approval_id: z.string(),
      session_id: z.string().nullable(),
      kind: z.enum(ApprovalKind),
      summary: z.string(),
      is_prod: z.boolean(),
    }),
  ),
  event(
    'approval.decided',
    z.object({
      approval_id: z.string(),
      decision: z.enum([ApprovalStatus.Approved, ApprovalStatus.Denied, ApprovalStatus.Expired]),
    }),
  ),
  event(
    'action.logged',
    z.object({
      id: z.string(),
      kind: z.enum(ActionKind),
      target: z.string(),
      is_prod: z.boolean(),
      outcome: z.enum(ActionOutcome),
    }),
  ),
  event(
    'account.updated',
    z.object({
      account_id: z.string(),
      signed_in: z.boolean(),
      five_hour_pct: z.number().nullable(),
      weekly_pct: z.number().nullable(),
      usage_seen_at: z.string().nullable(),
    }),
  ),
  event('account.removed', z.object({ account_id: z.string() })),
  event(
    'connection.checked',
    z.object({
      target: z.enum(CheckTarget),
      id: z.string(),
      status: z.enum(HealthStatus),
      detail: z.string().nullable(),
      latency_ms: z.number().nullable(),
    }),
  ),
  event(
    'account.switched',
    z.object({
      from: z.string(),
      to: z.string(),
      reason: z.enum(SwitchReason),
      five_hour_pct: z.number().nullable(),
    }),
  ),
]);

export type WsEvent = z.infer<typeof wsEventSchema>;
export type WsEventName = WsEvent['event'];
export type WsEventData<E extends WsEventName> = Extract<WsEvent, { event: E }>['data'];
