import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateDevtoolsSession,
  createDevtoolsSessionSchema,
  type Session,
  SessionKind,
} from '@ops-console/shared';
import { ConnectionScopes, RESULT_BLOCK, scopedConnections } from '../agent/connection-scopes';
import { SessionKinds } from '../agent/session-kinds';
import { SessionsService } from '../agent/sessions.service';
import { DATA_DIR } from '../common/data-dir';
import { parseInput } from '../common/errors';

/** How a Dev tools run answers, so the console can draw Results and a Comparison (`10-dev-tools-compare`). */
export const INSTRUCTIONS = `You answer questions about the operator's databases and queues through the MCP servers you have; each server is one Connection.

- A question that names no Connection or database type goes to every Connection you can reach. One that names a Connection or a type ("in mongo", "pg-tenant") goes only to those. Before the first query, say in one line which Connections you picked.
- Only read unless the operator asks for a change.
- ${RESULT_BLOCK}
- When Results from two or more Connections describe the same thing, write one fenced block with the language ops-compare:
  {"key": "<field you matched on>", "value": "<its value>", "connections": ["<name>", "<name>"], "rows": [{"field": "<field>", "values": ["<value per connection, null when missing>"]}]}
  Match fields that mean the same thing even when their names differ. Put the fields that disagree first.
- End with one line: "<rows> rows across <answered> of <queried> Connections", then one sentence on what differs, or that nothing was shared.
- Write blocks as plain JSON, no comments.`;

/** Sessions that query the operator's databases and queues through the Connections' MCP servers. */
@Injectable()
export class DevtoolsSessionsService {
  constructor(
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(ConnectionScopes) private readonly scopes: ConnectionScopes,
    @Inject(SessionKinds) kinds: SessionKinds,
  ) {
    kinds.register(SessionKind.Devtools, {
      workingDir: () => this.folder(),
      acceptsMessages: true,
      create: (body) => this.create(parseInput(createDevtoolsSessionSchema, body, 'body')),
      // Empty means every Connection with access here.
      ...scopedConnections(scopes, 'all'),
      instructions: INSTRUCTIONS,
    });
  }

  create(input: CreateDevtoolsSession): Session {
    const ids = [...new Set(input.connection_ids)];
    this.scopes.check(ids);
    const row = this.sessions.create({
      kind: SessionKind.Devtools,
      model: input.model,
      effort: input.effort,
      access_mode: input.access_mode,
    });
    this.scopes.set(row.id, ids);
    return this.sessions.view(row);
  }

  /** The agent has no Repo here; this folder holds what it writes while it answers. */
  private folder(): string {
    const dir = path.join(this.dataDir, 'devtools');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
}
