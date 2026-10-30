import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { type Branch, importRepoSchema, type Repo, renameRepoSchema } from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { ReposService } from './repos.service';

const idParams = z.object({ id: z.string().min(1) });

@Controller('repos')
export class ReposController {
  constructor(@Inject(ReposService) private readonly repos: ReposService) {}

  @Get()
  list() {
    return this.repos.list();
  }

  @Post()
  async import(@Body() body: unknown): Promise<{ data: Repo }> {
    return { data: await this.repos.import(parseInput(importRepoSchema, body, 'body').path) };
  }

  @Patch(':id')
  async rename(@Param() params: unknown, @Body() body: unknown): Promise<{ data: Repo }> {
    const { id } = parseInput(idParams, params, 'params');
    return { data: await this.repos.rename(id, parseInput(renameRepoSchema, body, 'body').name) };
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param() params: unknown): void {
    this.repos.remove(parseInput(idParams, params, 'params').id);
  }

  @Get(':id/branches')
  async branches(@Param() params: unknown): Promise<{ data: Branch[] }> {
    return { data: await this.repos.branches(parseInput(idParams, params, 'params').id) };
  }
}
