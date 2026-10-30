import { type DynamicModule, Module } from '@nestjs/common';
import { AccountsController } from '../accounts/accounts.controller';
import { AccountsService } from '../accounts/accounts.service';
import { ActionLogController, ApprovalsController } from '../action-log/action-log.controller';
import { ActionLogService } from '../action-log/action-log.service';
import { ApprovalsService } from '../action-log/approvals.service';
import { AGENT_CONFIG, type AgentConfig } from './agent-config';
import { ProdWriteRule } from './prod-write-rule';
import { RunRegistry } from './runs';
import { AgentRuntime } from './runtime';
import { SessionKinds } from './session-kinds';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { Transcripts } from './transcripts';

/**
 * The agent runtime, Sessions, Claude accounts, the Action Log and Approvals. Kind specs register a working
 * directory with `SessionKinds` and create Sessions through `SessionsService.create`.
 */
@Module({})
export class AgentModule {
  static forRoot(config: AgentConfig): DynamicModule {
    return {
      module: AgentModule,
      global: true,
      controllers: [SessionsController, ActionLogController, ApprovalsController, AccountsController],
      providers: [
        { provide: AGENT_CONFIG, useValue: config },
        RunRegistry,
        SessionKinds,
        ProdWriteRule,
        Transcripts,
        ActionLogService,
        ApprovalsService,
        AccountsService,
        SessionsService,
        AgentRuntime,
      ],
      exports: [SessionKinds, ProdWriteRule, SessionsService, ActionLogService, AgentRuntime],
    };
  }
}
