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
  KeychainTimeout = 'keychain_timeout',
  BranchMoved = 'branch_moved',
  SkillNotFound = 'skill_not_found',
  ReadOnly = 'read_only',
  BrowserNotAvailable = 'browser_not_available',
  UrlNotAllowed = 'url_not_allowed',
  ChromeMissing = 'chrome_missing',
  NothingLoaded = 'nothing_loaded',
  FolderNotFound = 'folder_not_found',
  ToolMissing = 'tool_missing',
  LogGroupNotFound = 'log_group_not_found',
  DuplicateService = 'duplicate_service',
  /** A Connector signed in sees several accounts or data sources and none is picked. */
  PickRequired = 'pick_required',
}

export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;
