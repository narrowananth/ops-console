import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type Message,
  type Page,
  type Session,
  sendMessageSchema,
  sessionListQuerySchema,
  sessionPatchSchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { AgentRuntime } from './runtime';
import { SessionsService, toSession } from './sessions.service';

const idParams = z.object({ id: z.string().min(1) });

/** `POST /sessions` belongs to each kind's spec; these routes are shared by every kind. */
@Controller('sessions')
export class SessionsController {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
  ) {}

  @Get()
  list(@Query() query: unknown): Page<Session> {
    return this.sessions.list(parseInput(sessionListQuerySchema, query, 'query'));
  }

  @Get(':id')
  get(@Param() params: unknown): { data: Session } {
    return { data: toSession(this.sessions.get(parseInput(idParams, params, 'params').id)) };
  }

  @Patch(':id')
  update(@Param() params: unknown, @Body() body: unknown): { data: Session } {
    const { id } = parseInput(idParams, params, 'params');
    return { data: toSession(this.sessions.update(id, parseInput(sessionPatchSchema, body, 'body'))) };
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param() params: unknown): void {
    this.sessions.remove(parseInput(idParams, params, 'params').id);
  }

  @Get(':id/messages')
  async messages(@Param() params: unknown): Promise<{ data: Message[]; meta: { next_cursor: null } }> {
    const data = await this.runtime.messages(parseInput(idParams, params, 'params').id);
    return { data, meta: { next_cursor: null } };
  }

  @Post(':id/messages')
  @HttpCode(202)
  send(@Param() params: unknown, @Body() body: unknown): { data: { message_id: string } } {
    const { id } = parseInput(idParams, params, 'params');
    return { data: this.runtime.send(id, parseInput(sendMessageSchema, body, 'body').text) };
  }
}
