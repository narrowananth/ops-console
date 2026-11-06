import { CheckTarget, isFailing, RunHealth } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useLiveEvent } from '../lib/live';
import { useAgentRuns } from '../lib/queries';
import { readStored, useStored } from '../lib/remember';
import { HEALTH } from './run-look';

export const ALERT_NEEDS_KEY = 'agent-runs.alert-needs-you';
export const ALERT_ENDS_KEY = 'agent-runs.alert-ends';
export const ALERT_HEALTH_KEY = 'notify.alert-health';
export const alertSchema = z.boolean();

/** Asks the browser for permission to show desktop alerts; false when it is refused or not offered. */
export async function allowDesktopAlerts(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

type Seen = { title: string; health: RunHealth; running: boolean };

const show = (title: string, body: string) => {
  try {
    new Notification(title, { body });
  } catch {
    // A browser that refuses a page-made alert has nothing more to offer.
  }
};

/**
 * Desktop alerts for what the operator turned on: a run that needs them, and a run that ended. They show only while the
 * console is open in a tab, and only when that tab is not the one in front. What was already there when the page
 * loaded does not alert.
 */
export function useRunAlerts(): void {
  const runs = useAgentRuns().data;
  const seen = useRef<Map<string, Seen> | null>(null);
  useEffect(() => {
    if (!runs) return;
    const before = seen.current;
    const now = new Map<string, Seen>(
      runs.map((run) => [run.session.id, { title: run.session.title, health: run.health, running: run.running }]),
    );
    seen.current = now;
    if (before === null || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.hasFocus()) return;
    const needs = readStored(ALERT_NEEDS_KEY, alertSchema, false);
    const ends = readStored(ALERT_ENDS_KEY, alertSchema, false);
    for (const run of runs) {
      const was = before.get(run.session.id);
      if (needs && run.health === RunHealth.NeedsYou && was?.health !== RunHealth.NeedsYou) {
        show(`Needs you: ${run.session.title}`, run.health_reason);
      }
      if (ends && !run.running && was?.running) {
        show(`${HEALTH[run.health].label}: ${run.session.title}`, run.health_reason);
      }
    }
    // A run that finished leaves the list, so it is told from what was going and is gone.
    if (ends) {
      for (const [id, was] of before) {
        if (was.running && !now.has(id)) show(`Finished: ${was.title}`, 'The agent run ended.');
      }
    }
  }, [runs]);
}

/** The three desktop alerts, each kept in the browser and each asking the browser for permission when turned on. */
export function useDesktopAlerts() {
  const [needs, setNeeds] = useStored(ALERT_NEEDS_KEY, alertSchema, false);
  const [ends, setEnds] = useStored(ALERT_ENDS_KEY, alertSchema, false);
  const [health, setHealth] = useStored(ALERT_HEALTH_KEY, alertSchema, false);
  const [refused, setRefused] = useState(false);
  const change = (set: (value: boolean) => void) => async (value: boolean) => {
    if (value && !(await allowDesktopAlerts())) {
      setRefused(true);
      return;
    }
    setRefused(false);
    set(value);
  };
  return {
    needs,
    ends,
    health,
    refused,
    setNeeds: change(setNeeds),
    setEnds: change(setEnds),
    setHealth: change(setHealth),
  };
}

export type AlertsStatus = 'on' | 'off' | 'blocked';

/** What the Alerts pill says: blocked when the browser refused, on when an alert is on and allowed, else off. */
export function useAlertsStatus(): AlertsStatus {
  const [needs] = useStored(ALERT_NEEDS_KEY, alertSchema, false);
  const [ends] = useStored(ALERT_ENDS_KEY, alertSchema, false);
  const [health] = useStored(ALERT_HEALTH_KEY, alertSchema, false);
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') return 'blocked';
  const allowed = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  return allowed && (needs || ends || health) ? 'on' : 'off';
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Desktop alerts for a Connection, Connector or MCP server that starts failing, and for one that answers again, when
 * the operator turned that on. Same rules as run alerts: allowed by the browser, console open in a tab not in front.
 */
export function useHealthAlerts(): void {
  useLiveEvent((event) => {
    if (event.event !== 'health.changed') return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.hasFocus() || !readStored(ALERT_HEALTH_KEY, alertSchema, false)) return;
    const { name, target, detail, since, recovered } = event.data;
    if (recovered) return show(`Recovered: ${name}`, 'Answers again.');
    if (!isFailing(event.data.status)) return;
    const what = target === CheckTarget.Connection ? 'Connection' : 'Integration';
    const from = since ? `Failing since ${clock(since)}` : null;
    show(`${what} failing: ${name}`, [detail, from].filter(Boolean).join('. '));
  });
}
