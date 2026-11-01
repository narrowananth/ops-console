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
import { PlaybooksService } from './playbooks.service';

const idParams = z.object({ id: z.string().min(1) });
const triggerParams = z.object({ trigger: z.enum(PlaybookTrigger) });

@Controller()
export class PlaybooksController {
  constructor(@Inject(PlaybooksService) private readonly playbooks: PlaybooksService) {}

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
