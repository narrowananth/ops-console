import { Logger } from '@nestjs/common';

export type RecoveryFn = () => Promise<void> | void;

/** Start-up recovery: modules register here; the daemon runs them in order before the port opens. */
export class StartupRecovery {
  private readonly logger = new Logger('recovery');
  private readonly fns: { name: string; fn: RecoveryFn }[] = [];

  register(name: string, fn: RecoveryFn): void {
    this.fns.push({ name, fn });
  }

  async runAll(): Promise<void> {
    for (const { name, fn } of this.fns) {
      await fn();
      this.logger.log(`ran ${name}`);
    }
  }
}
