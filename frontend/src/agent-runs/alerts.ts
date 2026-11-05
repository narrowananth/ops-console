import { RunHealth } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useAgentRuns } from '../lib/queries';
import { readStored, useStored } from '../lib/remember';
import { HEALTH } from './run-look';

export const ALERT_NEEDS_KEY = 'agent-runs.alert-needs-you';
export const ALERT_ENDS_KEY = 'agent-runs.alert-ends';
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

/** The Alerts pill: on when either desktop alert is on; turning it on asks the browser once and turns both on. */
export function useAlertsToggle(): { on: boolean; refused: boolean; toggle: () => Promise<void> } {
  const [needs, setNeeds] = useStored(ALERT_NEEDS_KEY, alertSchema, false);
  const [ends, setEnds] = useStored(ALERT_ENDS_KEY, alertSchema, false);
  const [refused, setRefused] = useState(false);
  const on = needs || ends;
  const toggle = async () => {
    if (on) {
      setNeeds(false);
      setEnds(false);
      return;
    }
    if (!(await allowDesktopAlerts())) {
      setRefused(true);
      return;
    }
    setRefused(false);
    setNeeds(true);
    setEnds(true);
  };
  return { on, refused, toggle };
}
