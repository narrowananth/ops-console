import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  type Connection,
  type ConnectionTestResult,
  createConnectionSchema,
  testConnectionSchema,
  updateConnectionSchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { ConnectionsService } from './connections.service';

const idParams = z.object({ id: z.string().min(1) });

@Controller('connections')
export class ConnectionsController {
  constructor(@Inject(ConnectionsService) private readonly connections: ConnectionsService) {}

  @Get()
  list() {
    return this.connections.list();
  }

  @Post()
  async create(@Body() body: unknown): Promise<{ data: Connection }> {
    return { data: await this.connections.create(parseInput(createConnectionSchema, body, 'body')) };
  }

  @Post('tests')
  @HttpCode(200)
  async test(@Body() body: unknown): Promise<{ data: ConnectionTestResult }> {
    const { type, config, secret } = parseInput(testConnectionSchema, body, 'body');
    return { data: await this.connections.test(type, config, secret ?? null) };
  }

  @Patch(':id')
  async update(@Param() params: unknown, @Body() body: unknown): Promise<{ data: Connection }> {
    const { id } = parseInput(idParams, params, 'params');
    return { data: await this.connections.update(id, parseInput(updateConnectionSchema, body, 'body')) };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param() params: unknown): Promise<void> {
    await this.connections.remove(parseInput(idParams, params, 'params').id);
  }

  @Post(':id/checks')
  @HttpCode(200)
  async check(@Param() params: unknown) {
    return { data: await this.connections.check(parseInput(idParams, params, 'params').id) };
  }
}
