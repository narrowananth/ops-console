import { type DynamicModule, Module } from '@nestjs/common';
import { LOCAL_SERVER_SCANNER, type LocalServerScanner, LsofScanner } from './local-servers';
import { ProcessGateway } from './process-gateway';
import { ProcessesController } from './processes.controller';
import { ProcessesService } from './processes.service';

/** Session processes: commands the daemon runs for a Session as the operator, their terminals and the local servers they start. */
@Module({})
export class ProcessesModule {
  /** `scanner` finds the listening servers; tests pass a fake. */
  static forRoot(options: { scanner?: LocalServerScanner } = {}): DynamicModule {
    return {
      module: ProcessesModule,
      global: true,
      controllers: [ProcessesController],
      providers: [
        ProcessesService,
        ProcessGateway,
        { provide: LOCAL_SERVER_SCANNER, useValue: options.scanner ?? new LsofScanner() },
      ],
      exports: [ProcessesService],
    };
  }
}
