import { type DynamicModule, Module } from '@nestjs/common';
import { INSTALLER, type Installer } from './installer';
import { RELEASES, type ReleaseSource } from './releases';
import { UpdatesController } from './updates.controller';
import { UpdatesService } from './updates.service';

@Module({})
export class UpdatesModule {
  static forRoot(options: { releases: ReleaseSource; installer: Installer }): DynamicModule {
    return {
      module: UpdatesModule,
      controllers: [UpdatesController],
      providers: [
        UpdatesService,
        { provide: RELEASES, useValue: options.releases },
        { provide: INSTALLER, useValue: options.installer },
      ],
    };
  }
}
