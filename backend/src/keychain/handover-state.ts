import type { KeychainHandover } from '@ops-console/shared';

export const KEYCHAIN_HANDOVER = Symbol('KEYCHAIN_HANDOVER');

/**
 * Whether this start refused the Keychain handover (`HandoverRefused`). Kept in memory: a restart clears it and
 * runs the check again.
 */
export class KeychainHandoverTracker {
  private reason: string | null = null;
  private readonly listeners = new Set<(reason: string) => void>();

  refuse(reason: string): void {
    if (this.reason !== null) return;
    this.reason = reason;
    for (const listener of this.listeners) listener(reason);
  }

  state(): KeychainHandover {
    return { refused: this.reason !== null, reason: this.reason };
  }

  onRefused(listener: (reason: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
