import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { answerSecretRequestSchema, type SecretRequest } from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { AnonymousToolsService } from './anonymous-tools.service';

const sessionParams = z.object({ id: z.string().min(1) });
const requestParams = z.object({ id: z.string().min(1), request_id: z.string().min(1) });

@Controller('sessions/:id/secret-requests')
export class AnonymousToolsController {
  constructor(@Inject(AnonymousToolsService) private readonly tools: AnonymousToolsService) {}

  /** The masked fields this Session's agent waits on, for a page that opens after one was asked. */
  @Get()
  list(@Param() params: unknown): { data: SecretRequest[] } {
    return { data: this.tools.pending(parseInput(sessionParams, params, 'params').id) };
  }

  /** The operator's answer. Nothing here logs or returns the value. */
  @Post(':request_id')
  @HttpCode(204)
  answer(@Param() params: unknown, @Body() body: unknown): void {
    const { id, request_id } = parseInput(requestParams, params, 'params');
    this.tools.answer(id, request_id, parseInput(answerSecretRequestSchema, body, 'body').value);
  }
}
