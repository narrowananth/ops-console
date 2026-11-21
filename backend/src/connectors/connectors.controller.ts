import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type AwsProfile,
  type Connector,
  type ConnectorCheck,
  ConnectorId,
  connectBodySchema,
  type Pickable,
  updateConnectorSchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { ConnectorsService } from './connectors.service';

const idParams = z.object({ id: z.enum(ConnectorId) });
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

  /** The Loki data sources of the signed-in stack, for the picker. */
  @Get('loki_logs/datasources')
  async lokiDatasources(): Promise<{ data: Pickable[]; meta: { next_cursor: null } }> {
    return { data: await this.connectors.lokiDatasources(), meta: { next_cursor: null } };
  }

  /** The New Relic accounts the sign-in can read, for the picker. */
  @Get('new_relic_logs/accounts')
  async newRelicAccounts(): Promise<{ data: Pickable[]; meta: { next_cursor: null } }> {
    return { data: await this.connectors.newRelicAccountList(), meta: { next_cursor: null } };
  }

  /** The AWS profiles on this Mac, for the CloudWatch picker. */
  @Get('cloudwatch_logs/profiles')
  async awsProfiles(): Promise<{ data: AwsProfile[]; meta: { next_cursor: null } }> {
    return { data: await this.connectors.awsProfileList(), meta: { next_cursor: null } };
  }

  /** Opens the folder dialog for the Log folder. Nothing is stored: the path goes back to the pane, and Connect uses it. */
  @Post('otel_logs/pick-folder')
  @HttpCode(200)
  async pickFolder(): Promise<{ data: { path: string | null } }> {
    return { data: { path: await this.connectors.pickLogFolder() } };
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
      parseInput(connectBodySchema, body ?? {}, 'body'),
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
