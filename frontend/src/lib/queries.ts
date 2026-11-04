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
  type CliProxySetting,
  type ConnectionTestResult,
  type ConnectionType,
  type ConnectorId,
  type CreateConnection,
  type CreatePlaybook,
  type CreateScan,
  checkoutResultSchema,
  claudeAccountSchema,
  cliProxySchema,
  commentPassSchema,
  connectionCheckSchema,
  connectionListSchema,
  connectionSchema,
  connectionTestResultSchema,
  connectorListSchema,
  connectorSchema,
  datadogServiceSchema,
  diskAccessSchema,
  editedMessageSchema,
  findCodeResultSchema,
  fixSchema,
  healthSchema,
  keychainWaitSchema,
  mcpServerListSchema,
  mcpServerSchema,
  messageSchema,
  networkAllowlistSchema,
  type OpenPullRequest,
  openedPullRequestSchema,
  type PlaybookPatch,
  type PlaybookTrigger,
  type PrReviewEvent,
  playbookListSchema,
  playbookSchema,
  prAgentReviewSchema,
  prCommentSchema,
  prFileContentSchema,
  pullRequestDetailSchema,
  pullRequestDraftSchema,
  pullRequestListSchema,
  type RemovedRepoSessions,
  type ReviewAlert,
  replyCheckSchema,
  repoListSchema,
  reportSchema,
  repoSchema,
  reviewSchema,
  routeViewSchema,
  runSandboxSchema,
  type ScanWindow,
  type Session,
  type SessionDefaults,
  type SessionPatch,
  SessionState,
  SignInVia,
  savedNetworkDomainSchema,
  scanSchema,
  serviceSchema,
  sessionDefaultsSchema,
  sessionDiffSchema,
  sessionPullRequestSchema,
  sessionSchema,
  startAtLoginSchema,
  statusCodeCountSchema,
  terminalListSchema,
  type UpdateConnection,
  type UpdateMcpServer,
  type UpdateWhen,
  updateStateSchema,
} from '@ops-console/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';
import { apiGet, apiSend } from './api';
import { sessionToken } from './session';

export const queryKeys = {
  health: ['health'] as const,
  settings: ['settings'] as const,
  accounts: ['agent-accounts'] as const,
  cliProxy: ['cliproxy'] as const,
  approvals: ['approvals'] as const,
  mcpServers: ['mcp-servers'] as const,
  connectors: ['connectors'] as const,
  connections: ['connections'] as const,
  repos: ['repos'] as const,
  sessions: ['sessions'] as const,
  branches: (repoId: string) => ['branches', repoId] as const,
  pulls: ['pull-requests'] as const,
  pullRequest: (repoId: string, number: number) => ['pull-requests', 'detail', repoId, number] as const,
  monitor: ['monitor'] as const,
  alert: (id: string) => ['monitor', 'alert', id] as const,
  session: (id: string) => ['sessions', id] as const,
  messages: (id: string) => ['messages', id] as const,
  sessionDiff: (id: string) => ['session-diff', id] as const,
  sessionPullRequest: (id: string) => ['session-pull-request', id] as const,
  diskAccess: ['disk-access'] as const,
  startAtLogin: ['start-at-login'] as const,
  runSandbox: ['run-sandbox'] as const,
  networkAllowlist: ['network-allowlist'] as const,
  keychainWait: ['keychain-wait'] as const,
  terminals: ['terminals'] as const,
  playbooks: ['playbooks'] as const,
  updates: ['updates'] as const,
};

/** `poll`: asks every second and a half, while the console restarts on a new version. */
export function useHealth(poll = false) {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiGet('/health', z.object({ data: healthSchema })),
    enabled: sessionToken() !== null,
    retry: false,
    refetchInterval: poll ? 1500 : false,
  });
}

const updatesBody = z.object({ data: updateStateSchema });

/** The installed version against the newest release on GitHub. */
export function useUpdates() {
  return useQuery({
    queryKey: queryKeys.updates,
    queryFn: () => apiGet('/updates', updatesBody),
    enabled: sessionToken() !== null,
    retry: false,
  });
}

/** Check now: asks GitHub for the newest release. */
export function useCheckUpdates() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('POST', '/updates/checks', {}, updatesBody),
    onSuccess: (state) => client.setQueryData(queryKeys.updates, state),
  });
}

/** Installs the newest release now, or once no agent run is going; the console then restarts on it. */
export function useInstallUpdate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (when: UpdateWhen) => apiSend('POST', '/updates', { when }, updatesBody),
    onSuccess: (state) => client.setQueryData(queryKeys.updates, state),
  });
}

/** The Update automatically switch. */
export function useAutoUpdate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (auto_update: boolean) => apiSend('PATCH', '/settings', { updates: { auto_update } }, z.unknown()),
    onMutate: (auto_update) => {
      const previous = client.getQueryData<z.infer<typeof updatesBody>>(queryKeys.updates);
      if (previous) client.setQueryData(queryKeys.updates, { data: { ...previous.data, auto_update } });
      return { previous };
    },
    onError: (_error, _value, context) => {
      if (context?.previous) client.setQueryData(queryKeys.updates, context.previous);
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.updates }),
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
    mutationFn: (patch: {
      session_defaults?: SessionDefaults;
      agent_accounts?: AgentAccountsSetting;
      cliproxy?: CliProxySetting;
    }) => apiSend('PATCH', '/settings', patch, agentSettingsSchema),
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
    // Turning CLIProxy on or off, or moving it, changes what `/cliproxy` answers.
    onSettled: (_settings, _error, patch) => {
      if (patch.cliproxy) void client.invalidateQueries({ queryKey: queryKeys.cliProxy });
    },
  });
}

const ACCOUNTS_REFRESH_MS = 10_000;

const cliProxyResponse = z.object({ data: cliProxySchema });

/** CLIProxy as the Claude account hub: on or off, its address, whether a key is saved, and how it last answered. */
export function useCliProxy() {
  return useQuery({
    queryKey: queryKeys.cliProxy,
    queryFn: () => apiGet('/cliproxy', cliProxyResponse),
    refetchInterval: ACCOUNTS_REFRESH_MS,
  });
}

/** Saves the key to the Keychain, removes it, or asks CLIProxy again; each answers with the hub as it is now. */
export function useCliProxyAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: { kind: 'save'; key: string } | { kind: 'remove' } | { kind: 'check' }) =>
      action.kind === 'save'
        ? apiSend('PUT', '/cliproxy/key', { key: action.key }, cliProxyResponse)
        : action.kind === 'remove'
          ? apiSend('DELETE', '/cliproxy/key', undefined, cliProxyResponse)
          : apiSend('POST', '/cliproxy/checks', undefined, cliProxyResponse),
    onSuccess: (body) => client.setQueryData(queryKeys.cliProxy, body),
  });
}

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

/**
 * Starts the account's sign-in: in a browser tab on this Mac, or by a link to open in any browser. `account.updated`
 * arrives over `/ws` when the link is ready and when the account is checked.
 */
export function useStartLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, via = SignInVia.Browser }: { id: string; via?: SignInVia }) =>
      apiSend('POST', `/agent-accounts/${id}/logins`, { via }, accountResponse),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

/** Hands over the code Anthropic showed after a sign-in by link; a code turned down comes back with a new link. */
export function useSubmitSignInCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, code }: { id: string; code: string }) =>
      apiSend('POST', `/agent-accounts/${id}/logins/code`, { code }, accountResponse),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.accounts }),
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
/** Every cached Session list shows the change at once; the reply, or a refetch after a failure, settles it. */
export function useUpdateSession(id: string) {
  const client = useQueryClient();
  const apply = (change: (session: Session) => Session) =>
    client.setQueriesData<Session[]>({ queryKey: queryKeys.sessions }, (list) =>
      list?.map((session) => (session.id === id ? change(session) : session)),
    );
  return useMutation({
    mutationFn: (patch: SessionPatch) =>
      apiSend('PATCH', `/sessions/${id}`, patch, z.object({ data: sessionSchema })).then((body) => body.data),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: queryKeys.sessions });
      apply((session) => ({ ...session, ...patch }));
    },
    onSuccess: (saved) => apply(() => saved),
    onError: () => client.invalidateQueries({ queryKey: queryKeys.sessions }),
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

/** Starts the sign-in; the result arrives as `connection.checked`. */
export function useConnectConnector() {
  return useConnectorMutation((id: ConnectorId) => apiSend('POST', `/connectors/${id}/connect`, {}, z.undefined()));
}

/** Saves a Connector's settings, such as the slashdocs server, then starts its sign-in. */
export function useConnectConnectorWith() {
  return useConnectorMutation(async ({ id, config }: { id: ConnectorId; config: Record<string, unknown> }) => {
    await apiSend('PATCH', `/connectors/${id}`, { config }, z.object({ data: connectorSchema }));
    return apiSend('POST', `/connectors/${id}/connect`, {}, z.undefined());
  });
}

/** Stops a sign-in still waiting on the browser; the Connector keeps the status it had. */
export function useCancelConnectorSignIn() {
  return useConnectorMutation((id: ConnectorId) =>
    apiSend('DELETE', `/connectors/${id}/sign-in`, undefined, z.object({ data: connectorSchema })),
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

/** The running setup terminal, if any: it keeps running while the operator is elsewhere, so the tab finds it again. */
export function useSetupTerminal() {
  return useQuery({
    queryKey: queryKeys.terminals,
    queryFn: () =>
      apiGet('/terminals', terminalListSchema).then((r) => r.data.find((item) => item.kind === 'setup')?.id ?? null),
  });
}

export function useStartSetupTerminal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiSend('POST', '/terminals', { kind: 'setup' }, z.object({ data: z.object({ id: z.string() }) })).then(
        (response) => response.data.id,
      ),
    onSuccess: (id) => client.setQueryData(queryKeys.terminals, id),
  });
}

export function useCloseSetupTerminal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/terminals/${id}`, undefined, z.undefined()),
    onSuccess: () => client.setQueryData(queryKeys.terminals, null),
  });
}

/** Checked again whenever the window comes back into focus, as it does on the way back from System Settings. */
export function useDiskAccess() {
  return useQuery({
    queryKey: queryKeys.diskAccess,
    queryFn: () => apiGet('/terminals/disk-access', z.object({ data: diskAccessSchema })).then((r) => r.data),
    refetchOnWindowFocus: 'always',
  });
}

export function useOpenDiskAccessSettings() {
  return useMutation({
    mutationFn: () => apiSend('POST', '/terminals/disk-access/settings', undefined, z.undefined()),
  });
}

export function useStartAtLogin() {
  return useQuery({
    queryKey: queryKeys.startAtLogin,
    queryFn: () => apiGet('/terminals/start-at-login', z.object({ data: startAtLoginSchema })).then((r) => r.data),
    refetchOnWindowFocus: 'always',
  });
}

/** Read again each time the Permissions page opens: the daemon tests the sandbox then. */
export function useRunSandbox() {
  return useQuery({
    queryKey: queryKeys.runSandbox,
    queryFn: () => apiGet('/terminals/run-sandbox', z.object({ data: runSandboxSchema })).then((r) => r.data),
    refetchOnMount: 'always',
  });
}

/** The hosts agent runs may reach, in three groups. Read again each time the Permissions page opens. */
export function useNetworkAllowlist() {
  return useQuery({
    queryKey: queryKeys.networkAllowlist,
    queryFn: () => apiGet('/network-allowlist', z.object({ data: networkAllowlistSchema })).then((r) => r.data),
    refetchOnMount: 'always',
    // The row shows the error with its own Retry.
    retry: false,
  });
}

export function useAddNetworkDomain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) =>
      apiSend('POST', '/network-allowlist/domains', { domain }, z.object({ data: savedNetworkDomainSchema })),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.networkAllowlist }),
  });
}

export function useRemoveNetworkDomain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) =>
      apiSend('DELETE', `/network-allowlist/domains/${encodeURIComponent(domain)}`, undefined, z.undefined()),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.networkAllowlist }),
  });
}

/** Pending Keychain calls past 10 seconds; `/ws` sends `keychain.wait_changed` on each change. */
export function useKeychainWait() {
  return useQuery({
    queryKey: queryKeys.keychainWait,
    queryFn: () => apiGet('/terminals/keychain-wait', z.object({ data: keychainWaitSchema })).then((r) => r.data),
  });
}

export function useOpenLoginItemsSettings() {
  return useMutation({
    mutationFn: () => apiSend('POST', '/terminals/start-at-login/settings', undefined, z.undefined()),
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
    // A Repo removed with its Sessions kept brings them back.
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.repos });
      client.invalidateQueries({ queryKey: queryKeys.sessions });
    },
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
    mutationFn: ({ id, sessions }: { id: string; sessions?: RemovedRepoSessions }) =>
      apiSend('DELETE', `/repos/${id}${sessions ? `?sessions=${sessions}` : ''}`, undefined, z.undefined()),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.repos });
      client.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

/** Every `repo` Session, newest first. `session.updated` over `/ws` keeps it fresh. */
/** The Workspace's Sessions: those in a Repo and the anonymous ones, most recently active first. */
export function useRepoSessions() {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: async () => {
      const read = (kind: string) =>
        apiGet(`/sessions?kind=${kind}&limit=100`, z.object({ data: z.array(sessionSchema) })).then((b) => b.data);
      const [inRepos, anonymous] = await Promise.all([read('repo'), read('anonymous')]);
      return [...inRepos, ...anonymous].sort((a, b) => b.last_active_at.localeCompare(a.last_active_at));
    },
  });
}

/** Every Session of every kind whose run goes, `waiting_input` included, most recently active first. */
export function useRunningSessions() {
  return useQuery({
    queryKey: [...queryKeys.sessions, 'running'],
    queryFn: () =>
      apiGet('/sessions?limit=100', z.object({ data: z.array(sessionSchema) })).then((b) =>
        b.data
          .filter((session) => session.state !== SessionState.Idle && session.state !== SessionState.Failed)
          .sort((a, b) => b.last_active_at.localeCompare(a.last_active_at)),
      ),
  });
}

export function useCreateAnonymousSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { title?: string } = {}) =>
      apiSend('POST', '/sessions', { kind: 'anonymous', ...input }, z.object({ data: sessionSchema })).then(
        (body) => body.data,
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}

export function useCreateRepoSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { repo_id: string; branch: string; from_origin?: boolean }) =>
      apiSend('POST', '/sessions', input, z.object({ data: sessionSchema })).then((body) => body.data),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}

export function useDeleteSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/sessions/${id}`, undefined, z.undefined()),
    onSuccess: (_none, id) => {
      client.setQueriesData<Session[]>({ queryKey: queryKeys.sessions }, (list) =>
        list?.filter((session) => session.id !== id),
      );
      void client.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

/** Ends the Session's run; `session.updated` and `session.finished` bring the new state. */
export function useStopSession(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('POST', `/sessions/${id}/stop`, undefined, z.undefined()),
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}

export function useMessages(sessionId: string) {
  return useQuery({
    queryKey: queryKeys.messages(sessionId),
    queryFn: () =>
      apiGet(`/sessions/${sessionId}/messages`, z.object({ data: z.array(messageSchema) })).then((b) => b.data),
    // Dev tools draws its terminal before the first question makes a Session.
    enabled: sessionId !== '',
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

/** Edits the Session's last message and runs it again; the files the agent edited since it go back first. */
export function useEditMessage(sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, text }: { messageId: string; text: string }) =>
      apiSend(
        'POST',
        `/sessions/${sessionId}/messages/${messageId}/edit`,
        { text },
        z.object({ data: editedMessageSchema }),
      ).then((body) => body.data),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.messages(sessionId) }),
  });
}

/**
 * What a repo Session's branch changes, read from the Repo folder. Read again when a run ends; while one goes and
 * `follow` is set, every few seconds, so edits show as the agent makes them.
 */
export function useSessionDiff(sessionId: string, enabled: boolean, follow: boolean) {
  return useQuery({
    queryKey: queryKeys.sessionDiff(sessionId),
    queryFn: () => apiGet(`/sessions/${sessionId}/diff`, z.object({ data: sessionDiffSchema })).then((d) => d.data),
    enabled,
    refetchInterval: follow ? 4000 : false,
  });
}

/** Whether the Session's branch can open a pull request, and the one already open for it. */
export function useSessionPullRequest(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessionPullRequest(sessionId),
    queryFn: () =>
      apiGet(`/sessions/${sessionId}/pull-request`, z.object({ data: sessionPullRequestSchema })).then((d) => d.data),
    enabled,
  });
}

/** The agent's title and description for the pull request; the turn takes as long as the agent does. */
export function useDraftPullRequest(sessionId: string) {
  return useMutation({
    mutationFn: (baseBranch: string) =>
      apiSend(
        'POST',
        `/sessions/${sessionId}/pull-request-draft`,
        { base_branch: baseBranch },
        z.object({ data: pullRequestDraftSchema }),
      ).then((body) => body.data),
  });
}

/** The console pushes the branch and opens the pull request. */
export function useOpenPullRequest(sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: OpenPullRequest) =>
      apiSend('POST', `/sessions/${sessionId}/pull-request`, input, z.object({ data: openedPullRequestSchema })).then(
        (body) => body.data,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.sessionPullRequest(sessionId) });
      void client.invalidateQueries({ queryKey: queryKeys.pulls });
    },
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
function pullRequestsQuery(filter: PullRequestFilter) {
  const params = new URLSearchParams();
  if (filter.mine) params.set('mine', 'true');
  if (filter.q) params.set('q', filter.q);
  return {
    queryKey: [...queryKeys.pulls, 'list', filter],
    queryFn: () => apiGet(`/pull-requests?${params}`, pullRequestListSchema),
  };
}

export function usePullRequests(filter: PullRequestFilter) {
  return useQuery(pullRequestsQuery(filter));
}

/** One Repo's open pull requests, from the same daemon cache as the list; read when `repoId` is set. */
export function useRepoPullRequests(repoId: string | null) {
  return useQuery({
    queryKey: [...queryKeys.pulls, 'repo', repoId],
    queryFn: () => apiGet(`/pull-requests?repo_id=${repoId}`, pullRequestListSchema),
    enabled: repoId !== null,
  });
}

/**
 * Reads the Workspace's first pull request list as the app opens. The daemon's first read of every host repository
 * takes seconds; started here, it is in memory by the time the operator opens the Workspace.
 */
export function usePrefetchPullRequests() {
  const client = useQueryClient();
  useEffect(() => {
    void client.prefetchQuery(pullRequestsQuery({ mine: true, q: '' }));
  }, [client]);
}

export function useRefreshPullRequests() {
  return useMutation({ mutationFn: () => apiSend('POST', '/pull-requests/refresh', {}, z.unknown()) });
}

export function usePullRequest(repoId: string, number: number) {
  return useQuery({
    queryKey: queryKeys.pullRequest(repoId, number),
    queryFn: () =>
      apiGet(`/repos/${repoId}/pull-requests/${number}`, z.object({ data: pullRequestDetailSchema })).then(
        (b) => b.data,
      ),
  });
}

/** One file of the pull request at `ref`, read when `enabled`. A commit's file never changes, so it is kept. */
export function usePrFile(repoId: string, number: number, path: string, ref: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.pulls, 'file', repoId, number, ref, path],
    queryFn: () =>
      apiGet(
        `/repos/${repoId}/pull-requests/${number}/file?${new URLSearchParams({ path, ref })}`,
        z.object({ data: prFileContentSchema }),
      ).then((b) => b.data),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function usePostComment(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string; parent_id?: string; file_path?: string; line?: number }) =>
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

export function useDeleteComment(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) =>
      apiSend('DELETE', `/repos/${repoId}/pull-requests/${number}/comments/${commentId}`, undefined, z.undefined()),
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

export function useStartReplyCheck(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) =>
      apiSend(
        'POST',
        `/repos/${repoId}/pull-requests/${number}/reply-checks`,
        { comment_id: commentId },
        z.object({ data: replyCheckSchema }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pullRequest(repoId, number) }),
  });
}

/** A failed job's retry; `skip` passes over its failed step first. */
type JobRetry = { id: string; skip?: boolean };

export function useRetryReplyCheck(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, skip = false }: JobRetry) =>
      apiSend('POST', `/reply-checks/${id}/retry`, { skip }, z.object({ data: replyCheckSchema })),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pullRequest(repoId, number) }),
  });
}

/** Check replies: one run over every replied thread. */
export function useCheckReplies(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiSend(
        'POST',
        `/repos/${repoId}/pull-requests/${number}/reply-check-passes`,
        undefined,
        z.object({ data: commentPassSchema }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pullRequest(repoId, number) }),
  });
}

export function useStartCommentPass(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (commentIds: string[]) =>
      apiSend(
        'POST',
        `/repos/${repoId}/pull-requests/${number}/comment-passes`,
        { comment_ids: commentIds },
        z.object({ data: commentPassSchema }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pullRequest(repoId, number) }),
  });
}

export function useRetryCommentPass(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, skip = false }: JobRetry) =>
      apiSend('POST', `/comment-passes/${id}/retry`, { skip }, z.object({ data: commentPassSchema })),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pullRequest(repoId, number) }),
  });
}

export function useRetryAgentReview(repoId: string, number: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, skip = false }: JobRetry) =>
      apiSend('POST', `/agent-reviews/${id}/retry`, { skip }, z.object({ data: prAgentReviewSchema })),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pullRequest(repoId, number) }),
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
    mutationFn: (input: CreateScan) => apiSend('POST', '/scans', input, z.object({ data: scanSchema })),
    onSuccess: () => refreshMonitor(client),
  });
}

/**
 * The Services Datadog has failing requests for in the range, every env together, busiest first: HTTP status 400 or
 * more, or only `codes`.
 */
export function useDatadogServices(window: ScanWindow, codes: number[], enabled: boolean) {
  const picked = [...codes].sort((a, b) => a - b);
  return useQuery({
    queryKey: [...queryKeys.monitor, 'datadog-services', window, picked],
    queryFn: () =>
      apiGet(
        `/monitor/datadog-services?window=${window}${picked.length > 0 ? `&codes=${picked.join(',')}` : ''}`,
        listOf(datadogServiceSchema),
      ).then((b) => b.data),
    enabled,
    staleTime: 2 * 60_000,
    placeholderData: (previous) => previous,
  });
}

/** The HTTP status codes from 400 up Datadog has requests for in the range, busiest first. */
export function useStatusCodes(window: ScanWindow, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.monitor, 'status-codes', window],
    queryFn: () => apiGet(`/monitor/status-codes?window=${window}`, listOf(statusCodeCountSchema)).then((b) => b.data),
    enabled,
    staleTime: 2 * 60_000,
    placeholderData: (previous) => previous,
  });
}

export function usePatchService() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      repo_id?: string | null;
      repo_url?: string | null;
      check_interval?: string | null;
    }) => {
      const { id, ...body } = input;
      return apiSend('PATCH', `/services/${id}`, body, z.object({ data: serviceSchema }));
    },
    onSuccess: () => refreshMonitor(client),
  });
}

/** Looks for a Service's code: same-name Repo, a folder next to the Repos, then the Git hosts. */
export function useFindCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string) =>
      apiSend('POST', `/services/${serviceId}/code`, undefined, z.object({ data: findCodeResultSchema })).then(
        (body) => body.data,
      ),
    onSuccess: (result) => {
      if (result.found) void refreshMonitor(client);
    },
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

/** The kinds of job whose Playbook steps run one turn each. */
export type StepJob = 'report' | 'fix' | 'agent_review' | 'reply_check' | 'comment_pass';

/** Skips the job's running step: its turn stops and the job goes on; `playbook_step.updated` brings the change. */
export function useSkipRunningStep(kind: StepJob, id: string) {
  return useMutation({
    mutationFn: () => apiSend('POST', `/jobs/${kind}/${id}/skip-step`, undefined, z.undefined()),
  });
}

export function useRetryReport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, skip = false }: JobRetry) =>
      apiSend('POST', `/reports/${id}/retry`, { skip }, z.object({ data: reportSchema })),
    onSuccess: () => refreshMonitor(client),
  });
}

export function useRetryFix(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (skip: boolean) => apiSend('POST', `/fixes/${id}/retry`, { skip }, z.object({ data: fixSchema })),
    onSuccess: () => refreshMonitor(client),
  });
}

/** Stops a Fix, undoes its branch and takes the Alert back to `verified`. */
export function useCancelFix(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('POST', `/fixes/${id}/cancel`, undefined, z.object({ data: fixSchema })),
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

/** The Dev tools screen's first question: a Session with the picked scope, then the question as its first message. */
export function useAskNewDevtoolsSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { connectionIds: string[]; settings: Partial<SessionDefaults>; text: string }) => {
      const session = await apiSend(
        'POST',
        '/sessions',
        { kind: 'devtools', connection_ids: input.connectionIds, ...input.settings },
        z.object({ data: sessionSchema }),
      ).then((body) => body.data);
      await apiSend(
        'POST',
        `/sessions/${session.id}/messages`,
        { text: input.text },
        z.object({ data: z.object({ message_id: z.string() }) }),
      );
      return session;
    },
    // The new terminal shows its tab at once, before the list is read again.
    onSuccess: (session) => {
      client.setQueryData<Session[]>([...queryKeys.sessions, 'devtools'], (list) => [session, ...(list ?? [])]);
      void client.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

/** The operator's Playbooks A to Z, then the five built-ins, and the Step blocks. */
export function usePlaybooks() {
  return useQuery({
    queryKey: queryKeys.playbooks,
    queryFn: () => apiGet('/playbooks', z.object({ data: playbookListSchema })).then((b) => b.data),
  });
}

/** Sessions name the Playbook their rules come from, so they are read again with the list. */
function usePlaybookMutation<V, R>(send: (variables: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.playbooks });
      void client.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

const playbookResponse = z.object({ data: playbookSchema });

export function useCreatePlaybook() {
  return usePlaybookMutation((body: CreatePlaybook) =>
    apiSend('POST', '/playbooks', body, playbookResponse).then((b) => b.data),
  );
}

export function useSavePlaybook() {
  return usePlaybookMutation(({ id, patch }: { id: string; patch: PlaybookPatch }) =>
    apiSend('PATCH', `/playbooks/${id}`, patch, playbookResponse).then((b) => b.data),
  );
}

export function useDeletePlaybook() {
  return usePlaybookMutation((id: string) => apiSend('DELETE', `/playbooks/${id}`, undefined, z.undefined()));
}

/** `null` detaches: the Trigger runs its built-in again. */
export function useSetTrigger() {
  return usePlaybookMutation(({ trigger, playbookId }: { trigger: PlaybookTrigger; playbookId: string | null }) =>
    apiSend('PUT', `/playbook-triggers/${trigger}`, { playbook_id: playbookId }, z.unknown()),
  );
}
