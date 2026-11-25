import { Controller, Get, Inject } from '@nestjs/common';
import type { KeychainHandover, KeychainWait } from '@ops-console/shared';
import { KEYCHAIN_HANDOVER, type KeychainHandoverTracker } from './handover-state';
import { KEYCHAIN_WAIT, type KeychainWaitTracker } from './keychain-wait';

/** The Keychain's state for the console: the wait banner and a refused handover on Accounts & Usage. */
@Controller('terminals')
export class KeychainController {
  constructor(
    @Inject(KEYCHAIN_WAIT) private readonly wait: KeychainWaitTracker,
    @Inject(KEYCHAIN_HANDOVER) private readonly handover: KeychainHandoverTracker,
  ) {}

  @Get('keychain-wait')
  readWait(): { data: KeychainWait } {
    return { data: this.wait.state() };
  }

  @Get('keychain-handover')
  readHandover(): { data: KeychainHandover } {
    return { data: this.handover.state() };
  }
}
