import { z } from 'zod';

/** Where the installed console stands against the newest release on GitHub. */
export enum UpdateStatus {
  /** `pnpm dev`: no release to compare with, nothing to install. */
  Dev = 'dev',
  /** Not checked yet since the daemon started. */
  Unknown = 'unknown',
  UpToDate = 'up_to_date',
  Available = 'available',
  /** An update waits for the agent runs going to finish. */
  Waiting = 'waiting',
  /** Installing; the console restarts on the new version when it is done. */
  Updating = 'updating',
  /** The last install failed; `error` says why. */
  Failed = 'failed',
}

export const releaseSchema = z.object({
  version: z.string(),
  published_at: z.string().nullable(),
  /** The release page on GitHub. */
  url: z.string(),
  /** The release notes, Markdown. */
  notes: z.string().nullable(),
});
export type Release = z.infer<typeof releaseSchema>;

export const updateStateSchema = z.object({
  current: z.string(),
  latest: releaseSchema.nullable(),
  status: z.enum(UpdateStatus),
  checked_at: z.string().nullable(),
  /** Why the last check or install failed. */
  error: z.string().nullable(),
  auto_update: z.boolean(),
  /** Agent runs going now; an update waits for them. */
  runs_going: z.number().int(),
  /** Set when this start is the first on a new version. */
  updated: z.object({ from: z.string(), at: z.string(), automatic: z.boolean() }).nullable(),
});
export type UpdateState = z.infer<typeof updateStateSchema>;

export const updatesSettingSchema = z.object({ auto_update: z.boolean() });
export type UpdatesSetting = z.infer<typeof updatesSettingSchema>;

export enum UpdateWhen {
  /** Install at once, stopping the agent runs going. */
  Now = 'now',
  /** Install once no agent run is going. */
  Idle = 'idle',
}

export const installUpdateSchema = z.strictObject({ when: z.enum(UpdateWhen) });
export type InstallUpdate = z.infer<typeof installUpdateSchema>;
