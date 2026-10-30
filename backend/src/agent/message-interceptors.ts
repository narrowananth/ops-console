import type { SessionRow } from './sessions.service';

/** Returns true when it handled the message itself; the message then starts no run. */
export type MessageInterceptor = (session: SessionRow, text: string) => boolean;

/** Lets a kind's spec act on an operator message before it reaches the agent. */
export class MessageInterceptors {
  private readonly all: MessageInterceptor[] = [];

  register(interceptor: MessageInterceptor): void {
    this.all.push(interceptor);
  }

  handle(session: SessionRow, text: string): boolean {
    return this.all.some((interceptor) => interceptor(session, text));
  }
}
