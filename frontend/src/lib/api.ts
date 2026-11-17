import { errorBodySchema } from '@ops-console/shared';
import { z } from 'zod';
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

/** How many items from each end of a trusted list are checked in full. */
const CHECKED_ENDS = 20;

/**
 * GET of a `{ data: [...] }` list the daemon builds from its own rows, for the few lists large enough that Zod's check of
 * every item holds the page's one thread for tens of milliseconds. The envelope and the first and last items are checked
 * in full, so a changed shape still fails at once; the items between are taken as the type says. Use it only for an item
 * schema with no `default`, `transform` or `coerce`, where a parsed item and a raw one are the same value.
 */
export async function apiGetTrustedList<T extends z.ZodType>(path: string, item: T): Promise<{ data: z.infer<T>[] }> {
  const body = await request('GET', path, undefined, z.object({ data: z.array(z.unknown()) }).loose());
  const { data } = body;
  const edge = (at: number) => item.parse(data[at]);
  for (let at = 0; at < Math.min(CHECKED_ENDS, data.length); at++) edge(at);
  for (let at = Math.max(CHECKED_ENDS, data.length - CHECKED_ENDS); at < data.length; at++) edge(at);
  return body as { data: z.infer<T>[] };
}

export function apiSend<T extends z.ZodType>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  schema: T,
): Promise<z.infer<T>> {
  return request(method, path, body, schema);
}

/** POSTs a file as the raw request body. */
export function apiUpload<T extends z.ZodType>(path: string, file: Blob, schema: T): Promise<z.infer<T>> {
  return request('POST', path, undefined, schema, file);
}

/** GETs a file the daemon serves, such as an attached screenshot, as bytes. */
export async function apiBlob(path: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${sessionToken() ?? ''}` } });
  } catch {
    throw new DaemonUnreachableError('no answer from the daemon');
  }
  if (response.ok) return response.blob();
  const error = errorBodySchema.safeParse(await response.json().catch(() => undefined));
  if (!error.success) throw new DaemonUnreachableError(`HTTP ${response.status} without an error body`);
  throw new ApiError(response.status, error.data.error.code, error.data.error.message);
}

async function request<T extends z.ZodType>(
  method: string,
  path: string,
  json: unknown,
  schema: T,
  file?: Blob,
): Promise<z.infer<T>> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${sessionToken() ?? ''}`,
        ...(file !== undefined
          ? { 'Content-Type': 'application/octet-stream' }
          : json === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
      },
      body: file ?? (json === undefined ? undefined : JSON.stringify(json)),
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
