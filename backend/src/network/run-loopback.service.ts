import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { SettingsRegistry } from '../settings/settings.registry';
import { SettingsService } from '../settings/settings.service';

/** The Setting that holds the Loopback switch: one JSON boolean, no row meaning off. */
export const RUN_SANDBOX_LOOPBACK = 'run_sandbox_loopback';

/** The Run sandbox's Loopback switch (ADR 0006), off until the operator turns it on from Permissions. */
@Injectable()
export class RunLoopback {
  constructor(
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SettingsRegistry) registry: SettingsRegistry,
  ) {
    registry.register({ key: RUN_SANDBOX_LOOPBACK, schema: z.boolean(), default: false });
  }

  /** The switch as a run starting now sees it. */
  forRun(): boolean {
    return this.settings.get(RUN_SANDBOX_LOOPBACK, z.boolean());
  }
}
