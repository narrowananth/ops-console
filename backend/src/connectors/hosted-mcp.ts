import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '@ops-console/shared';
import type { z } from 'zod';
import { ApiError } from '../common/errors';

/** The hosted server refused the sign-in: a 401, or a token it will not refresh. */
export class HostedAuthError extends Error {}

/** The hosted server did not answer. `reason` is a few words safe to show. */
export class HostedUnreachable extends Error {
  constructor(readonly reason: string) {
    super(`it did not answer: ${reason}`);
  }
}

/** The server answered with an error of its own. The message is its words. */
export class HostedFailed extends Error {}

/** The server named a rate limit. */
export class HostedRateLimited extends Error {}

/** The server answered, and the console cannot read the answer. */
export class HostedUnreadable extends Error {}

/** How the console signs in to a hosted server: a token it was given, or a client with a token store that refreshes. */
export type HostedAuth = { bearer: string } | { provider: OAuthClientProvider };

export type HostedToolInfo = { name: string; properties: string[] };

/** One open session with a hosted server. Each method throws one of the errors above. */
export interface HostedTools {
  /** The tool's answer as text. A tool error is thrown, never returned. */
  call(tool: string, args: Record<string, unknown>): Promise<string>;
  /** The tool's answer, parsed once as JSON against `schema`. */
  callJson<S extends z.ZodType>(tool: string, args: Record<string, unknown>, schema: S): Promise<z.infer<S>>;
  /** Each tool the server offers and the names of its arguments. */
  list(): Promise<HostedToolInfo[]>;
}

/** Opens a session, runs `use`, closes it. */
export type HostedOpen = <T>(use: (tools: HostedTools) => Promise<T>, signal?: AbortSignal) => Promise<T>;

const CALL_TIMEOUT_MS = 60_000;
const RATE_LIMITED = /\b429\b|too many requests|rate.?limit/i;

const REASONS: [RegExp, string][] = [
  [/ENOTFOUND|EAI_AGAIN/, 'the host name was not found'],
  [/ECONNREFUSED/, 'the connection was refused'],
  [/certificate|CERT_|SELF_SIGNED/i, 'its TLS certificate was not accepted'],
  [/timeout|timed out|ETIMEDOUT/i, 'it did not answer in time'],
];

/** Why a request that never got an answer failed, in words safe to show. */
function reasonOf(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  const text = `${String(error)} ${String(cause ?? '')} ${String((cause as { code?: unknown } | undefined)?.code ?? '')}`;
  return REASONS.find(([pattern]) => pattern.test(text))?.[1] ?? 'the connection failed';
}

/** The typed error of a failure on the wire; an abort is the caller's to end. */
function mapped(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return signal.reason instanceof Error ? signal.reason : new Error('aborted');
  if (error instanceof HostedAuthError) return error;
  // A refresh token the server refuses, or a registration it will not redo, ends as a sign-in to make again.
  if (error instanceof UnauthorizedError || error instanceof OAuthError)
    return new HostedAuthError('the sign-in was refused');
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) return new HostedAuthError('the sign-in was refused');
    if (error.code === 429) return new HostedRateLimited('rate limit reached');
    if (error.code !== undefined) return new HostedFailed(`the server answered HTTP ${error.code}`);
  }
  if (error instanceof McpError) {
    return RATE_LIMITED.test(error.message) ? new HostedRateLimited(error.message) : new HostedFailed(error.message);
  }
  return new HostedUnreachable(reasonOf(error));
}

const textOf = (content: unknown): string =>
  (Array.isArray(content) ? content : [])
    .flatMap((block: unknown) => {
      const { type, text } = block as { type?: unknown; text?: unknown };
      return type === 'text' && typeof text === 'string' ? [text] : [];
    })
    .join('\n');

/** An MCP client for one hosted server. The call's tool errors come back as typed errors. */
export function hostedMcp(url: string, auth: HostedAuth): HostedOpen {
  return async (use, signal) => {
    const client = new Client({ name: 'ops-console', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      ...('provider' in auth
        ? { authProvider: auth.provider }
        : { requestInit: { headers: { Authorization: `Bearer ${auth.bearer}` } } }),
    });
    const wire = async <T>(work: Promise<T>): Promise<T> =>
      work.catch((error: unknown) => Promise.reject(mapped(error, signal)));
    const tools: HostedTools = {
      async call(tool, args) {
        const result = await wire(
          client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS }),
        );
        const answer = textOf(result.content);
        if (result.isError === true) {
          throw RATE_LIMITED.test(answer)
            ? new HostedRateLimited(answer)
            : new HostedFailed(answer || `${tool} failed`);
        }
        return answer;
      },
      async callJson(tool, args, schema) {
        const answer = await tools.call(tool, args);
        try {
          return schema.parse(JSON.parse(answer));
        } catch {
          throw new HostedUnreadable(`${tool} gave an answer the console cannot read`);
        }
      },
      async list() {
        const { tools: found } = await wire(client.listTools(undefined, { signal, timeout: CALL_TIMEOUT_MS }));
        return found.map((tool) => ({ name: tool.name, properties: Object.keys(tool.inputSchema.properties ?? {}) }));
      },
    };
    try {
      await wire(client.connect(transport, { signal, timeout: CALL_TIMEOUT_MS }));
      return await use(tools);
    } finally {
      await client.close().catch(() => {});
    }
  };
}

/**
 * What a Scan or a Recheck throws for a hosted server's failure: `rate_limited` when the server named a limit,
 * `upstream_failed` with the server's own words otherwise. `source` is the name of the log source.
 */
export function readFailure(error: unknown, source: string): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof HostedRateLimited)
    return new ApiError(429, ErrorCode.RateLimited, `${source} rate limit reached`);
  if (error instanceof HostedAuthError) {
    return new ApiError(
      502,
      ErrorCode.UpstreamFailed,
      `${source} needs signing in again: reconnect it in Integrations`,
    );
  }
  if (error instanceof HostedUnreachable)
    return new ApiError(502, ErrorCode.UpstreamFailed, `${source} ${error.message}`);
  if (error instanceof HostedFailed) {
    return new ApiError(
      502,
      ErrorCode.UpstreamFailed,
      `${source} answered with an error: ${error.message.slice(0, 300)}`,
    );
  }
  if (error instanceof HostedUnreadable)
    return new ApiError(502, ErrorCode.UpstreamFailed, `${source}: ${error.message}`);
  throw error;
}
