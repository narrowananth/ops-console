import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type Message,
  type Page,
  type Session,
  SessionKind,
  sendMessageSchema,
  sessionListQuerySchema,
  sessionPatchSchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { parseInput, validationFailed } from '../common/errors';
import { AgentRuntime } from './runtime';
import { SessionKinds } from './session-kinds';
import { SessionsService } from './sessions.service';

const idParams = z.object({ id: z.string().min(1) });

/** Routes shared by every kind; each kind's own fields come from its handler in `SessionKinds`. */
@Controller('sessions')
export class SessionsController {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(SessionKinds) private readonly kinds: SessionKinds,
  ) {}

  /** Each kind's spec makes its own Sessions; a body without a `kind` is a `repo` Session. */
  @Post()
  async create(@Body() body: unknown): Promise<{ data: Session }> {
    const named = typeof body === 'object' && body !== null && 'kind' in body ? body.kind : SessionKind.Repo;
    const create = Object.values(SessionKind).includes(named as SessionKind)
      ? this.kinds.get(named as SessionKind)?.create
      : undefined;
    if (!create) throw validationFailed('invalid body: kind');
    return { data: await create(body) };
  }

  @Get()
  list(@Query() query: unknown): Page<Session> {
    return this.sessions.list(parseInput(sessionListQuerySchema, query, 'query'));
  }

  @Get(':id')
  get(@Param() params: unknown): { data: Session } {
    return { data: this.sessions.view(this.sessions.get(parseInput(idParams, params, 'params').id)) };
  }

  @Patch(':id')
  update(@Param() params: unknown, @Body() body: unknown): { data: Session } {
    const { id } = parseInput(idParams, params, 'params');
    return { data: this.sessions.view(this.sessions.update(id, parseInput(sessionPatchSchema, body, 'body'))) };
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
