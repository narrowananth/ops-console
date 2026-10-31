import type { AccessLevel, ConnectionType } from '@ops-console/shared';

/** A Connection as the agent runtime sees it, found by the name of the MCP server that backs it. */
export type ConnectionInfo = { id: string; name: string; type: ConnectionType; access: AccessLevel; isProd: boolean };

/** Lets the runtime tie an MCP tool call to its Connection. Until a spec supplies the source it finds none. */
export class ConnectionLookup {
  private source: (server: string) => ConnectionInfo | null = () => null;

  use(source: (server: string) => ConnectionInfo | null): void {
    this.source = source;
  }

  find(server: string): ConnectionInfo | null {
    return this.source(server);
  }
}
