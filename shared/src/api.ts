import { z } from 'zod';

export const API_PREFIX = 'api';

export const healthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  started_at: z.string(),
});

export type Health = z.infer<typeof healthSchema>;

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export type PageMeta = { next_cursor: string | null };

export type Page<T> = { data: T[]; meta: PageMeta };

/** `runtime.json` in the data folder: what the CLI needs to reach the running daemon. */
export const runtimeSchema = z.object({
  pid: z.number().int(),
  port: z.number().int(),
  version: z.string(),
  started_at: z.string(),
  token: z.string(),
});

export type Runtime = z.infer<typeof runtimeSchema>;
