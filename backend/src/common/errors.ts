import { ErrorCode } from '@ops-console/shared';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function validationFailed(message: string): ApiError {
  return new ApiError(400, ErrorCode.ValidationFailed, message);
}

/** Parses an incoming body, query or params once; failures name the offending fields. */
export function parseInput<T extends z.ZodType>(
  schema: T,
  value: unknown,
  where: 'body' | 'query' | 'params',
): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || where))];
  throw validationFailed(`invalid ${where}: ${fields.join(', ')}`);
}
