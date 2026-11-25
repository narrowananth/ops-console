/** The address of a Session on the Sessions page. */
export const sessionPath = (sessionId: string) => `/sessions?${new URLSearchParams({ session: sessionId })}`;

/** The address of one message in a Session: the Sessions page opens the Session with that message in view. */
export const messageLink = (sessionId: string, messageId: string) =>
  `/sessions?${new URLSearchParams({ session: sessionId, message: messageId })}`;

/** The address of a pull request in an imported Repo, on the Pull requests page. */
export const pullRequestPath = (repoId: string, number: number) =>
  `/pull-requests?${new URLSearchParams({ pr: `${repoId}/${number}` })}`;

/** The Monitor address of an Alert. */
export const alertPath = (alertId: string) => `/monitor?${new URLSearchParams({ alert: alertId })}`;

/** Where a new Session's composer keeps its draft; the pull request view writes it before opening the Session. */
export const sessionDraftKey = (sessionId: string) => `workspace.draft.session.${sessionId}`;
