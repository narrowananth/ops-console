import type { SessionKind } from '@ops-console/shared';
import type { SessionRow } from './sessions.service';

export type SessionKindHandler = {
  /** Where the agent runs for this Session. */
  workingDir: (session: SessionRow) => string;
  /** `pr_review` Sessions take no messages from the operator. */
  acceptsMessages: boolean;
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
