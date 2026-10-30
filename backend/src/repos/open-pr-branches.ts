export const OPEN_PR_BRANCHES = Symbol('OPEN_PR_BRANCHES');

/** Which of a Repo's branches have an open pull request. The Workspace provides it; without one no branch has. */
export interface OpenPrBranches {
  /** Empty when the Git host cannot be read: a branch list never fails for it. */
  forRepo(repoId: string): Promise<Set<string>>;
}
