import { Inject, Injectable } from '@nestjs/common';
import { CONNECTOR_SERVERS, ConnectorId, type NewRelicRoute } from '@ops-console/shared';
import { KEYCHAIN, type Keychain } from '../keychain/keychain';
import { McpServersService } from '../mcp/mcp-servers.service';
import { CLAUDE_CREDENTIALS, type ClaudeCredentials } from './claude-credentials';
import { GRAFANA_AUTH, type GrafanaAuth } from './grafana-auth';
import { type HostedOpen, hostedMcp } from './hosted-mcp';
import { NEW_RELIC_KEY, NewRelicApi } from './new-relic-api';
import {
  NEW_RELIC_SERVER,
  type NewRelicAccount,
  type NewRelicHosts,
  NewRelicMcp,
  type NewRelicOpen,
  type NewRelicRegion,
} from './new-relic-mcp';

export const HOSTED_HOSTS = Symbol('HOSTED_HOSTS');

/** Where the hosted servers are, when not at the addresses their vendors document. Tests point them at stand-ins. */
export type HostedHosts = { grafana?: string; newRelic?: NewRelicHosts; newRelicApi?: NewRelicHosts };

/** Sessions with the hosted servers the log Connectors read, each signed in the way its server allows. */
@Injectable()
export class HostedServers {
  private readonly newRelicMcp: NewRelicMcp;
  private readonly newRelicApi: NewRelicApi;

  constructor(
    @Inject(GRAFANA_AUTH) private readonly grafanaAuth: GrafanaAuth,
    @Inject(CLAUDE_CREDENTIALS) credentials: ClaudeCredentials,
    @Inject(McpServersService) mcp: McpServersService,
    @Inject(KEYCHAIN) keychain: Keychain,
    @Inject(HOSTED_HOSTS) private readonly hosts: HostedHosts,
  ) {
    this.newRelicApi = new NewRelicApi(() => keychain.get(NEW_RELIC_KEY), hosts.newRelicApi);
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

  /** New Relic by the route in use: Claude Code's MCP sign-in, or the User API key in the Keychain. */
  newRelic(route: NewRelicRoute, region: NewRelicRegion): NewRelicOpen {
    return route === 'key' ? this.newRelicApi.open(region) : this.newRelicMcp.queries(region);
  }

  /** The accounts a User API key not yet stored can read. */
  newRelicAccountsOf(region: NewRelicRegion, key: string): Promise<NewRelicAccount[]> {
    return this.newRelicApi.accountsOf(region, key);
  }

  /** Grafana's sign-in, for Connect. */
  get grafanaSignIn(): GrafanaAuth {
    return this.grafanaAuth;
  }
}
