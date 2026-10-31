import {
  type AgentAccountsSetting,
  ApprovalStatus,
  accountListSchema,
  addedAccountSchema,
  agentAccountsSettingSchema,
  alertDetailSchema,
  alertEventSchema,
  alertSchema,
  approvalSchema,
  branchSchema,
  type ConnectionTestResult,
  type ConnectionType,
  type ConnectorId,
  type CreateConnection,
  type CreateMcpServer,
  checkoutResultSchema,
  claudeAccountSchema,
  connectionCheckSchema,
  connectionListSchema,
  connectionSchema,
  connectionTestResultSchema,
  connectorCheckSchema,
  connectorListSchema,
  connectorSchema,
  fixSchema,
  healthSchema,
  mcpServerListSchema,
  mcpServerSchema,
  messageSchema,
  type PrReviewEvent,
  prAgentReviewSchema,
  prCommentSchema,
  pullRequestDetailSchema,
  pullRequestListSchema,
  type ReviewAlert,
  repoListSchema,
  reportSchema,
  repoSchema,
  reviewSchema,
  routeViewSchema,
  type SessionDefaults,
  type SessionPatch,
  scanSchema,
  serviceSchema,
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
  sessions: ['sessions'] as const,
  branches: (repoId: string) => ['branches', repoId] as const,
  pulls: ['pull-requests'] as const,
  monitor: ['monitor'] as const,
  alert: (id: string) => ['monitor', 'alert', id] as const,
  session: (id: string) => ['sessions', id] as const,
  messages: (id: string) => ['messages', id] as const,
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

const PATCH_SETTINGS = ['patch-settings'] as const;

/**
 * A change shows at once and saves in order, one request at a time. Each request carries a whole setting, so a
 * second click built from the state before the first save returned would write the first click away.
 */
export function usePatchSettings() {
  const client = useQueryClient();
  type Cached = z.infer<typeof agentSettingsSchema>;
  return useMutation({
    mutationKey: PATCH_SETTINGS,
    scope: { id: 'patch-settings' },
    mutationFn: (patch: { session_defaults?: SessionDefaults; agent_accounts?: AgentAccountsSetting }) =>
      apiSend('PATCH', '/settings', patch, agentSettingsSchema),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: queryKeys.settings });
      const previous = client.getQueryData<Cached>(queryKeys.settings);
      if (previous) {
        client.setQueryData<Cached>(queryKeys.settings, { data: { ...previous.data, ...patch } });
      }
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) client.setQueryData(queryKeys.settings, context.previous);
    },
    onSuccess: (settings) => {
      // A later click is still waiting to save: its own answer will carry the whole state.
      if (client.isMutating({ mutationKey: PATCH_SETTINGS }) <= 1) client.setQueryData(queryKeys.settings, settings);
    },
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

/** Opens the Finder folder dialog on this machine; the path is `null` when the operator closes it. */
export function usePickFolder() {
  return useMutation({
    mutationFn: () =>
      apiSend(
        'POST',
        '/repos/pick-folder',
        undefined,
        z.object({ data: z.object({ path: z.string().nullable() }) }),
      ).then((body) => body.data.path),
  });
}

export function useRemoveRepo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/repos/${id}`, undefined, z.undefined()),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.repos }),
  });
}

/** Every `repo` Session, newest first. `session.updated` over `/ws` keeps it fresh. */
export function useRepoSessions() {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: () =>
      apiGet('/sessions?kind=repo&limit=100', z.object({ data: z.array(sessionSchema) })).then((b) => b.data),
  });
}

export function useCreateRepoSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { repo_id: string; branch: string }) =>
      apiSend('POST', '/sessions', input, z.object({ data: sessionSchema })).then((body) => body.data),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}

export function useDeleteSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/sessions/${id}`, undefined, z.undefined()),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}

export function useMessages(sessionId: string) {
  return useQuery({
    queryKey: queryKeys.messages(sessionId),
    queryFn: () =>
      apiGet(`/sessions/${sessionId}/messages`, z.object({ data: z.array(messageSchema) })).then((b) => b.data),
  });
}

export function useSendMessage(sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      apiSend(
        'POST',
        `/sessions/${sessionId}/messages`,
        { text },
        z.object({ data: z.object({ message_id: z.string() }) }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.messages(sessionId) }),
  });
}

export function useBranches(repoId: string) {
  return useQuery({
    queryKey: queryKeys.branches(repoId),
    queryFn: () => apiGet(`/repos/${repoId}/branches`, z.object({ data: z.array(branchSchema) })).then((b) => b.data),
  });
}

export function useCheckout(sessionId: string, repoId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { branch: string; create: boolean }) =>
      apiSend('POST', `/sessions/${sessionId}/checkout`, input, z.object({ data: checkoutResultSchema })).then(
        (body) => body.data,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.sessions });
      void client.invalidateQueries({ queryKey: queryKeys.branches(repoId) });
      void client.invalidateQueries({ queryKey: queryKeys.repos });
    },
  });
}

export type PullRequestFilter = { mine: boolean; q: string };

/** The Git host's open pull requests across every Repo, kept 60 seconds in the daemon. */
export function usePullRequests(filter: PullRequestFilter) {
  const params = new URLSearchParams();
  if (filter.mine) params.set('mine', 'true');
  if (filter.q) params.set('q', filter.q);
  return useQuery({
    queryKey: [...queryKeys.pulls, 'list', filter],
    queryFn: () => apiGet(`/pull-requests?${params}`, pullRequestListSchema),
  });
}

export function useRefreshPullRequests() {
  return useMutation({ mutationFn: () => apiSend('POST', '/pull-requests/refresh', {}, z.unknown()) });
}

export function usePullRequest(repoId: string, number: number) {
  return useQuery({
    queryKey: [...queryKeys.pulls, 'detail', repoId, number],
    queryFn: () =>
      apiGet(`/repos/${repoId}/pull-requests/${number}`, z.object({ data: pullRequestDetailSchema })).then(
        (b) => b.data,
      ),
  });
}

export function usePostComment(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string; parent_id?: string }) =>
      apiSend('POST', `/repos/${repoId}/pull-requests/${number}/comments`, input, z.object({ data: prCommentSchema })),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pulls }),
  });
}

export function useResolveComment(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { comment_id: string; resolved: boolean }) =>
      apiSend(
        'PATCH',
        `/repos/${repoId}/pull-requests/${number}/comments/${input.comment_id}`,
        { resolved: input.resolved },
        z.object({ data: prCommentSchema }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pulls }),
  });
}

export function useReviewPullRequest(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { event: PrReviewEvent; body?: string }) =>
      apiSend('POST', `/repos/${repoId}/pull-requests/${number}/reviews`, input, z.unknown()),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pulls }),
  });
}

export function useMergePullRequest(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('POST', `/repos/${repoId}/pull-requests/${number}/merge`, undefined, z.unknown()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.pulls });
      void client.invalidateQueries({ queryKey: ['branches'] });
    },
  });
}

export function useStartAgentReview(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiSend(
        'POST',
        `/repos/${repoId}/pull-requests/${number}/agent-reviews`,
        undefined,
        z.object({ data: prAgentReviewSchema }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pulls }),
  });
}

const listOf = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });

export function useServices() {
  return useQuery({
    queryKey: [...queryKeys.monitor, 'services'],
    queryFn: () => apiGet('/services', listOf(serviceSchema)).then((b) => b.data),
  });
}

export function useScans() {
  return useQuery({
    queryKey: [...queryKeys.monitor, 'scans'],
    queryFn: () => apiGet('/scans', listOf(scanSchema)).then((b) => b.data),
  });
}

export function useAlerts() {
  return useQuery({
    queryKey: [...queryKeys.monitor, 'alerts'],
    queryFn: () => apiGet('/alerts', listOf(alertSchema)).then((b) => b.data),
  });
}

export function useAlert(id: string) {
  return useQuery({
    queryKey: queryKeys.alert(id),
    queryFn: () => apiGet(`/alerts/${id}`, z.object({ data: alertDetailSchema })).then((b) => b.data),
  });
}

export function useAlertEvents(id: string) {
  return useQuery({
    queryKey: [...queryKeys.alert(id), 'events'],
    queryFn: () => apiGet(`/alerts/${id}/events`, listOf(alertEventSchema)).then((b) => b.data),
  });
}

export function useAlertReports(id: string) {
  return useQuery({
    queryKey: [...queryKeys.alert(id), 'reports'],
    queryFn: () => apiGet(`/alerts/${id}/reports`, listOf(reportSchema)).then((b) => b.data),
  });
}

const refreshMonitor = (client: ReturnType<typeof useQueryClient>) =>
  client.invalidateQueries({ queryKey: queryKeys.monitor });

export function useStartScan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string | null) =>
      apiSend('POST', '/scans', { service_id: serviceId }, z.object({ data: scanSchema })),
    onSuccess: () => refreshMonitor(client),
  });
}

export function usePatchService() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; repo_id?: string | null; check_interval?: string | null }) => {
      const { id, ...body } = input;
      return apiSend('PATCH', `/services/${id}`, body, z.object({ data: serviceSchema }));
    },
    onSuccess: () => refreshMonitor(client),
  });
}

export function usePatchRoute() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; ignored?: boolean; note?: string | null }) => {
      const { id, ...body } = input;
      return apiSend('PATCH', `/routes/${id}`, body, z.object({ data: routeViewSchema }));
    },
    onSuccess: () => refreshMonitor(client),
  });
}

export function useVerifyAlert(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('POST', `/alerts/${id}/verifications`, undefined, z.object({ data: reportSchema })),
    onSuccess: () => refreshMonitor(client),
  });
}

export function useReviewAlert(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewAlert) =>
      apiSend(
        'POST',
        `/alerts/${id}/review`,
        input,
        z.object({ data: reviewSchema.extend({ fix: fixSchema.nullable() }) }),
      ),
    onSuccess: () => refreshMonitor(client),
  });
}

export function useUndoDismissal(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('DELETE', `/alerts/${id}/review`, undefined, z.undefined()),
    onSuccess: () => refreshMonitor(client),
  });
}

export function useRetryFix(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('POST', `/fixes/${id}/retry`, undefined, z.object({ data: fixSchema })),
    onSuccess: () => refreshMonitor(client),
  });
}

/** Every `devtools` Session, newest first. */
export function useDevtoolsSessions() {
  return useQuery({
    queryKey: [...queryKeys.sessions, 'devtools'],
    queryFn: () =>
      apiGet('/sessions?kind=devtools&limit=100', z.object({ data: z.array(sessionSchema) })).then((b) => b.data),
  });
}

export function useCreateDevtoolsSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (connectionIds: string[]) =>
      apiSend(
        'POST',
        '/sessions',
        { kind: 'devtools', connection_ids: connectionIds },
        z.object({ data: sessionSchema }),
      ).then((body) => body.data),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}
