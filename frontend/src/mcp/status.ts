import { HealthStatus } from '@ops-console/shared';

export type StatusLook = { glyph: string; className: string; tip: string };

export const statusGlyph: Record<HealthStatus, StatusLook> = {
  [HealthStatus.Ok]: {
    glyph: '● connected',
    className: 'text-ok',
    tip: 'The last check reached it. The agent can use it.',
  },
  [HealthStatus.Auth]: {
    glyph: '◐ needs auth',
    className: 'text-accent-700',
    tip: 'It needs a sign-in before the agent can use it.',
  },
  [HealthStatus.Fail]: {
    glyph: '✕ failed',
    className: 'text-accent-700',
    tip: 'The last check could not reach it. The reason shows on the row; Reconnect checks again.',
  },
  [HealthStatus.Off]: {
    glyph: '○ disabled',
    className: 'text-neutral-700',
    tip: 'Turned off. New Claude sessions do not get it.',
  },
  [HealthStatus.Checking]: {
    glyph: '◌ checking',
    className: 'text-neutral-700',
    tip: 'The console is checking it now.',
  },
};
