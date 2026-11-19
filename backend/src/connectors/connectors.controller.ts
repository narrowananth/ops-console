import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type Connector,
  type ConnectorCheck,
  ConnectorId,
  logGroupSchema,
  lokiConnectBodySchema,
  updateConnectorSchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { ConnectorsService } from './connectors.service';

const idParams = z.object({ id: z.enum(ConnectorId) });
/** The Log folder Connector takes its folder; CloudWatch logs its profile, region and picked groups; Loki logs its address, auth and labels. */
const connectBody = lokiConnectBodySchema.extend({
  folder: z.string().optional(),
  profile: z.string().optional(),
  region: z.string().optional(),
  log_groups: z.array(logGroupSchema).optional(),
});
const logGroupsQuery = z.object({ profile: z.string().optional(), region: z.string().optional() });

@Controller('connectors')
export class ConnectorsController {
  constructor(@Inject(ConnectorsService) private readonly connectors: ConnectorsService) {}

  @Get()
  list() {
    return this.connectors.list();
  }

  /** The log groups of a profile and region, for the CloudWatch picker; the Connector's own when none are given. */
  @Get('cloudwatch_logs/log-groups')
  async logGroups(@Query() query: unknown): Promise<{ data: { name: string }[]; meta: { next_cursor: null } }> {
    const names = await this.connectors.cloudWatchLogGroups(parseInput(logGroupsQuery, query, 'query'));
    return { data: names.map((name) => ({ name })), meta: { next_cursor: null } };
  }

  @Patch(':id')
  async update(@Param() params: unknown, @Body() body: unknown): Promise<{ data: Connector }> {
    const { id } = parseInput(idParams, params, 'params');
    return { data: await this.connectors.update(id, parseInput(updateConnectorSchema, body, 'body').config) };
  }

  @Post(':id/connect')
  @HttpCode(202)
  async connect(@Param() params: unknown, @Body() body: unknown): Promise<void> {
    await this.connectors.connect(
      parseInput(idParams, params, 'params').id,
      parseInput(connectBody, body ?? {}, 'body'),
    );
  }

  @Post(':id/checks')
  @HttpCode(200)
  async check(@Param() params: unknown): Promise<{ data: ConnectorCheck }> {
    return { data: await this.connectors.check(parseInput(idParams, params, 'params').id) };
  }

  @Delete(':id/sign-in')
  async cancelSignIn(@Param() params: unknown): Promise<{ data: Connector }> {
    return { data: await this.connectors.cancelSignIn(parseInput(idParams, params, 'params').id) };
  }

  @Delete(':id/credentials')
  async disconnect(@Param() params: unknown): Promise<{ data: Connector }> {
    return { data: await this.connectors.disconnect(parseInput(idParams, params, 'params').id) };
  }
}
