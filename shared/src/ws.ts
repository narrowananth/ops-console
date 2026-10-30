import { z } from 'zod';

/** First WebSocket subprotocol; the session token is the second. */
export const WS_PROTOCOL = 'ops-console';
export const WS_PATH = '/ws';

export const wsEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('settings.updated'),
    at: z.string(),
    data: z.object({ keys: z.array(z.string()) }),
  }),
]);

export type WsEvent = z.infer<typeof wsEventSchema>;
export type WsEventName = WsEvent['event'];
export type WsEventData<E extends WsEventName> = Extract<WsEvent, { event: E }>['data'];
