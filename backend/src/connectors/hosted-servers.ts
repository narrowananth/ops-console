import { Inject, Injectable } from '@nestjs/common';
import { CONNECTOR_SERVERS, ConnectorId } from '@ops-console/shared';
import { McpServersService } from '../mcp/mcp-servers.service';
import { CLAUDE_CREDENTIALS, type ClaudeCredentials } from './claude-credentials';
import { GRAFANA_AUTH, type GrafanaAuth } from './grafana-auth';
import { type HostedOpen, hostedMcp } from './hosted-mcp';
import { NEW_RELIC_SERVER, type NewRelicHosts, NewRelicMcp, type NewRelicRegion } from './new-relic-mcp';

export const HOSTED_HOSTS = Symbol('HOSTED_HOSTS');

/** Where the hosted servers are, when not at the addresses their vendors document. Tests point them at stand-ins. */
export type HostedHosts = { grafana?: string; newRelic?: NewRelicHosts };

/** Sessions with the hosted servers the log Connectors read, each signed in the way its server allows. */
@Injectable()
export class HostedServers {
  private readonly newRelicMcp: NewRelicMcp;

  constructor(
    @Inject(GRAFANA_AUTH) private readonly grafanaAuth: GrafanaAuth,
    @Inject(CLAUDE_CREDENTIALS) credentials: ClaudeCredentials,
    @Inject(McpServersService) mcp: McpServersService,
    @Inject(HOSTED_HOSTS) private readonly hosts: HostedHosts,
  ) {
    this.newRelicMcp = new NewRelicMcp(
      credentials,
      // Claude Code reconnects the one server and refreshes its token as it does; no model turn.
      async () => {
        await mcp.checkOne(NEW_RELIC_SERVER);
      },
      hosts.newRelic,
    );
  }

  /** Grafana Cloud, with the console's own sign-in. The MCP SDK refreshes the token and keeps it in the Keychain. */
  grafana(): HostedOpen {
    const url = this.hosts.grafana ?? (CONNECTOR_SERVERS[ConnectorId.LokiLogs] as { target: string }).target;
    return hostedMcp(url, { provider: this.grafanaAuth.provider() });
  }

  newRelic(region: NewRelicRegion): HostedOpen {
    return this.newRelicMcp.open(region);
  }

  /** Grafana's sign-in, for Connect. */
  get grafanaSignIn(): GrafanaAuth {
    return this.grafanaAuth;
  }
}
