import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type Alert,
  type AlertDetail,
  type AlertEvent,
  alertsQuerySchema,
  createScanSchema,
  type DatadogService,
  datadogServicesQuerySchema,
  type FindCodeResult,
  type Fix,
  type MonitorEnv,
  patchRouteSchema,
  patchServiceSchema,
  type Report,
  type Review,
  reviewAlertSchema,
  type Scan,
  type Service,
  type StatusCodeCount,
  scansQuerySchema,
  servicesQuerySchema,
  statusCodesQuerySchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { AlertsService } from './alerts.service';
import { CodeFinder } from './code-finder';
import { FixesService } from './fixes.service';
import { ReviewsService } from './reviews.service';
import { ScansService } from './scans.service';
import { ServicesService } from './services.service';
import { VerificationsService } from './verifications.service';

const idParams = z.object({ id: z.string().min(1) });
const list = <T>(data: T[]) => ({ data, meta: { next_cursor: null } });

@Controller()
export class MonitorController {
  constructor(
    @Inject(ServicesService) private readonly services: ServicesService,
    @Inject(ScansService) private readonly scans: ScansService,
    @Inject(CodeFinder) private readonly finder: CodeFinder,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(VerificationsService) private readonly verifications: VerificationsService,
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
    @Inject(FixesService) private readonly fixes: FixesService,
  ) {}

  @Get('services')
  listServices(@Query() query: unknown): { data: Service[]; meta: { next_cursor: null } } {
    return list(this.services.list(parseInput(servicesQuerySchema, query, 'query').env));
  }

  @Patch('services/:id')
  patchService(@Param() params: unknown, @Body() body: unknown): { data: Service } {
    const { id } = parseInput(idParams, params, 'params');
    return { data: this.services.patch(id, parseInput(patchServiceSchema, body, 'body')) };
  }

  /** Looks for the Service's code now: same-name Repo, a folder next to the Repos, then the Git hosts. */
  @Post('services/:id/code')
  @HttpCode(200)
  async findCode(@Param() params: unknown): Promise<{ data: FindCodeResult }> {
    const { id } = parseInput(idParams, params, 'params');
    this.services.get(id);
    const { found, tried } = await this.finder.find(id);
    return { data: { service: this.services.get(id), found, tried } };
  }

  @Patch('routes/:id')
  patchRoute(@Param() params: unknown, @Body() body: unknown) {
    const { id } = parseInput(idParams, params, 'params');
    return { data: this.services.patchRoute(id, parseInput(patchRouteSchema, body, 'body')) };
  }

  @Get('scans')
  listScans(@Query() query: unknown): { data: Scan[]; meta: { next_cursor: null } } {
    return list(this.scans.list(parseInput(scansQuerySchema, query, 'query').service_id));
  }

  @Get('scans/:id')
  getScan(@Param() params: unknown) {
    return { data: this.scans.get(parseInput(idParams, params, 'params').id) };
  }

  @Post('scans')
  @HttpCode(202)
  async startScan(@Body() body: unknown): Promise<{ data: Scan }> {
    return { data: await this.scans.start(parseInput(createScanSchema, body, 'body')) };
  }

  @Get('monitor/envs')
  async envs(): Promise<{ data: MonitorEnv[] }> {
    return { data: await this.scans.envs() };
  }

  @Get('monitor/datadog-services')
  async datadogServices(@Query() query: unknown): Promise<{ data: DatadogService[] }> {
    const { window, envs, codes } = parseInput(datadogServicesQuerySchema, query, 'query');
    return { data: await this.scans.datadogServices(window, envs, codes ?? []) };
  }

  /** The HTTP status codes from 400 up with requests in the range, every env together, busiest first. */
  @Get('monitor/status-codes')
  async statusCodes(@Query() query: unknown): Promise<{ data: StatusCodeCount[] }> {
    const { window } = parseInput(statusCodesQuerySchema, query, 'query');
    return { data: await this.scans.statusCodes(window) };
  }

  @Get('alerts')
  listAlerts(@Query() query: unknown): { data: Alert[]; meta: { next_cursor: null } } {
    return list(this.alerts.list(parseInput(alertsQuerySchema, query, 'query')));
  }

  @Get('alerts/:id')
  getAlert(@Param() params: unknown): { data: AlertDetail } {
    return { data: this.alerts.detail(parseInput(idParams, params, 'params').id) };
  }

  @Get('alerts/:id/events')
  events(@Param() params: unknown): { data: AlertEvent[]; meta: { next_cursor: null } } {
    return list(this.alerts.events(parseInput(idParams, params, 'params').id));
  }

  @Get('alerts/:id/reports')
  reports(@Param() params: unknown): { data: Report[]; meta: { next_cursor: null } } {
    return list(this.alerts.reports(parseInput(idParams, params, 'params').id));
  }

  @Get('reports/:id')
  report(@Param() params: unknown): { data: Report } {
    return { data: this.alerts.report(parseInput(idParams, params, 'params').id) };
  }

  @Post('alerts/:id/verifications')
  @HttpCode(202)
  async verify(@Param() params: unknown): Promise<{ data: Report }> {
    return { data: await this.verifications.start(parseInput(idParams, params, 'params').id) };
  }

  @Post('alerts/:id/review')
  @HttpCode(200)
  review(@Param() params: unknown, @Body() body: unknown): { data: Review & { fix: Fix | null } } {
    const { id } = parseInput(idParams, params, 'params');
    const result = this.reviews.review(id, parseInput(reviewAlertSchema, body, 'body'));
    return { data: { ...result.review, fix: result.fix } };
  }

  @Delete('alerts/:id/review')
  @HttpCode(204)
  undo(@Param() params: unknown): void {
    this.reviews.undo(parseInput(idParams, params, 'params').id);
  }

  @Get('fixes/:id')
  getFix(@Param() params: unknown): { data: Fix } {
    return { data: this.fixes.get(parseInput(idParams, params, 'params').id) };
  }

  @Post('fixes/:id/retry')
  @HttpCode(202)
  retry(@Param() params: unknown): { data: Fix } {
    return { data: this.fixes.retry(parseInput(idParams, params, 'params').id) };
  }
}
