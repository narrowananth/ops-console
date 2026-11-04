import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import {
  createPlaybookSchema,
  type Playbook,
  type PlaybookList,
  PlaybookTrigger,
  playbookPatchSchema,
  setTriggerSchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { JobSteps } from './job-steps';
import { PlaybooksService } from './playbooks.service';

const idParams = z.object({ id: z.string().min(1) });
const triggerParams = z.object({ trigger: z.enum(PlaybookTrigger) });
const jobParams = z.object({
  kind: z.enum(['report', 'fix', 'agent_review', 'reply_check', 'comment_pass']),
  id: z.string().min(1),
});

@Controller()
export class PlaybooksController {
  constructor(
    @Inject(PlaybooksService) private readonly playbooks: PlaybooksService,
    @Inject(JobSteps) private readonly steps: JobSteps,
  ) {}

  /** Skips the job's running step: its turn stops and the job goes on from the next step. */
  @Post('jobs/:kind/:id/skip-step')
  @HttpCode(204)
  skipStep(@Param() params: unknown): void {
    this.steps.skipRunning(parseInput(jobParams, params, 'params'));
  }

  @Get('playbooks')
  list(): { data: PlaybookList } {
    return { data: this.playbooks.list() };
  }

  @Post('playbooks')
  create(@Body() body: unknown): { data: Playbook } {
    return { data: this.playbooks.create(parseInput(createPlaybookSchema, body, 'body')) };
  }

  @Patch('playbooks/:id')
  update(@Param() params: unknown, @Body() body: unknown): { data: Playbook } {
    const { id } = parseInput(idParams, params, 'params');
    return { data: this.playbooks.patch(id, parseInput(playbookPatchSchema, body, 'body')) };
  }

  @Delete('playbooks/:id')
  @HttpCode(204)
  remove(@Param() params: unknown): void {
    this.playbooks.remove(parseInput(idParams, params, 'params').id);
  }

  @Put('playbook-triggers/:trigger')
  setTrigger(@Param() params: unknown, @Body() body: unknown): { data: Playbook[] } {
    const { trigger } = parseInput(triggerParams, params, 'params');
    return { data: this.playbooks.setTrigger(trigger, parseInput(setTriggerSchema, body, 'body').playbook_id) };
  }
}
