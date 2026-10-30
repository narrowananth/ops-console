import {
  type AgentAccountsSetting,
  ApprovalStatus,
  accountListSchema,
  addedAccountSchema,
  agentAccountsSettingSchema,
  approvalSchema,
  type CreateMcpServer,
  claudeAccountSchema,
  healthSchema,
  mcpServerListSchema,
  mcpServerSchema,
  type SessionDefaults,
  type SessionPatch,
  sessionDefaultsSchema,
  sessionSchema,
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
