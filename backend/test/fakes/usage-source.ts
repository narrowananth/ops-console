import type { UsageReading, UsageSource } from '../../src/accounts/usage-source';

/** Usage by config dir, set by a test; a dir with none reads as no credential. */
export class FakeUsageSource implements UsageSource {
  private readonly readings = new Map<string, UsageReading | Error>();

  set(configDir: string, reading: UsageReading | Error): void {
    this.readings.set(configDir, reading);
  }

  /** The config dirs asked for, in order. */
  readonly asked: string[] = [];

  async read(configDir: string): Promise<UsageReading | null> {
    this.asked.push(configDir);
    const reading = this.readings.get(configDir);
    if (reading instanceof Error) throw reading;
    return reading ?? null;
  }
}
