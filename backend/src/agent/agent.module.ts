import { type DynamicModule, Module } from '@nestjs/common';
import { AccountsController } from '../accounts/accounts.controller';
import { AccountsService } from '../accounts/accounts.service';
import { CliProxyController } from '../accounts/cliproxy.controller';
import { CliProxyService } from '../accounts/cliproxy.service';
import { USAGE_SOURCE } from '../accounts/usage-source';
import { ActionLogController, ApprovalsController } from '../action-log/action-log.controller';
import { ActionLogService } from '../action-log/action-log.service';
import { ApprovalsService } from '../action-log/approvals.service';
import { NetworkAllowlistController } from '../network/network-allowlist.controller';
import { NetworkAllowlistService } from '../network/network-allowlist.service';
import { JobSteps } from '../playbooks/job-steps';
import { PlaybooksController } from '../playbooks/playbooks.controller';
import { PlaybooksService } from '../playbooks/playbooks.service';
import { SkillsController } from '../playbooks/skills.controller';
import { SkillsService } from '../playbooks/skills.service';
import { AGENT_CONFIG, type AgentConfig } from './agent-config';
import { Attachments } from './attachments';
import { ConnectionLookup } from './connection-lookup';
import { MessageInterceptors } from './message-interceptors';
import { ProdWriteRule } from './prod-write-rule';
import { RunRegistry } from './runs';
import { AgentRuntime } from './runtime';
import { SessionKinds } from './session-kinds';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { Transcripts } from './transcripts';

/**
 * The agent runtime, Sessions, Playbooks, Claude accounts, the Action Log and Approvals. Kind specs register a working
 * directory with `SessionKinds` and create Sessions through `SessionsService.create`.
 */
@Module({})
export class AgentModule {
  static forRoot(config: AgentConfig): DynamicModule {
    return {
      module: AgentModule,
      global: true,
      controllers: [
        SessionsController,
        ActionLogController,
        ApprovalsController,
        AccountsController,
        CliProxyController,
        PlaybooksController,
        SkillsController,
        NetworkAllowlistController,
      ],
      providers: [
        { provide: AGENT_CONFIG, useValue: config },
        { provide: USAGE_SOURCE, useValue: config.usage },
        RunRegistry,
        SessionKinds,
        MessageInterceptors,
        ConnectionLookup,
        ProdWriteRule,
        Transcripts,
        Attachments,
        ActionLogService,
        ApprovalsService,
        AccountsService,
        CliProxyService,
        SessionsService,
        NetworkAllowlistService,
        AgentRuntime,
        PlaybooksService,
        SkillsService,
        JobSteps,
      ],
      exports: [
        RunRegistry,
        CliProxyService,
        SessionKinds,
        MessageInterceptors,
        ConnectionLookup,
        ConnectionLookup,
        ProdWriteRule,
        SessionsService,
        ActionLogService,
        AgentRuntime,
        AccountsService,
        PlaybooksService,
        SkillsService,
        JobSteps,
      ],
    };
  }
}
