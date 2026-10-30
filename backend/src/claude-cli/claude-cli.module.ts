import { type DynamicModule, Module } from '@nestjs/common';
import { CLAUDE_CLI, ClaudeCli } from './claude-cli';

@Module({})
export class ClaudeCliModule {
  static forRoot(bin: string): DynamicModule {
    return {
      module: ClaudeCliModule,
      global: true,
      providers: [{ provide: CLAUDE_CLI, useValue: new ClaudeCli(bin) }],
      exports: [CLAUDE_CLI],
    };
  }
}
