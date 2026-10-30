import {
  type AgentAccountsSetting,
  ApprovalStatus,
  accountListSchema,
  addedAccountSchema,
  agentAccountsSettingSchema,
  approvalSchema,
  claudeAccountSchema,
  healthSchema,
  type SessionDefaults,
  type SessionPatch,
  sessionDefaultsSchema,
  sessionSchema,
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

export function useAgentAccounts() {
  return useQuery({ queryKey: queryKeys.accounts, queryFn: () => apiGet('/agent-accounts', accountListSchema) });
}

const accountResponse = z.object({ data: claudeAccountSchema });

/** Adding sends no event, so the list refetches here; checks and switches arrive over `/ws`. */
export function useAddAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (label: string) =>
      apiSend('POST', '/agent-accounts', { label }, z.object({ data: addedAccountSchema })),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

export function useCheckAccount() {
  return useMutation({
    mutationFn: (id: string) => apiSend('POST', `/agent-accounts/${id}/checks`, undefined, accountResponse),
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
