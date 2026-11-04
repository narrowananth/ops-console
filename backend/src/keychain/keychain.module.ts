import { type DynamicModule, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { WsHub } from '../common/ws-hub';
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

@Module({})
export class KeychainModule {
  static forRoot(keychain: Keychain, wait: KeychainWaitTracker): DynamicModule {
    return {
      module: KeychainModule,
      global: true,
      providers: [
        { provide: KEYCHAIN, useValue: keychain },
        { provide: KEYCHAIN_WAIT, useValue: wait },
        KeychainWaitEvents,
      ],
      exports: [KEYCHAIN, KEYCHAIN_WAIT],
    };
  }
}
