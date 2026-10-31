import { type DynamicModule, Module } from '@nestjs/common';
import { FOLDER_PICKER, type FolderPicker, MacFolderPicker } from './folder-picker';
import { GIT, Git } from './git';
import { ReposController } from './repos.controller';
import { ReposService } from './repos.service';

/** Settings › Repos: local git repositories the console runs Sessions in. */
@Module({})
export class ReposModule {
  static forRoot(config: { picker?: FolderPicker } = {}): DynamicModule {
    return {
      module: ReposModule,
      global: true,
      controllers: [ReposController],
      providers: [
        { provide: GIT, useValue: new Git() },
        { provide: FOLDER_PICKER, useValue: config.picker ?? new MacFolderPicker() },
        ReposService,
      ],
      exports: [ReposService, GIT],
    };
  }
}
