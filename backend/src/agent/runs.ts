import type { Part } from '@ops-console/shared';

/** A run in progress. It lives in memory only: a daemon restart ends it (Behavior 18). */
export type Run = {
  sessionId: string;
  /** The in-flight agent message `session.output` streams into. */
  messageId: string;
  accountId: string;
  workingDir: string;
  parts: Part[];
  /** The text part growing from stream deltas, until its block arrives whole. */
  growing: number | null;
  /** Transcript entries this run wrote; listing serves them from `parts` instead. */
  sdkUuids: Set<string>;
  /** Action Log row per tool call. */
  toolRows: Map<string, string>;
  /** Set while the agent waits for the operator's answer to its question. */
  answer: ((text: string) => void) | null;
  /** Approvals the run waits on. */
  waits: number;
  createdAt: string;
  /** Set when the console started the run itself, with no operator message. */
  onFinish: ((summary: RunSummary) => void) | null;
  /** Called with each whole part the agent finishes, in order; set by the code that started the run. */
  onPart: ((part: Part) => void) | null;
};

/** How a run ended, for the code that started it. */
export type RunSummary = { ok: boolean; text: string };

export class RunRegistry {
  private readonly runs = new Map<string, Run>();

  get(sessionId: string): Run | undefined {
    return this.runs.get(sessionId);
  }

  add(run: Run): void {
    this.runs.set(run.sessionId, run);
  }

  remove(sessionId: string): void {
    this.runs.delete(sessionId);
  }

  onAccount(accountId: string): boolean {
    return [...this.runs.values()].some((run) => run.accountId === accountId);
  }
}
