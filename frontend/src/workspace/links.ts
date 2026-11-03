import type { Message } from '@ops-console/shared';

/** The Workspace address of a Session. */
export const sessionPath = (sessionId: string) => `/workspace?${new URLSearchParams({ session: sessionId })}`;

/** The Workspace address of a pull request in an imported Repo. */
export const pullRequestPath = (repoId: string, number: number) =>
  `/workspace?${new URLSearchParams({ tab: 'pulls', pr: `${repoId}/${number}` })}`;

/** The Monitor address of an Alert. */
export const alertPath = (alertId: string) => `/monitor?${new URLSearchParams({ alert: alertId })}`;

/** Where a new Session's composer keeps its draft; the pull request view writes it before opening the Session. */
export const sessionDraftKey = (sessionId: string) => `workspace.draft.session.${sessionId}`;

/**
 * The pull request the agent last named in a Session's conversation, such as the link `gh pr create` prints. Reads
 * the agent's text, steps and code, newest message first; null when none names one.
 */
export function pullRequestNamedIn(messages: Message[]): { url: string; number: number } | null {
  for (const message of messages.toReversed()) {
    if (message.role !== 'agent') continue;
    for (const part of message.parts.toReversed()) {
      if (part.kind !== 'text' && part.kind !== 'step' && part.kind !== 'code') continue;
      const found = [...part.text.matchAll(PULL_URL)].at(-1);
      if (found?.[1] && found[2]) return { url: found[1], number: Number(found[2]) };
    }
  }
  return null;
}

const PULL_URL = /(https?:\/\/[^\s)>\]"'`]+\/(?:pull|pull-requests|merge_requests)\/(\d+))/g;
