import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION = Symbol('SESSION');

/** Issued once per daemon start (ADR 0003). */
export class Session {
  readonly token = randomBytes(32).toString('base64url');
  readonly startedAt = new Date().toISOString();

  constructor(readonly version: string) {}

  accepts(candidate: string | undefined): boolean {
    if (candidate === undefined) return false;
    const expected = Buffer.from(this.token);
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
