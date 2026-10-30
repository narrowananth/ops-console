import { WS_PATH, WS_PROTOCOL, wsEventSchema } from '@ops-console/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from './queries';
import { sessionToken } from './session';

/** Keeps queries fresh from `/ws` events: the server sends each change once, so a refetch per event is enough. */
export function useLiveEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    const token = sessionToken();
    if (token === null) return;
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${WS_PATH}`;
    const socket = new WebSocket(url, [WS_PROTOCOL, token]);
    socket.addEventListener('message', (message) => {
      const parsed = wsEventSchema.safeParse(JSON.parse(String(message.data)));
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.event === 'settings.updated') void client.invalidateQueries({ queryKey: queryKeys.settings });
      if (
        event.event === 'account.updated' ||
        event.event === 'account.switched' ||
        event.event === 'account.removed' ||
        event.event === 'settings.updated'
      ) {
        void client.invalidateQueries({ queryKey: queryKeys.accounts });
      }
      if (event.event === 'connection.checked') {
        void client.invalidateQueries({ queryKey: queryKeys.mcpServers });
        void client.invalidateQueries({ queryKey: queryKeys.connectors });
        void client.invalidateQueries({ queryKey: queryKeys.connections });
      }
      if (event.event === 'approval.requested' || event.event === 'approval.decided') {
        void client.invalidateQueries({ queryKey: queryKeys.approvals });
      }
      if (event.event === 'session.updated') {
        void client.invalidateQueries({ queryKey: queryKeys.session(event.data.session_id) });
        void client.invalidateQueries({ queryKey: queryKeys.sessions });
      }
      if (event.event === 'session.output' || event.event === 'session.finished') {
        void client.invalidateQueries({ queryKey: queryKeys.messages(event.data.session_id) });
      }
      if (
        event.event === 'pull_request.refreshed' ||
        event.event === 'pull_request.commented' ||
        event.event === 'pull_request.reviewed'
      ) {
        void client.invalidateQueries({ queryKey: queryKeys.pulls });
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
        void client.invalidateQueries({ queryKey: queryKeys.monitor });
      }
    });
    return () => socket.close();
  }, [client]);
}
