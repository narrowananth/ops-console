import { z } from 'zod';

export enum ErrorCode {
  ValidationFailed = 'validation_failed',
  Unauthorized = 'unauthorized',
  NotFound = 'not_found',
  InvalidState = 'invalid_state',
  Duplicate = 'duplicate',
  RateLimited = 'rate_limited',
  UpstreamFailed = 'upstream_failed',
  Internal = 'internal',
  SessionBusy = 'session_busy',
  ConnectorNotConnected = 'connector_not_connected',
  NotARepo = 'not_a_repo',
  RepoHasSessions = 'repo_has_sessions',
  ServiceUnlinked = 'service_unlinked',
  ConnectionNoAccess = 'connection_no_access',
}

export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;
