import { type DynamicModule, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { WsHub } from '../common/ws-hub';
import { KEYCHAIN_HANDOVER, type KeychainHandoverTracker } from './handover-state';
import { KEYCHAIN, type Keychain } from './keychain';
import { KEYCHAIN_WAIT, type KeychainWaitTracker } from './keychain-wait';

/** Tells every browser when the Keychain wait starts, changes or ends (`keychain.wait_changed`). */
@Injectable()
class KeychainWaitEvents implements OnModuleInit {
  constructor(
    @Inject(KEYCHAIN_WAIT) private readonly wait: KeychainWaitTracker,
    @Inject(WsHub) private readonly hub: WsHub,
  ) {}

  onModuleInit(): void {
    this.wait.onChange((state) =>
      this.hub.publish({ event: 'keychain.wait_changed', at: new Date().toISOString(), data: state }),
    );
  }
}

/** Tells every browser when the Keychain handover is refused (`keychain.handover_refused`). */
@Injectable()
class KeychainHandoverEvents implements OnModuleInit {
  constructor(
    @Inject(KEYCHAIN_HANDOVER) private readonly handover: KeychainHandoverTracker,
    @Inject(WsHub) private readonly hub: WsHub,
  ) {}

  onModuleInit(): void {
    this.handover.onRefused((reason) =>
      this.hub.publish({
        event: 'keychain.handover_refused',
        at: new Date().toISOString(),
        data: { refused: true, reason },
      }),
    );
  }
}

@Module({})
export class KeychainModule {
  static forRoot(keychain: Keychain, wait: KeychainWaitTracker, handover: KeychainHandoverTracker): DynamicModule {
    return {
      module: KeychainModule,
      global: true,
      providers: [
        { provide: KEYCHAIN, useValue: keychain },
        { provide: KEYCHAIN_WAIT, useValue: wait },
        { provide: KEYCHAIN_HANDOVER, useValue: handover },
        KeychainWaitEvents,
        KeychainHandoverEvents,
      ],
      exports: [KEYCHAIN, KEYCHAIN_WAIT, KEYCHAIN_HANDOVER],
    };
  }
}
