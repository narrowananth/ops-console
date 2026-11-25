import { type DynamicModule, Module } from '@nestjs/common';
import { AnonymousToolsController } from './anonymous-tools.controller';
import { AnonymousToolsService } from './anonymous-tools.service';
import { LOCAL_KEYCHAIN, type LocalKeychain, SecurityCliKeychain } from './local-sources';

/** The setup tools an Anonymous Session's agent gets: Connections, Connectors, MCP Servers, local reads, masked secrets. */
@Module({})
export class AnonymousToolsModule {
  /** `localKeychain` is where the agent finds other apps' saved passwords; tests pass a fake. */
  static forRoot(options: { localKeychain?: LocalKeychain } = {}): DynamicModule {
    return {
      module: AnonymousToolsModule,
      controllers: [AnonymousToolsController],
      providers: [
        AnonymousToolsService,
        { provide: LOCAL_KEYCHAIN, useValue: options.localKeychain ?? new SecurityCliKeychain() },
      ],
    };
  }
}
