import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  type Attachment,
  type EditedMessage,
  type Message,
  type Page,
  type Session,
  SessionKind,
  sendMessageSchema,
  sessionListQuerySchema,
  sessionPatchSchema,
} from '@ops-console/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { parseInput, validationFailed } from '../common/errors';
import { Attachments } from './attachments';
import { AgentRuntime } from './runtime';
import { SessionKinds } from './session-kinds';
import { SessionsService } from './sessions.service';

const idParams = z.object({ id: z.string().min(1) });
const editParams = idParams.extend({ message_id: z.string().min(1) });
const attachQuery = z.object({ name: z.string().trim().min(1).max(255) });

/** Routes shared by every kind; each kind's own fields come from its handler in `SessionKinds`. */
@Controller('sessions')
export class SessionsController {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(SessionKinds) private readonly kinds: SessionKinds,
    @Inject(Attachments) private readonly attachments: Attachments,
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

  /** Edits the last message and runs it again (Behavior 8a). */
  @Post(':id/messages/:message_id/edit')
  @HttpCode(202)
  async edit(@Param() params: unknown, @Body() body: unknown): Promise<{ data: EditedMessage }> {
    const { id, message_id } = parseInput(editParams, params, 'params');
    return { data: await this.runtime.edit(id, message_id, parseInput(sendMessageSchema, body, 'body').text) };
  }

  /** Ends the Session's run; 409 `invalid_state` when none is going. */
  @Post(':id/stop')
  @HttpCode(204)
  stop(@Param() params: unknown): void {
    this.runtime.stop(parseInput(idParams, params, 'params').id);
  }

  @Get(':id/messages')
  async messages(@Param() params: unknown): Promise<{ data: Message[]; meta: { next_cursor: null } }> {
    const data = await this.runtime.messages(parseInput(idParams, params, 'params').id);
    return { data, meta: { next_cursor: null } };
  }

  /** Saves the request body as a file for the Session's next message; `name` is the operator's file name. */
  @Post(':id/attachments')
  @HttpCode(201)
  async attach(
    @Param() params: unknown,
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<{ data: Attachment }> {
    const { id } = parseInput(idParams, params, 'params');
    const { name } = parseInput(attachQuery, query, 'query');
    this.sessions.get(id);
    return { data: await this.attachments.save(id, name, request) };
  }

  @Post(':id/messages')
  @HttpCode(202)
  send(@Param() params: unknown, @Body() body: unknown): { data: { message_id: string } } {
    const { id } = parseInput(idParams, params, 'params');
    return { data: this.runtime.send(id, parseInput(sendMessageSchema, body, 'body').text) };
  }
}
