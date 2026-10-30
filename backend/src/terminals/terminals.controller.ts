import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { createTerminalSchema, terminalSecretSchema } from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { TerminalsService } from './terminals.service';

const idParams = z.object({ id: z.string().min(1) });
const toolParams = z.object({ id: z.string().min(1), tool: z.string().min(1) });

@Controller('terminals')
export class TerminalsController {
  constructor(@Inject(TerminalsService) private readonly terminals: TerminalsService) {}

  @Post()
  async create(@Body() body: unknown): Promise<{ data: { id: string } }> {
    return { data: await this.terminals.create(parseInput(createTerminalSchema, body, 'body').kind) };
  }

  @Post(':id/secrets')
  @HttpCode(204)
  answer(@Param() params: unknown, @Body() body: unknown): void {
    const { request_id, value } = parseInput(terminalSecretSchema, body, 'body');
    this.terminals.answerSecret(parseInput(idParams, params, 'params').id, request_id, value);
  }

  /** The setup agent's tools. They run the same code as the REST endpoints. */
  @Post(':id/tools/:tool')
  @HttpCode(200)
  async tool(@Param() params: unknown, @Body() body: unknown): Promise<{ data: unknown }> {
    const { id, tool } = parseInput(toolParams, params, 'params');
    return {
      data: await this.terminals.runTool(id, tool, parseInput(z.record(z.string(), z.unknown()), body ?? {}, 'body')),
    };
  }
}
