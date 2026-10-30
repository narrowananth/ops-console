import { HealthStatus } from '@ops-console/shared';

export const statusGlyph: Record<HealthStatus, { glyph: string; className: string }> = {
  [HealthStatus.Ok]: { glyph: '● connected', className: 'text-text' },
  [HealthStatus.Auth]: { glyph: '◐ needs auth', className: 'text-accent-700' },
  [HealthStatus.Fail]: { glyph: '✕ failed', className: 'text-accent-700' },
  [HealthStatus.Off]: { glyph: '○ disabled', className: 'text-neutral-700' },
};
