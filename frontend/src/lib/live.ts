import { WS_PATH, WS_PROTOCOL, type WsEvent, wsEventSchema } from '@ops-console/shared';
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { playChime, unlockChime } from './chime';
import { queryKeys } from './queries';
import { sessionToken } from './session';

type Listener = (event: WsEvent) => void;
const listeners = new Set<Listener>();

/** Runs `listener` for every event the console's one socket brings, for as long as the caller is mounted. */
export function useLiveEvent(listener: Listener): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => {
    const call: Listener = (event) => latest.current(event);
    listeners.add(call);
    return () => void listeners.delete(call);
  }, []);
}

/** Events that land this close together refetch each query once. */
const BATCH_MS = 40;

/**
 * A running agent's events come many times a second, and each refetch behind them is heavy for the daemon: the whole
 * transcript, or the whole pull request list. These refetch at most this often per query.
 */
const STREAM_MS = 400;
const LIST_MS = 5000;

/** Wait before the socket reopens after it drops, doubling to the cap. */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

/** Keeps queries fresh from `/ws` events. A burst, such as a Probe reporting ten servers, refetches each query once. */
export function useLiveEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    const token = sessionToken();
    if (token === null) return;
    const due = new Map<string, QueryKey>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const ran = new Map<string, number>();
    const waiting = new Map<string, ReturnType<typeof setTimeout>>();
    /** Like `refetch`, but a query already refetched within `every` ms waits out the rest; events meanwhile make one. */
    const refetchEvery = (queryKey: QueryKey, every: number) => {
      const id = JSON.stringify(queryKey);
      if (waiting.has(id)) return;
      const wait = Math.max(0, (ran.get(id) ?? 0) + every - Date.now());
      waiting.set(
        id,
        setTimeout(() => {
          waiting.delete(id);
          ran.set(id, Date.now());
          void client.invalidateQueries({ queryKey });
        }, wait),
      );
    };
    const refetch = (queryKey: QueryKey) => {
      due.set(JSON.stringify(queryKey), queryKey);
      timer ??= setTimeout(() => {
        timer = null;
        const keys = [...due.values()];
        due.clear();
        for (const key of keys) void client.invalidateQueries({ queryKey: key });
      }, BATCH_MS);
    };
    // Audio may start only after the operator touched the page.
    document.addEventListener('pointerdown', unlockChime);
    document.addEventListener('keydown', unlockChime);
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${WS_PATH}`;
    let socket: WebSocket | null = null;
    let reopen: ReturnType<typeof setTimeout> | null = null;
    let wait = RECONNECT_MIN_MS;
    let dropped = false;
    const onMessage = (message: MessageEvent) => {
      const parsed = wsEventSchema.safeParse(JSON.parse(String(message.data)));
      if (!parsed.success) return;
      const event = parsed.data;
      for (const listener of listeners) listener(event);
      if (event.event === 'settings.updated') {
        refetch(queryKeys.settings);
        refetch(queryKeys.cliProxy);
      }
      if (event.event === 'keychain.wait_changed') refetch(queryKeys.keychainWait);
      if (event.event === 'keychain.handover_refused') refetch(queryKeys.keychainHandover);
      if (event.event === 'update.changed' || event.event === 'settings.updated') refetch(queryKeys.updates);
      if (
        event.event === 'account.updated' ||
        event.event === 'account.switched' ||
        event.event === 'account.removed' ||
        event.event === 'settings.updated'
      ) {
        refetch(queryKeys.accounts);
      }
      if (event.event === 'connection.checked' || event.event === 'health.changed') refetch(queryKeys.healthWatch);
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
        refetch(queryKeys.sessionDiff(event.data.session_id));
      }
      if (event.event === 'session.output') refetchEvery(queryKeys.messages(event.data.session_id), STREAM_MS);
      if (event.event === 'session.finished') refetch(queryKeys.messages(event.data.session_id));
      if (event.event === 'session.finished') {
        refetch(queryKeys.outputs(event.data.session_id));
        refetch(queryKeys.sessionDiff(event.data.session_id));
        // Only the operator's own runs: a Monitor job's steps would chime once per step.
        if (event.data.started_by === 'operator') playChime(event.data.status);
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
      if (event.event === 'skills.changed') {
        refetch(queryKeys.skills);
        refetch(queryKeys.playbooks);
        refetch(queryKeys.skillPacks);
      }
      if (event.event === 'playbook_step.updated') {
        const { agent_review_id, reply_check_id, comment_pass_id } = event.data;
        if (agent_review_id !== null || reply_check_id !== null || comment_pass_id !== null) {
          // The open pull request shows its steps; the list, 750 KB across every Repo, only follows.
          refetch(queryKeys.pullRequestDetails);
          refetchEvery(queryKeys.pullRequestLists, LIST_MS);
          refetchEvery(queryKeys.pullRequestRepoLists, LIST_MS);
        } else refetch(queryKeys.monitor);
      }
    };
    const connect = () => {
      const current = sessionToken();
      if (closed || current === null) return;
      const next = new WebSocket(url, [WS_PROTOCOL, current]);
      socket = next;
      next.addEventListener('open', () => {
        wait = RECONNECT_MIN_MS;
        // Events sent while the socket was down are gone: read everything the pages show again.
        if (dropped) void client.invalidateQueries();
        dropped = false;
      });
      next.addEventListener('message', onMessage);
      next.addEventListener('close', () => {
        if (closed || socket !== next) return;
        dropped = true;
        reopen = setTimeout(connect, wait);
        wait = Math.min(wait * 2, RECONNECT_MAX_MS);
      });
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (reopen) clearTimeout(reopen);
      for (const wake of waiting.values()) clearTimeout(wake);
      socket?.close();
      document.removeEventListener('pointerdown', unlockChime);
      document.removeEventListener('keydown', unlockChime);
    };
  }, [client]);
}
