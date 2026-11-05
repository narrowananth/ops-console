import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { createSkillSchema, type Skill, type SkillList, skillPatchSchema } from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { SkillsService } from './skills.service';

const idParams = z.object({ id: z.string().min(1) });

@Controller('skills')
export class SkillsController {
  constructor(@Inject(SkillsService) private readonly skills: SkillsService) {}

  @Get()
  list(): { data: SkillList } {
    return { data: this.skills.list() };
  }

  @Post()
  create(@Body() body: unknown): { data: Skill } {
    return { data: this.skills.create(parseInput(createSkillSchema, body, 'body')) };
  }

  @Patch(':id')
  update(@Param() params: unknown, @Body() body: unknown): { data: Skill } {
    const { id } = parseInput(idParams, params, 'params');
    return { data: this.skills.patch(id, parseInput(skillPatchSchema, body, 'body')) };
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param() params: unknown): void {
    this.skills.remove(parseInput(idParams, params, 'params').id);
  }
}
