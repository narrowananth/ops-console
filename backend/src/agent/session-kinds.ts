import type { Session, SessionKind, SessionPatch } from '@ops-console/shared';
import type { SessionRow } from './sessions.service';

export type SessionKindHandler = {
  /** Where the agent runs for this Session. */
  workingDir: (session: SessionRow) => string;
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
};

/** Each kind's spec registers its handler; a kind with none cannot run. */
export class SessionKinds {
  private readonly handlers = new Map<SessionKind, SessionKindHandler>();

  register(kind: SessionKind, handler: SessionKindHandler): void {
    if (this.handlers.has(kind)) throw new Error(`session kind ${kind} is registered twice`);
    this.handlers.set(kind, handler);
  }

  get(kind: SessionKind): SessionKindHandler | undefined {
    return this.handlers.get(kind);
  }
}
