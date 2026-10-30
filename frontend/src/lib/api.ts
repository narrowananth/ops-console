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

export function apiGet<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  return request('GET', path, undefined, schema);
}

export function apiSend<T extends z.ZodType>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  schema: T,
): Promise<z.infer<T>> {
  return request(method, path, body, schema);
}

async function request<T extends z.ZodType>(
  method: string,
  path: string,
  json: unknown,
  schema: T,
): Promise<z.infer<T>> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${sessionToken() ?? ''}`,
        ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  } catch {
    throw new DaemonUnreachableError('no answer from the daemon');
  }
  if (response.status === 204) return schema.parse(undefined);
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) return schema.parse(body);
  const error = errorBodySchema.safeParse(body);
  if (!error.success) throw new DaemonUnreachableError(`HTTP ${response.status} without an error body`);
  throw new ApiError(response.status, error.data.error.code, error.data.error.message);
}
