import { type DynamicModule, Module } from '@nestjs/common';
import { ConnectorId } from '@ops-console/shared';
import { ConnectorsService } from '../connectors/connectors.service';
import { HostedServers } from '../connectors/hosted-servers';
import { STORE, type Store } from '../db/store';
import { AlertSessions } from './alert-sessions';
import { AlertsService } from './alerts.service';
import { CloudWatchLogs, type CloudWatchOptions } from './cloudwatch-logs';
import { CliCodeHosts, CODE_HOSTS, CodeFinder, type CodeHosts } from './code-finder';
import { PupDatadog } from './datadog';
import { FixesService } from './fixes.service';
import { LOG_READERS, type LogReader, type LogReaders } from './log-reader';
import { cloudWatchLogsConfig, lokiLogsConfig, newRelicLogsConfig, otelLogsConfig } from './log-source-config';
import { LokiLogs } from './loki-logs';
import { MonitorController } from './monitor.controller';
import { NewRelicAgentQuery } from './new-relic-agent-query';
import { NewRelicLogs } from './new-relic-logs';
import { OtelLogFolder } from './otel-logs';
import { MonitorRetention } from './retention';
import { ReviewsService } from './reviews.service';
import { ScansService } from './scans.service';
import { ServicesService } from './services.service';
import { VerificationsService } from './verifications.service';

/** Monitor: Scans of the log sources (Datadog, a Log folder, CloudWatch logs, Loki, New Relic), Alerts, Verification, Review and Fix (ADR 0002). */
@Module({})
export class MonitorModule {
  static forRoot(
    config: {
      datadog?: LogReader;
      codeHosts?: CodeHosts;
      /** Bytes a Scan reads from the Log folder at most. */
      otelReadLimit?: number;
      /** How the CloudWatch source calls the `aws` CLI. */
      cloudWatch?: CloudWatchOptions;
    } = {},
  ): DynamicModule {
    return {
      module: MonitorModule,
      global: true,
      controllers: [MonitorController],
      providers: [
        {
          provide: LOG_READERS,
          inject: [STORE, HostedServers, ConnectorsService],
          useFactory: (store: Store, hosted: HostedServers, connectors: ConnectorsService): LogReaders => ({
            [ConnectorId.Datadog]: config.datadog ?? new PupDatadog(),
            [ConnectorId.OtelLogs]: new OtelLogFolder(() => otelLogsConfig(store.db).folder, config.otelReadLimit),
            [ConnectorId.CloudWatchLogs]: new CloudWatchLogs(() => {
              const { profile, region, log_groups } = cloudWatchLogsConfig(store.db);
              return { profile, region, log_groups };
            }, config.cloudWatch),
            [ConnectorId.LokiLogs]: new LokiLogs(
              () => lokiLogsConfig(store.db).datasource_uid,
              hosted.grafana(),
              () => connectors.needsSignIn(ConnectorId.LokiLogs),
            ),
            [ConnectorId.NewRelicLogs]: new NewRelicLogs(
              () => {
                const { account_id, region, route } = newRelicLogsConfig(store.db);
                return { accountId: account_id, region, route };
              },
              (route, region) => hosted.newRelic(route, region),
              () => connectors.needsSignIn(ConnectorId.NewRelicLogs),
            ),
          }),
        },
        { provide: CODE_HOSTS, useValue: config.codeHosts ?? new CliCodeHosts() },
        CodeFinder,
        NewRelicAgentQuery,
        MonitorRetention,
        AlertsService,
        ServicesService,
        AlertSessions,
        ScansService,
        VerificationsService,
        FixesService,
        ReviewsService,
      ],
      exports: [ScansService, AlertsService, FixesService, ReviewsService],
    };
  }
}
