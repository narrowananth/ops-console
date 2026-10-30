import { type DynamicModule, Module } from '@nestjs/common';
import { KEYCHAIN, type Keychain } from './keychain';

@Module({})
export class KeychainModule {
  static forRoot(keychain: Keychain): DynamicModule {
    return {
      module: KeychainModule,
      global: true,
      providers: [{ provide: KEYCHAIN, useValue: keychain }],
      exports: [KEYCHAIN],
    };
  }
}
