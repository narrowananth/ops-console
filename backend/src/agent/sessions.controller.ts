import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import {
  type AgentRun,
  type Attachment,
  type EditedMessage,
  type Message,
  type Page,
  type RunDetail,
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
import { RunInsights } from './run-insights.service';
import { RunRegistry } from './runs';
import { AgentRuntime } from './runtime';
import { SessionKinds } from './session-kinds';
import { SessionsService } from './sessions.service';

const idParams = z.object({ id: z.string().min(1) });
const editParams = idParams.extend({ message_id: z.string().min(1) });
const fileParams = idParams.extend({ file: z.string().min(1) });
const attachQuery = z.object({ name: z.string().trim().min(1).max(255) });

/** The Running tray. */
@Controller('agent-runs')
export class AgentRunsController {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(RunInsights) private readonly insights: RunInsights,
    @Inject(RunRegistry) private readonly registry: RunRegistry,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
  ) {}

  @Get()
  list(): { data: AgentRun[]; meta: { next_cursor: null } } {
    return { data: this.insights.list(), meta: { next_cursor: null } };
  }

  /** What runs that ended today cost together. */
  @Get('usage')
  usage(): { data: { cost_usd: number; tokens: number; runs: number } } {
    return { data: this.insights.usageToday() };
  }

  /** One run with its steps, where the time went, and why it is slow or failed. */
  @Get(':id')
  detail(@Param() params: unknown): { data: RunDetail } {
    return { data: this.insights.detail(parseInput(idParams, params, 'params').id) };
  }

  /** Stops every run going. */
  @Post('stop-all')
  @HttpCode(200)
  stopAll(): { data: { stopped: number } } {
    const ids = this.registry.sessionIds();
    for (const id of ids) this.runtime.stop(id);
    return { data: { stopped: ids.length } };
  }

  /** Takes every ended run out of the tray. */
  @Delete()
  @HttpCode(200)
  dismissAll(): { data: { dismissed: number } } {
    return { data: { dismissed: this.sessions.dismissEndedRuns() } };
  }

  /** Dismisses the run of the Session `id`: it leaves the tray. */
  @Delete(':id')
  @HttpCode(204)
  dismiss(@Param() params: unknown): void {
    this.sessions.dismissRun(parseInput(idParams, params, 'params').id);
  }
}

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

  /** Ends the Session's run like Stop, and keeps it in the Running tray for Play. */
  @Post(':id/pause')
  @HttpCode(204)
  pause(@Param() params: unknown): void {
    this.runtime.stop(parseInput(idParams, params, 'params').id, true);
  }

  /** Queues a message behind the run: it goes out when the run ends, unless the operator stops the run. */
  @Put(':id/queue')
  @HttpCode(200)
  queue(@Param() params: unknown, @Body() body: unknown): { data: { queued: boolean } } {
    const { text } = parseInput(sendMessageSchema, body, 'body');
    return { data: this.runtime.queue(parseInput(idParams, params, 'params').id, text) };
  }

  /** Takes the queued message back. */
  @Delete(':id/queue')
  @HttpCode(204)
  takeBack(@Param() params: unknown): void {
    this.runtime.takeBack(parseInput(idParams, params, 'params').id);
  }

  /** Sends the queued message now, stopping a run that goes first. */
  @Post(':id/queue/send')
  @HttpCode(204)
  sendQueued(@Param() params: unknown): void {
    this.runtime.sendQueuedNow(parseInput(idParams, params, 'params').id);
  }

  /** Starts a paused, stopped or failed run again; 409 `session_busy` while a run is going. */
  @Post(':id/resume')
  @HttpCode(202)
  async resume(@Param() params: unknown): Promise<{ data: { message_id: string } }> {
    return { data: await this.runtime.resumeRun(parseInput(idParams, params, 'params').id) };
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

  /** A file attached to one of the Session's messages, to open in the console. */
  @Get(':id/attachments/:file')
  file(@Param() params: unknown): StreamableFile {
    const { id, file } = parseInput(fileParams, params, 'params');
    this.sessions.get(id);
    const found = this.attachments.read(id, file);
    return new StreamableFile(found.stream, {
      type: found.type,
      length: found.size,
      disposition: 'inline',
    });
  }

  @Post(':id/messages')
  @HttpCode(202)
  send(@Param() params: unknown, @Body() body: unknown): { data: { message_id: string } } {
    const { id } = parseInput(idParams, params, 'params');
    return { data: this.runtime.send(id, parseInput(sendMessageSchema, body, 'body').text) };
  }
}
