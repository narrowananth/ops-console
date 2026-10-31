import { Inject, Injectable } from '@nestjs/common';
import { AccessLevel, ConnectionEnv } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { mcpTool } from '../action-log/classify';
import { ConnectionLookup } from '../agent/connection-lookup';
import { ProdWriteRule } from '../agent/prod-write-rule';
import { connections } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { isWrite } from './write-classifier';

/**
 * Ties the agent runtime to the Connections: finds the Connection behind an MCP server, and holds a write on a PROD
 * Connection with Access Level `write` for an Approval. A `read` Connection's server is launched read-only and
 * refuses the write itself, so there is nothing to approve.
 */
@Injectable()
export class ConnectionGuard {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(ConnectionLookup) lookup: ConnectionLookup,
    @Inject(ProdWriteRule) rule: ProdWriteRule,
  ) {
    lookup.use((server) => this.find(server));
    rule.use(({ toolName, input }) => {
      const mcp = mcpTool(toolName);
      const connection = mcp ? this.find(mcp.server) : null;
      if (!mcp || !connection?.isProd || connection.access !== AccessLevel.Write) return null;
      return isWrite(connection.type, mcp.tool, input)
        ? { summary: `PROD write on ${connection.name}: ${mcp.tool}` }
        : null;
    });
  }

  find(server: string) {
    const row = this.store.db.select().from(connections).where(eq(connections.name, server)).get();
    return row
      ? { id: row.id, name: row.name, type: row.type, access: row.access, isProd: row.env === ConnectionEnv.Prod }
      : null;
  }
}
