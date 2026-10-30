import { type ConnectionTestResult, type ConnectionType, HealthStatus } from '@ops-console/shared';
import type { ConnectionTester } from '../../src/connections/connection-tester';
import type { Launch } from '../../src/connections/launch';

/** Answers every test with `next`, and keeps what the server would have been started with. */
export class FakeConnectionTester implements ConnectionTester {
  next: ConnectionTestResult = { status: HealthStatus.Ok, latency_ms: 12, detail: null };
  readonly runs: { type: ConnectionType; launch: Launch }[] = [];

  async run(type: ConnectionType, launch: Launch): Promise<ConnectionTestResult> {
    this.runs.push({ type, launch });
    return this.next;
  }
}
