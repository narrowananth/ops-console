import { type DynamicModule, Module } from '@nestjs/common';
import { TerminalGateway } from './terminal-gateway';
import { TerminalsController } from './terminals.controller';
import { TerminalsService } from './terminals.service';

/** Terminals behind an authenticated WebSocket. Dev tools uses the setup terminal; the Workspace adds more kinds. */
@Module({})
export class TerminalsModule {
  static forRoot(): DynamicModule {
    return {
      module: TerminalsModule,
      controllers: [TerminalsController],
      providers: [TerminalsService, TerminalGateway],
      exports: [TerminalsService],
    };
  }
}
