import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { createMcpServerSchema, type McpServer, updateMcpServerSchema } from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { McpServersService } from './mcp-servers.service';

const nameParams = z.object({ name: z.string().min(1) });

@Controller('mcp-servers')
export class McpServersController {
  constructor(@Inject(McpServersService) private readonly servers: McpServersService) {}

  @Get()
  list() {
    return this.servers.list();
  }

  @Post()
  async create(@Body() body: unknown): Promise<{ data: McpServer }> {
    return { data: await this.servers.create(parseInput(createMcpServerSchema, body, 'body')) };
  }

  @Patch(':name')
  async update(@Param() params: unknown, @Body() body: unknown): Promise<{ data: McpServer }> {
    const { name } = parseInput(nameParams, params, 'params');
    return { data: await this.servers.update(name, parseInput(updateMcpServerSchema, body, 'body')) };
  }

  @Post(':name/checks')
  @HttpCode(200)
  async reconnect(@Param() params: unknown): Promise<{ data: McpServer }> {
    return { data: await this.servers.reconnect(parseInput(nameParams, params, 'params').name) };
  }

  @Post(':name/auth')
  @HttpCode(202)
  async authenticate(@Param() params: unknown): Promise<void> {
    await this.servers.authenticate(parseInput(nameParams, params, 'params').name);
  }

  @Delete(':name/credentials')
  async remove(@Param() params: unknown): Promise<{ data: McpServer }> {
    return { data: await this.servers.remove(parseInput(nameParams, params, 'params').name) };
  }
}
