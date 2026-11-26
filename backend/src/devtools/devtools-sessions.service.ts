import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { SessionKind } from '@ops-console/shared';
import {
  CLOSING_LINE,
  COMPARE_BLOCK,
  ConnectionScopes,
  RESULT_BLOCK,
  scopedConnections,
} from '../agent/connection-scopes';
import { SessionKinds } from '../agent/session-kinds';
import { DATA_DIR } from '../common/data-dir';

/** How a run in an earlier Dev tools Session answers. */
export const INSTRUCTIONS = `You answer questions about the operator's databases and queues through the MCP servers you have; each server is one Connection.

- A question that names no Connection or database type goes to every Connection you can reach. One that names a Connection or a type ("in mongo", "pg-tenant") goes only to those. Before the first query, say in one line which Connections you picked.
- Only read unless the operator asks for a change.
- ${RESULT_BLOCK}
- ${COMPARE_BLOCK}
- ${CLOSING_LINE}
- Write blocks as plain JSON, no comments.`;

/** Earlier Sessions of the `devtools` kind: they open, run and keep their scope, but none can be made any more. */
@Injectable()
export class DevtoolsSessionsService {
  constructor(
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(ConnectionScopes) scopes: ConnectionScopes,
    @Inject(SessionKinds) kinds: SessionKinds,
  ) {
    kinds.register(SessionKind.Devtools, {
      workingDir: () => this.folder(),
      acceptsMessages: true,
      // Empty means every Connection with access here.
      ...scopedConnections(scopes, 'all'),
      instructions: INSTRUCTIONS,
    });
  }

  /** The agent has no Repo here; this folder holds what it writes while it answers. */
  private folder(): string {
    const dir = path.join(this.dataDir, 'devtools');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
}
