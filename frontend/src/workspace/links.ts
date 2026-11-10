/** The Workspace address of a Session. */
export const sessionPath = (sessionId: string) => `/workspace?${new URLSearchParams({ session: sessionId })}`;

/** The Workspace address of a pull request in an imported Repo. */
export const pullRequestPath = (repoId: string, number: number) =>
  `/workspace?${new URLSearchParams({ tab: 'pulls', pr: `${repoId}/${number}` })}`;

/** The Monitor address of an Alert. */
export const alertPath = (alertId: string) => `/monitor?${new URLSearchParams({ alert: alertId })}`;

/** Where a new Session's composer keeps its draft; the pull request view writes it before opening the Session. */
export const sessionDraftKey = (sessionId: string) => `workspace.draft.session.${sessionId}`;
