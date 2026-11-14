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
  /** The `owner/name` the folder's `origin` names, when it differs from `remote_slug`: the host moved the Repo and git was not told. */
  origin_slug: z.string().nullable(),
  default_branch: z.string(),
  created_at: z.string(),
  /** Read from git on every read; null when the folder is gone. */
  branch: z.string().nullable(),
  dirty: z.boolean(),
  missing: z.boolean(),
  /** Sessions in this Repo; removing it asks whether to keep or delete them. */
  session_count: z.number().int(),
});

export type Repo = z.infer<typeof repoSchema>;

/** What removing a Repo does with its Sessions. */
export enum RemovedRepoSessions {
  /** Hidden with the Repo; importing the same folder again brings both back. */
  Keep = 'keep',
  Delete = 'delete',
}

/** Needed only when the Repo has Sessions. */
export const removeRepoQuerySchema = z.object({ sessions: z.enum(RemovedRepoSessions).optional() });

export const repoListSchema = z.object({ data: z.array(repoSchema), meta: z.object({ next_cursor: z.null() }) });

export const importRepoSchema = z.object({ path: z.string().trim().min(1) });

export const renameRepoSchema = z.object({ name: z.string().trim().min(1) });

export const branchSchema = z.object({
  name: z.string(),
  current: z.boolean(),
  /** Whether the Git host lists an open pull request from this branch. */
  has_open_pr: z.boolean(),
});

export type Branch = z.infer<typeof branchSchema>;
