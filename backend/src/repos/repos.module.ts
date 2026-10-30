import { type DynamicModule, Module } from '@nestjs/common';
import { GIT, Git } from './git';
import { ReposController } from './repos.controller';
import { ReposService } from './repos.service';

/** Settings › Repos: local git repositories the console runs Sessions in. */
@Module({})
export class ReposModule {
  static forRoot(): DynamicModule {
    return {
      module: ReposModule,
      global: true,
      controllers: [ReposController],
      providers: [{ provide: GIT, useValue: new Git() }, ReposService],
      exports: [ReposService],
    };
  }
}
