import { z } from 'zod';

export enum GitHost {
  Github = 'github',
  Bitbucket = 'bitbucket',
  Gitlab = 'gitlab',
  Local = 'local',
}

export const repoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The top folder of the repository on this machine. */
  path: z.string(),
  host: z.enum(GitHost),
  /** `owner/name` on the host; null for a local Repo. */
  remote_slug: z.string().nullable(),
  default_branch: z.string(),
  created_at: z.string(),
  /** Read from git on every read; null when the folder is gone. */
  branch: z.string().nullable(),
  dirty: z.boolean(),
  missing: z.boolean(),
});

export type Repo = z.infer<typeof repoSchema>;

export const repoListSchema = z.object({ data: z.array(repoSchema), meta: z.object({ next_cursor: z.null() }) });

export const importRepoSchema = z.object({ path: z.string().trim().min(1) });

export const renameRepoSchema = z.object({ name: z.string().trim().min(1) });

export const branchSchema = z.object({ name: z.string(), current: z.boolean() });

export type Branch = z.infer<typeof branchSchema>;
