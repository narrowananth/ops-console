import { WS_PATH, WS_PROTOCOL, wsEventSchema } from '@ops-console/shared';
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from './queries';
import { sessionToken } from './session';

/** Events that land this close together refetch each query once. */
const BATCH_MS = 40;

/** Keeps queries fresh from `/ws` events. A burst, such as a Probe reporting ten servers, refetches each query once. */
export function useLiveEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    const token = sessionToken();
    if (token === null) return;
    const due = new Map<string, QueryKey>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refetch = (queryKey: QueryKey) => {
      due.set(JSON.stringify(queryKey), queryKey);
      timer ??= setTimeout(() => {
        timer = null;
        const keys = [...due.values()];
        due.clear();
        for (const key of keys) void client.invalidateQueries({ queryKey: key });
      }, BATCH_MS);
    };
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${WS_PATH}`;
    const socket = new WebSocket(url, [WS_PROTOCOL, token]);
    socket.addEventListener('message', (message) => {
      const parsed = wsEventSchema.safeParse(JSON.parse(String(message.data)));
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.event === 'settings.updated') refetch(queryKeys.settings);
      if (event.event === 'update.changed' || event.event === 'settings.updated') refetch(queryKeys.updates);
      if (
        event.event === 'account.updated' ||
        event.event === 'account.switched' ||
        event.event === 'account.removed' ||
        event.event === 'settings.updated'
      ) {
        refetch(queryKeys.accounts);
      }
      if (event.event === 'connection.checked') {
        refetch(queryKeys.mcpServers);
        refetch(queryKeys.connectors);
        refetch(queryKeys.connections);
      }
      if (event.event === 'approval.requested' || event.event === 'approval.decided') {
        refetch(queryKeys.approvals);
      }
      if (event.event === 'session.updated') {
        refetch(queryKeys.session(event.data.session_id));
        refetch(queryKeys.sessions);
      }
      if (event.event === 'session.output' || event.event === 'session.finished') {
        refetch(queryKeys.messages(event.data.session_id));
      }
      if (
        event.event === 'pull_request.refreshed' ||
        event.event === 'pull_request.commented' ||
        event.event === 'pull_request.reviewed'
      ) {
        refetch(queryKeys.pulls);
      }
      if (
        event.event === 'scan.started' ||
        event.event === 'scan.finished' ||
        event.event === 'alert.detected' ||
        event.event === 'alert.updated' ||
        event.event === 'alert.regressed' ||
        event.event === 'verification.stepped' ||
        event.event === 'alert.verified' ||
        event.event === 'alert.reviewed' ||
        event.event === 'fix.advanced' ||
        event.event === 'alert.resolved'
      ) {
        refetch(queryKeys.monitor);
      }
      if (event.event === 'pull_request.job_changed') {
        refetch(queryKeys.pullRequest(event.data.repo_id, event.data.number));
      }
      if (event.event === 'playbook_step.updated') {
        const { agent_review_id, reply_check_id, comment_pass_id } = event.data;
        if (agent_review_id !== null || reply_check_id !== null || comment_pass_id !== null) refetch(queryKeys.pulls);
        else refetch(queryKeys.monitor);
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      socket.close();
    };
  }, [client]);
}
