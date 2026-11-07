import { Controller, Get, Inject, Query } from '@nestjs/common';
import { type SkillMenu, skillMenuQuerySchema } from '@ops-console/shared';
import { parseInput } from '../common/errors';
import { SkillMenuService } from './skill-menu.service';

/** The `/` menu above a Session's composer. */
@Controller('skill-menu')
export class SkillMenuController {
  constructor(@Inject(SkillMenuService) private readonly menu: SkillMenuService) {}

  @Get()
  list(@Query() query: unknown): { data: SkillMenu } {
    return { data: this.menu.menu(parseInput(skillMenuQuerySchema, query, 'query')) };
  }
}
