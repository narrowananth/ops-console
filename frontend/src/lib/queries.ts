import {
  type AgentAccountsSetting,
  ApprovalStatus,
  accountListSchema,
  addedAccountSchema,
  agentAccountsSettingSchema,
  approvalSchema,
  type ConnectionTestResult,
  type ConnectionType,
  type ConnectorId,
  type CreateConnection,
  type CreateMcpServer,
  claudeAccountSchema,
  connectionCheckSchema,
  connectionListSchema,
  connectionSchema,
  connectionTestResultSchema,
  connectorCheckSchema,
  connectorListSchema,
  connectorSchema,
  healthSchema,
  mcpServerListSchema,
  mcpServerSchema,
  repoListSchema,
  repoSchema,
  type SessionDefaults,
  type SessionPatch,
  sessionDefaultsSchema,
  sessionSchema,
  type UpdateConnection,
  type UpdateMcpServer,
} from '@ops-console/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet, apiSend } from './api';
import { sessionToken } from './session';

export const queryKeys = {
  health: ['health'] as const,
  settings: ['settings'] as const,
  accounts: ['agent-accounts'] as const,
  approvals: ['approvals'] as const,
  mcpServers: ['mcp-servers'] as const,
  connectors: ['connectors'] as const,
  connections: ['connections'] as const,
  repos: ['repos'] as const,
  session: (id: string) => ['sessions', id] as const,
};

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiGet('/health', z.object({ data: healthSchema })),
    enabled: sessionToken() !== null,
    retry: false,
  });
}

/** The keys this spec owns; other keys pass through untouched. */
const agentSettingsSchema = z.object({
  data: z.object({ session_defaults: sessionDefaultsSchema, agent_accounts: agentAccountsSettingSchema }).loose(),
});

export function useAgentSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: () => apiGet('/settings', agentSettingsSchema) });
}

export function usePatchSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: { session_defaults?: SessionDefaults; agent_accounts?: AgentAccountsSetting }) =>
      apiSend('PATCH', '/settings', patch, agentSettingsSchema),
    onSuccess: (settings) => client.setQueryData(queryKeys.settings, settings),
  });
}

const ACCOUNTS_REFRESH_MS = 10_000;

/** Refetched every 10 seconds while mounted, so windows that reset and usage from runs show without a reload. */
export function useAgentAccounts() {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => apiGet('/agent-accounts', accountListSchema),
    refetchInterval: ACCOUNTS_REFRESH_MS,
  });
}

const accountResponse = z.object({ data: claudeAccountSchema });

/** Adding sends no event, so the list refetches here; checks and switches arrive over `/ws`. */
export function useAddAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('POST', '/agent-accounts', undefined, z.object({ data: addedAccountSchema })),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

export function useCheckAccount() {
  return useMutation({
    mutationFn: (id: string) => apiSend('POST', `/agent-accounts/${id}/checks`, undefined, accountResponse),
  });
}

/** Opens Anthropic's sign-in in the browser; `account.updated` arrives over `/ws` when the account is checked. */
export function useStartLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiSend('POST', `/agent-accounts/${id}/logins`, undefined, accountResponse),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

export function useCancelLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/agent-accounts/${id}/logins`, undefined, z.undefined()),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

/** Signs the account out; the response is the account after the check, and `account.updated` follows over `/ws`. */
export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiSend('POST', `/agent-accounts/${id}/logout`, undefined, accountResponse),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

export function useRemoveAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/agent-accounts/${id}`, undefined, z.undefined()),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

export function useActivateAccount() {
  return useMutation({
    mutationFn: (id: string) => apiSend('POST', `/agent-accounts/${id}/activate`, undefined, accountResponse),
  });
}

/** The Session composer chips: model, effort and access apply from the next run. */
export function useUpdateSession(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: SessionPatch) => apiSend('PATCH', `/sessions/${id}`, patch, z.object({ data: sessionSchema })),
    onSuccess: (session) => client.setQueryData(queryKeys.session(id), session),
  });
}

export function usePendingApprovals() {
  return useQuery({
    queryKey: queryKeys.approvals,
    queryFn: () =>
      apiGet('/approvals?status=pending', z.object({ data: z.array(approvalSchema) })).then((body) => body.data),
  });
}

export function useDecideApproval() {
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: ApprovalStatus.Approved | ApprovalStatus.Denied }) =>
      apiSend('POST', `/approvals/${id}/decision`, { decision }, z.object({ data: approvalSchema })),
  });
}

/** The list across every Claude account; `connection.checked` over `/ws` refreshes it after each check. */
export function useMcpServers() {
  return useQuery({
    queryKey: queryKeys.mcpServers,
    queryFn: () => apiGet('/mcp-servers', mcpServerListSchema),
  });
}

const mcpServerResponse = z.object({ data: mcpServerSchema });

function useMcpMutation<V>(send: (variables: V) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.mcpServers }),
  });
}

export function useCreateMcpServer() {
  return useMcpMutation((body: CreateMcpServer) => apiSend('POST', '/mcp-servers', body, mcpServerResponse));
}

export function useUpdateMcpServer() {
  return useMcpMutation(({ name, body }: { name: string; body: UpdateMcpServer }) =>
    apiSend('PATCH', `/mcp-servers/${encodeURIComponent(name)}`, body, mcpServerResponse),
  );
}

/** Reconnect: a new Probe in every account. */
export function useReconnectMcpServer() {
  return useMcpMutation((name: string) =>
    apiSend('POST', `/mcp-servers/${encodeURIComponent(name)}/checks`, undefined, mcpServerResponse),
  );
}

/** Opens the server's sign-in in the browser; the result arrives as `connection.checked`. */
export function useAuthenticateMcpServer() {
  return useMcpMutation((name: string) =>
    apiSend('POST', `/mcp-servers/${encodeURIComponent(name)}/auth`, undefined, z.undefined()),
  );
}

export function useRemoveMcpServer() {
  return useMcpMutation((name: string) =>
    apiSend('DELETE', `/mcp-servers/${encodeURIComponent(name)}/credentials`, undefined, mcpServerResponse),
  );
}

/** Refreshed by `connection.checked` over `/ws`; the list also re-checks connected Connectors that are 10 minutes stale. */
export function useConnectors() {
  return useQuery({ queryKey: queryKeys.connectors, queryFn: () => apiGet('/connectors', connectorListSchema) });
}

function useConnectorMutation<V>(send: (variables: V) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.connectors }),
  });
}

export function useSaveConnector() {
  return useConnectorMutation(({ id, config }: { id: ConnectorId; config: Record<string, unknown> }) =>
    apiSend('PATCH', `/connectors/${id}`, { config }, z.object({ data: connectorSchema })),
  );
}

/** Starts the sign-in; the result arrives as `connection.checked`. */
export function useConnectConnector() {
  return useConnectorMutation(({ id, secret }: { id: ConnectorId; secret?: string }) =>
    apiSend('POST', `/connectors/${id}/connect`, secret ? { secret } : {}, z.undefined()),
  );
}

export function useTestConnector() {
  return useConnectorMutation((id: ConnectorId) =>
    apiSend('POST', `/connectors/${id}/checks`, undefined, z.object({ data: connectorCheckSchema })),
  );
}

export function useDisconnectConnector() {
  return useConnectorMutation((id: ConnectorId) =>
    apiSend('DELETE', `/connectors/${id}/credentials`, undefined, z.object({ data: connectorSchema })),
  );
}

/** Refreshed by `connection.checked` over `/ws`. */
export function useConnections() {
  return useQuery({ queryKey: queryKeys.connections, queryFn: () => apiGet('/connections', connectionListSchema) });
}

function useConnectionMutation<V, R = unknown>(send: (variables: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}

export function useCreateConnection() {
  return useConnectionMutation((body: CreateConnection) =>
    apiSend('POST', '/connections', body, z.object({ data: connectionSchema })),
  );
}

export function useUpdateConnection() {
  return useConnectionMutation(({ id, body }: { id: string; body: UpdateConnection }) =>
    apiSend('PATCH', `/connections/${id}`, body, z.object({ data: connectionSchema })),
  );
}

export function useDeleteConnection() {
  return useConnectionMutation((id: string) => apiSend('DELETE', `/connections/${id}`, undefined, z.undefined()));
}

export function useCheckConnection() {
  return useConnectionMutation((id: string) =>
    apiSend('POST', `/connections/${id}/checks`, undefined, z.object({ data: connectionCheckSchema })),
  );
}

/** Tests an unsaved Connection; nothing is stored. */
export function useTestConnection() {
  return useMutation({
    mutationFn: (body: { type: ConnectionType; config: Record<string, unknown>; secret?: string }) =>
      apiSend('POST', '/connections/tests', body, z.object({ data: connectionTestResultSchema })).then(
        (response): ConnectionTestResult => response.data,
      ),
  });
}

export function useStartSetupTerminal() {
  return useMutation({
    mutationFn: () =>
      apiSend('POST', '/terminals', { kind: 'setup' }, z.object({ data: z.object({ id: z.string() }) })).then(
        (response) => response.data.id,
      ),
  });
}

export function useAnswerSecret() {
  return useMutation({
    mutationFn: ({ terminalId, requestId, value }: { terminalId: string; requestId: string; value: string }) =>
      apiSend('POST', `/terminals/${terminalId}/secrets`, { request_id: requestId, value }, z.undefined()),
  });
}

/** Branch and dirty state are read from git on every fetch. */
export function useRepos() {
  return useQuery({ queryKey: queryKeys.repos, queryFn: () => apiGet('/repos', repoListSchema) });
}

export function useImportRepo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => apiSend('POST', '/repos', { path }, z.object({ data: repoSchema })),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.repos }),
  });
}

export function useRemoveRepo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/repos/${id}`, undefined, z.undefined()),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.repos }),
  });
}
