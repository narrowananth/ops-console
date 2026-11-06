import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { HealthOverview } from '@ops-console/shared';
import { HealthWatch } from './health-watch.service';

@Controller('health-watch')
export class HealthWatchController {
  constructor(@Inject(HealthWatch) private readonly watch: HealthWatch) {}

  @Get()
  async overview(): Promise<{ data: HealthOverview }> {
    return { data: await this.watch.overview() };
  }

  /** Check now: starts a run of the area and answers at once. */
  @Post(':area/checks')
  @HttpCode(202)
  async check(@Param('area') area: string): Promise<{ data: HealthOverview }> {
    this.watch.start(this.watch.area(area));
    return { data: await this.watch.overview() };
  }
}
