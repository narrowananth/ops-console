import { Inject, Injectable } from '@nestjs/common';
import { ConnectorId, HealthStatus } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import type { NewRelicQuery } from '../agent/new-relic-tool';
import { AgentRuntime } from '../agent/runtime';
import { ConnectorsService } from '../connectors/connectors.service';
import { HostedAuthError, readFailure } from '../connectors/hosted-mcp';
import { HostedServers } from '../connectors/hosted-servers';
import { connectors } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { newRelicLogsConfig } from './log-source-config';

/**
 * The agent's way into New Relic when logs are read with a User API key: the key stays in the daemon, which runs the
 * agent's NRQL for the Connector's account and Region, and hands back rows.
 */
@Injectable()
export class NewRelicAgentQuery implements NewRelicQuery {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(HostedServers) private readonly hosted: HostedServers,
    @Inject(ConnectorsService) private readonly connectorsService: ConnectorsService,
    @Inject(AgentRuntime) runtime: AgentRuntime,
  ) {
    runtime.setNewRelicQuery(this);
  }

  offers(): boolean {
    const row = this.store.db.select().from(connectors).where(eq(connectors.id, ConnectorId.NewRelicLogs)).get();
    return row?.status === HealthStatus.Ok && newRelicLogsConfig(this.store.db).route === 'key';
  }

  async rows(nrql: string): Promise<Record<string, unknown>[]> {
    const { account_id: accountId, region } = newRelicLogsConfig(this.store.db);
    try {
      return await this.hosted.newRelic('key', region)((api) => api.nrql(accountId, nrql));
    } catch (error) {
      if (error instanceof HostedAuthError) this.connectorsService.needsSignIn(ConnectorId.NewRelicLogs);
      throw readFailure(error, 'New Relic logs');
    }
  }
}
