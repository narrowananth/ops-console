import { type ConnectionTestResult, type ConnectionType, HealthStatus } from '@ops-console/shared';
import type { ConnectionTester } from '../../src/connections/connection-tester';
import type { Launch } from '../../src/connections/launch';

/** Answers every test with `next`, and keeps what the server would have been started with. */
export class FakeConnectionTester implements ConnectionTester {
  next: ConnectionTestResult = { status: HealthStatus.Ok, latency_ms: 12, detail: null };
  readonly runs: { type: ConnectionType; launch: Launch; pool?: string }[] = [];
  /** How long each test takes, as a server starting does. */
  delayMs = 0;
  /** The most tests running at the same time. */
  mostAtOnce = 0;
  readonly forgotten: string[] = [];
  private running = 0;

  async run(type: ConnectionType, launch: Launch, pool?: string): Promise<ConnectionTestResult> {
    this.runs.push({ type, launch, pool });
    this.running += 1;
    this.mostAtOnce = Math.max(this.mostAtOnce, this.running);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    } finally {
      this.running -= 1;
    }
    return this.next;
  }

  async forget(pool: string): Promise<void> {
    this.forgotten.push(pool);
  }
}
