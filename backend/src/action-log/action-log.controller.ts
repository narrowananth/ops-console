import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  type ActionLogRow,
  type Approval,
  actionLogQuerySchema,
  approvalDecisionSchema,
  approvalListQuerySchema,
  type Page,
} from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { ActionLogService } from './action-log.service';
import { ApprovalsService } from './approvals.service';

/** Read only: no route updates or deletes an Action Log row (Behavior 16). */
@Controller('action-log')
export class ActionLogController {
  constructor(@Inject(ActionLogService) private readonly actionLog: ActionLogService) {}

  @Get()
  list(@Query() query: unknown): Page<ActionLogRow> {
    return this.actionLog.list(parseInput(actionLogQuerySchema, query, 'query'));
  }
}

@Controller('approvals')
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  @Get()
  list(@Query() query: unknown): Page<Approval> {
    return this.approvals.list(parseInput(approvalListQuerySchema, query, 'query'));
  }

  @Post(':id/decision')
  decide(@Param() params: unknown, @Body() body: unknown): { data: Approval } {
    const { id } = parseInput(z.object({ id: z.string().min(1) }), params, 'params');
    return { data: this.approvals.decide(id, parseInput(approvalDecisionSchema, body, 'body').decision) };
  }
}
