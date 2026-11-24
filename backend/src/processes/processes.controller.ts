import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { createProcessBodySchema, type LocalServer, type Scripts, type SessionProcess } from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { ProcessesService } from './processes.service';

const idParams = z.object({ id: z.string().min(1) });
const serverParams = z.object({ id: z.string().min(1), port: z.coerce.number().int().min(1).max(65535) });
const scriptsQuery = z.object({ folder: z.string().min(1).max(4096).optional() });

@Controller()
export class ProcessesController {
  constructor(@Inject(ProcessesService) private readonly processes: ProcessesService) {}

  @Get('sessions/:id/processes')
  list(@Param() params: unknown): { data: SessionProcess[] } {
    return { data: this.processes.list(parseInput(idParams, params, 'params').id) };
  }

  @Post('sessions/:id/processes')
  async start(@Param() params: unknown, @Body() body: unknown): Promise<{ data: SessionProcess }> {
    const { id } = parseInput(idParams, params, 'params');
    return { data: await this.processes.start(id, parseInput(createProcessBodySchema, body, 'body')) };
  }

  @Post('processes/:id/stop')
  @HttpCode(200)
  async stop(@Param() params: unknown): Promise<{ data: SessionProcess }> {
    return { data: await this.processes.stop(parseInput(idParams, params, 'params').id) };
  }

  @Post('processes/:id/restart')
  @HttpCode(200)
  async restart(@Param() params: unknown): Promise<{ data: SessionProcess }> {
    return { data: await this.processes.restart(parseInput(idParams, params, 'params').id) };
  }

  @Delete('processes/:id')
  @HttpCode(204)
  async remove(@Param() params: unknown): Promise<void> {
    await this.processes.remove(parseInput(idParams, params, 'params').id);
  }

  @Get('sessions/:id/scripts')
  async scripts(@Param() params: unknown, @Query() query: unknown): Promise<{ data: Scripts }> {
    const { id } = parseInput(idParams, params, 'params');
    return { data: await this.processes.scripts(id, parseInput(scriptsQuery, query, 'query').folder) };
  }

  @Post('sessions/:id/local-servers/:port/stop')
  @HttpCode(204)
  async stopServer(@Param() params: unknown): Promise<void> {
    const { id, port } = parseInput(serverParams, params, 'params');
    await this.processes.stopServer(id, port);
  }

  @Get('sessions/:id/local-servers')
  async localServers(@Param() params: unknown): Promise<{ data: { servers: LocalServer[] } }> {
    return { data: { servers: await this.processes.localServers(parseInput(idParams, params, 'params').id) } };
  }
}
