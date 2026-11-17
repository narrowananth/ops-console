import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import {
  type Connector,
  type ConnectorCheck,
  ConnectorId,
  googleClientSchema,
  updateConnectorSchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { ConnectorsService } from './connectors.service';

const idParams = z.object({ id: z.enum(ConnectorId) });

@Controller('connectors')
export class ConnectorsController {
  constructor(@Inject(ConnectorsService) private readonly connectors: ConnectorsService) {}

  @Get()
  list() {
    return this.connectors.list();
  }

  /** The Google OAuth client the three Google Connectors share. The secret goes to the Keychain and is never returned. */
  @Put('google/client')
  saveGoogleClient(@Body() body: unknown) {
    return this.connectors.saveGoogleClient(parseInput(googleClientSchema, body, 'body'));
  }

  @Delete('google/client')
  removeGoogleClient() {
    return this.connectors.removeGoogleClient();
  }

  @Patch(':id')
  async update(@Param() params: unknown, @Body() body: unknown): Promise<{ data: Connector }> {
    const { id } = parseInput(idParams, params, 'params');
    return { data: await this.connectors.update(id, parseInput(updateConnectorSchema, body, 'body').config) };
  }

  @Post(':id/connect')
  @HttpCode(202)
  async connect(@Param() params: unknown): Promise<void> {
    await this.connectors.connect(parseInput(idParams, params, 'params').id);
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
