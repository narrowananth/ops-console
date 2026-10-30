import { Body, Controller, Delete, Get, HttpCode, Inject, Optional, Param, Patch, Post } from '@nestjs/common';
import { type Branch, importRepoSchema, type Repo, renameRepoSchema } from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { OPEN_PR_BRANCHES, type OpenPrBranches } from './open-pr-branches';
import { ReposService } from './repos.service';

const idParams = z.object({ id: z.string().min(1) });

@Controller('repos')
export class ReposController {
  constructor(
    @Inject(ReposService) private readonly repos: ReposService,
    @Optional() @Inject(OPEN_PR_BRANCHES) private readonly openPrs?: OpenPrBranches,
  ) {}

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
    const { id } = parseInput(idParams, params, 'params');
    const [branches, withPr] = await Promise.all([
      this.repos.branches(id),
      this.openPrs?.forRepo(id) ?? new Set<string>(),
    ]);
    return { data: branches.map((branch) => ({ ...branch, has_open_pr: withPr.has(branch.name) })) };
  }
}
