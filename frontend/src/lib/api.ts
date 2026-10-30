import { errorBodySchema } from '@ops-console/shared';
import type { z } from 'zod';
import { sessionToken } from './session';

/** The daemon answered with an error envelope; branch on `code`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Nothing answered, or something other than the daemon did (a dev proxy with no backend). */
export class DaemonUnreachableError extends Error {}

export async function apiGet<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${sessionToken() ?? ''}` } });
  } catch {
    throw new DaemonUnreachableError('no answer from the daemon');
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) return schema.parse(body);
  const error = errorBodySchema.safeParse(body);
  if (!error.success) throw new DaemonUnreachableError(`HTTP ${response.status} without an error body`);
  throw new ApiError(response.status, error.data.error.code, error.data.error.message);
}
