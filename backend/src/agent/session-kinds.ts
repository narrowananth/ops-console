import type { Session, SessionKind, SessionPatch } from '@ops-console/shared';
import type { SessionRow } from './sessions.service';

export type SessionKindHandler = {
  /** Where the agent runs for this Session. */
  workingDir: (session: SessionRow) => string;
  /** The Session's working folder is a git worktree of its own: its runs may write the Repo's git folder (not its hooks or config). */
  ownWorktree?: boolean;
  /** Makes ready what the Session's own runs need, such as its worktree, before each run; a throw fails the run. */
  prepare?: (session: SessionRow) => Promise<void>;
  /** Runs after the Session is deleted, to take away what it kept. Its errors are ignored. */
  removed?: (session: SessionRow) => Promise<void>;
  /** `pr_review` Sessions take no messages from the operator. */
  acceptsMessages: boolean;
  /** `POST /sessions` for this kind. A kind without it is made by the backend only. */
  create?: (body: unknown) => Promise<Session> | Session;
  /** Fields the kind adds to its Sessions' view. */
  view?: (session: SessionRow) => Partial<Session>;
  /** Applies the kind's own `PATCH` fields before the common ones are written; throws to refuse. */
  patch?: (session: SessionRow, patch: SessionPatch) => void;
  /** MCP servers left out of this Session's next run. */
  deniedServers?: (session: SessionRow) => string[];
  /** What a step shows for an MCP server: its Connection and Access Level. */
  serverLabel?: (server: string) => string | null;
  /** Runs after each run ends, such as reading which branch the agent worked on. Its errors are ignored. */
  afterRun?: (session: SessionRow, run: { startedAt: string; workingDir: string }) => Promise<void>;
  /** Appended to Claude Code's system prompt on this kind's runs. */
  instructions?: string;
};

/** Each kind's spec registers its handler; a kind with none cannot run. */
export class SessionKinds {
  private readonly handlers = new Map<SessionKind, SessionKindHandler>();
  private readonly retries = new Map<SessionKind, (session: SessionRow) => Promise<void>>();

  register(kind: SessionKind, handler: SessionKindHandler): void {
    if (this.handlers.has(kind)) throw new Error(`session kind ${kind} is registered twice`);
    this.handlers.set(kind, handler);
  }

  get(kind: SessionKind): SessionKindHandler | undefined {
    return this.handlers.get(kind);
  }

  /** How a kind that takes no messages runs its last run again; throws to refuse. */
  registerRetry(kind: SessionKind, retry: (session: SessionRow) => Promise<void>): void {
    this.retries.set(kind, retry);
  }

  retryOf(kind: SessionKind): ((session: SessionRow) => Promise<void>) | undefined {
    return this.retries.get(kind);
  }
}
