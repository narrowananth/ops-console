import { z } from 'zod';

export enum McpScope {
  User = 'user',
  Project = 'project',
  Local = 'local',
}

export enum McpTransport {
  Stdio = 'stdio',
  Http = 'http',
  Sse = 'sse',
}

/** `off` only means disabled. A server's status is the worst across accounts: `fail`, then `auth`, then `ok`. */
export enum HealthStatus {
  Ok = 'ok',
  Auth = 'auth',
  Fail = 'fail',
  Off = 'off',
}

export enum CheckTarget {
  McpServer = 'mcp_server',
  Connector = 'connector',
  Connection = 'connection',
}

export enum McpAuth {
  None = 'none',
  Oauth = 'oauth',
  Headers = 'headers',
}

export const mcpServerSchema = z.object({
  name: z.string(),
  scope: z.enum(McpScope),
  /** Project scope: the Repo whose `.mcp.json` holds it. */
  repo_id: z.string().nullable(),
  transport: z.enum(McpTransport),
  /** Command or URL, without the launcher prefix. */
  target: z.string(),
  config_file: z.string(),
  auth: z.enum(McpAuth),
  status: z.enum(HealthStatus),
  status_detail: z.string().nullable(),
  /** Empty unless `ok`. */
  tools: z.array(z.string()),
  tool_count: z.number().int(),
  env_keys: z.array(z.string()),
  has_headers: z.boolean(),
  enabled: z.boolean(),
  registered: z.boolean(),
  /** Connector id. */
  used_by: z.string().nullable(),
});

export type McpServer = z.infer<typeof mcpServerSchema>;

export const mcpServerListSchema = z.object({
  data: z.array(mcpServerSchema),
  meta: z.object({ next_cursor: z.null(), connection_server_count: z.number().int() }),
});

const nameSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'letters, digits, dot, dash and underscore only');
const valuesSchema = z.record(z.string().min(1), z.string());

export const createMcpServerSchema = z.object({
  name: nameSchema,
  transport: z.enum(McpTransport),
  /** Command line for stdio, URL for http and sse. */
  target: z.string().min(1),
  scope: z.enum(McpScope),
  repo_id: z.string().optional(),
  /** stdio only; values go to the Keychain. */
  env: valuesSchema.optional(),
  /** http and sse only. */
  headers: valuesSchema.optional(),
});

export type CreateMcpServer = z.infer<typeof createMcpServerSchema>;

export const updateMcpServerSchema = z.object({
  enabled: z.boolean().optional(),
  transport: z.enum(McpTransport).optional(),
  target: z.string().min(1).optional(),
  scope: z.enum(McpScope).optional(),
  env: valuesSchema.optional(),
  headers: valuesSchema.optional(),
});

export type UpdateMcpServer = z.infer<typeof updateMcpServerSchema>;
